// Automatic language detection: which of the two languages was just spoken?
//
// Chrome's speech recognition can only listen for one language at a time,
// so on its own it can't tell who is talking. This file records the last
// 30 seconds of microphone audio and runs a small speech model (OpenAI's
// Whisper, "base" size) INSIDE Chrome to decide which of the two chosen
// languages an utterance was in. Free, private (audio never leaves the
// laptop), but the model (~100 MB) downloads once per computer.
//
// If anything here fails (old browser, model can't download, mic blocked),
// Galbot keeps working the old way and shows a note saying why.
//
//   const detector = createDetector({ onStatus });
//   await detector.start();                       // from a click (needs the mic)
//   const clip = detector.clip(fromMs, toMs);     // performance.now() times
//   const { code, confidence } = await detector.whichLanguage(clip, ["en", "es"]);
//   const text = await detector.transcribe(clip, "es");

const LIBRARY = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
const MODEL_GPU = "onnx-community/whisper-base"; // laptops with WebGPU (most recent Chrome)
const MODEL_CPU = "Xenova/whisper-tiny"; // computers without WebGPU: smaller, faster model
const RATE = 16000; // Whisper wants 16 kHz audio
const KEEP_SECONDS = 30;

export function createDetector({ onStatus = () => {} } = {}) {
  let status = "off"; // off | loading | ready | failed
  let model = null;
  let processor = null;
  let tokenizer = null;
  let LogitsProcessor = null;
  let busy = Promise.resolve(); // one model call at a time

  // Ring buffer of recent mic audio.
  const ring = new Float32Array(RATE * KEEP_SECONDS);
  let written = 0; // total samples ever written
  let lastChunkAt = 0; // performance.now() when the newest sample arrived

  function setStatus(s, detail = "") {
    status = s;
    onStatus(s, detail);
  }

  async function startMicTap() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext({ sampleRate: RATE });
    await ctx.resume();
    // A tiny audio worklet that hands us every block of samples.
    const code = `class Tap extends AudioWorkletProcessor {
      process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
    } registerProcessor("galbot-tap", Tap);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    const tap = new AudioWorkletNode(ctx, "galbot-tap");
    const mute = ctx.createGain();
    mute.gain.value = 0; // keep the graph running without playing the mic back
    ctx.createMediaStreamSource(stream).connect(tap);
    tap.connect(mute).connect(ctx.destination);
    tap.port.onmessage = (e) => {
      const block = e.data;
      for (let i = 0; i < block.length; i++) ring[(written + i) % ring.length] = block[i];
      written += block.length;
      lastChunkAt = performance.now();
    };
  }

  async function loadModel() {
    const lib = await import(LIBRARY);
    LogitsProcessor = lib.LogitsProcessor;
    let gpu = false;
    try {
      gpu = Boolean(navigator.gpu && (await navigator.gpu.requestAdapter()));
    } catch {}
    const id = gpu ? MODEL_GPU : MODEL_CPU;
    const files = {};
    const progress_callback = (p) => {
      if (p.status !== "progress" || !p.total) return;
      files[p.file] = [p.loaded, p.total];
      const [done, total] = Object.values(files).reduce((a, [l, t]) => [a[0] + l, a[1] + t], [0, 0]);
      setStatus("loading", `${Math.round((100 * done) / total)}%`);
    };
    [model, processor, tokenizer] = await Promise.all([
      lib.WhisperForConditionalGeneration.from_pretrained(id, {
        device: gpu ? "webgpu" : "wasm",
        dtype: gpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
        progress_callback,
      }),
      lib.AutoProcessor.from_pretrained(id),
      lib.AutoTokenizer.from_pretrained(id),
    ]);
    // Warm up once so the first real utterance isn't slow.
    await languageScores(new Float32Array(RATE), ["en", "es"]);
  }

  // Scores for each candidate language (higher = more likely).
  async function languageScores(audio, codes) {
    const { input_features } = await processor(audio);
    const config = model.generation_config;
    const ids = codes.map((c) => config.lang_to_id[`<|${c}|>`]);
    if (ids.some((i) => i === undefined)) throw new Error(`unknown language in ${codes}`);
    let scores = null;
    // Look at the model's very first decision: which language token comes
    // after "start of transcript". Only our two languages are allowed.
    class PickLanguage extends LogitsProcessor {
      _call(input_ids, logits) {
        const d = logits.data;
        scores = ids.map((i) => d[i]);
        const keep = new Set(ids);
        for (let i = 0; i < d.length; i++) if (!keep.has(i)) d[i] = -Infinity;
        return logits;
      }
    }
    await model.generate({
      inputs: input_features,
      decoder_input_ids: [config.decoder_start_token_id],
      max_new_tokens: 1,
      logits_processor: [new PickLanguage()],
    });
    return scores;
  }

  // Run model calls one after another (the model can't do two at once).
  function queued(fn) {
    const run = busy.then(fn, fn);
    busy = run.catch(() => {});
    return run;
  }

  return {
    get status() {
      return status;
    },

    async start() {
      if (status === "loading" || status === "ready") return;
      if (!window.AudioWorkletNode || !navigator.mediaDevices?.getUserMedia) {
        setStatus("failed", "this browser can't record audio for it");
        return;
      }
      setStatus("loading", "");
      try {
        await startMicTap();
      } catch (err) {
        setStatus("failed", `microphone not available (${err.name})`);
        return;
      }
      try {
        await loadModel();
        setStatus("ready");
      } catch (err) {
        console.warn("language detector failed to load", err);
        setStatus("failed", "the speech model couldn't download (check the internet connection, then reload)");
      }
    },

    // Audio between two moments (performance.now() times), as 16 kHz samples.
    clip(fromMs, toMs) {
      const newest = written;
      const toIndex = Math.min(newest, newest - Math.round(((lastChunkAt - toMs) * RATE) / 1000));
      const fromIndex = Math.max(newest - ring.length, newest - Math.round(((lastChunkAt - fromMs) * RATE) / 1000), 0);
      const n = Math.max(0, toIndex - fromIndex);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = ring[(fromIndex + i) % ring.length];
      return out;
    },

    // True once the mic has recorded anything (works even if the model didn't load).
    get hasAudio() {
      return written > 0;
    },

    // How high or low someone's voice is: median pitch in Hz, or null.
    // Used to pick a built-in voice that sounds a bit like them.
    pitch(audio) {
      const frame = 1024;
      const minLag = Math.floor(RATE / 400); // highest voice we look for: 400 Hz
      const maxLag = Math.floor(RATE / 70); // lowest: 70 Hz
      const found = [];
      for (let start = 0; start + frame + maxLag < audio.length; start += frame) {
        let energy = 0;
        for (let i = start; i < start + frame; i++) energy += audio[i] * audio[i];
        if (energy / frame < 1e-4) continue; // silence
        const corr = new Float32Array(maxLag + 1);
        let best = 0;
        for (let lag = minLag; lag <= maxLag; lag++) {
          let sum = 0;
          for (let i = start; i < start + frame; i++) sum += audio[i] * audio[i + lag];
          corr[lag] = sum;
          if (sum > best) best = sum;
        }
        if (best / energy < 0.5) continue; // not clearly voiced
        // Take the first strong peak (the true pitch), not a later echo of it.
        let lag = minLag;
        while (lag < maxLag && !(corr[lag] >= 0.85 * best && corr[lag] >= corr[lag + 1])) lag++;
        found.push(RATE / lag);
      }
      if (found.length < 3) return null;
      found.sort((a, b) => a - b);
      return found[Math.floor(found.length / 2)];
    },

    // Which of `codes` was spoken? Returns { code, confidence 0..1, ms }.
    whichLanguage(audio, codes) {
      return queued(async () => {
        const started = performance.now();
        const scores = await languageScores(audio, codes);
        const max = Math.max(...scores);
        const exp = scores.map((s) => Math.exp(s - max));
        const sum = exp.reduce((a, b) => a + b, 0);
        const best = exp.indexOf(Math.max(...exp));
        return { code: codes[best], confidence: exp[best] / sum, ms: performance.now() - started };
      });
    },

    // Write down what was said, in a known language.
    transcribe(audio, code) {
      return queued(async () => {
        const { input_features } = await processor(audio);
        const ids = await model.generate({ inputs: input_features, language: code, task: "transcribe", max_new_tokens: 200 });
        return tokenizer.batch_decode(ids, { skip_special_tokens: true })[0].trim();
      });
    },
  };
}
