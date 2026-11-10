// Speech output ("the mouth").
//
// Today this uses the browser's free speechSynthesis. To add voice cloning
// later, write another object with the same methods (stream, stopAll,
// whenIdle, hasVoiceFor, onActivity) and swap it in app.js.
//
//   const s = voice.stream({ lang, style: "person" | "galbot" });
//   s.push("partial text as it arrives");   // speaks each sentence as soon as it's complete
//   s.end();                                 // speak whatever is left
//   await s.started;                         // time the first sound began (ms, performance.now)

import { VOICE } from "./config.js";

// Built-in voices don't say whether they sound male or female, so this is a
// list of known lower-pitched (male) voice names on Mac, Windows and Chrome.
// Anything not listed is treated as higher-pitched.
const LOWER_VOICES = /\b(Alex|Daniel|Aaron|Arthur|Gordon|Rishi|Reed|Rocko|Eddy|Grandpa|Jorge|Juan|Diego|Carlos|Thomas|Nicolas|Jacques|Yuri|Luca|Felipe|Majed|Maged|Tarik|Otoya|Hattori|Xander|Oliver|Lee|David|Mark|George|Guy|Pablo|Raul|Paul|Stefan|Pavel|Ravi|Naayf|Ichiro|Kangkang|Cosimo|Claude|Hemant|Andrew|Brian|Christopher|Eric|Roger|Alvaro|Henri|Conrad|Killian|Antonio|Dmitry|NamMinh|Keita|InJoon|Yunxi|Yunyang|Madhur|Hamed|Ostap|Angelo|Male)\b/i;

// Novelty voices that ship with macOS. Never pick these.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy|Deranged|Hysterical)\b/i;

export function createVoice() {
  const synth = window.speechSynthesis;
  const supported = Boolean(synth && window.SpeechSynthesisUtterance);
  let voices = [];
  let pending = 0; // utterances queued or playing
  let openStreams = 0; // streams that may still push text
  const alive = new Set(); // keep utterances referenced (Chrome bug: GC drops onend)
  let idleWaiters = [];
  let activityListener = () => {};
  let generation = 0; // bumps on stopAll(); older streams go quiet
  const voicesListeners = [];

  function loadVoices() {
    voices = supported ? synth.getVoices() : [];
    voicesListeners.forEach((fn) => fn());
  }
  if (supported) {
    loadVoices();
    synth.addEventListener?.("voiceschanged", loadVoices);
  }

  // All voices for a language, best first.
  function rankVoices(lang) {
    const want = lang.speech.toLowerCase();
    const prefixes = new Set([lang.code, want.split("-")[0]]);
    return voices
      .map((v) => {
        const vl = v.lang.toLowerCase().replace("_", "-");
        let score;
        if (vl === want) score = 4;
        else if (prefixes.has(vl.split("-")[0])) score = 2;
        else return null;
        if (/premium|enhanced|natural|neural/i.test(v.name)) score += 3;
        if (/google/i.test(v.name)) score += 2;
        if (NOVELTY.test(v.name)) score -= 6;
        if (v.default) score += 0.5;
        return { v, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.v);
  }

  // pitchHz = the speaker's own voice pitch (if known), to pick a voice like theirs.
  function pickVoice(lang, style, pitchHz) {
    const ranked = rankVoices(lang);
    if (!ranked.length) return null;
    // Galbot uses a different voice from the people when one is available.
    if (style === "galbot") return ranked.length > 1 ? ranked[1] : ranked[0];
    if (pitchHz) {
      const wantLower = pitchHz < VOICE.lowVoiceBelowHz;
      const match = ranked.find((v) => LOWER_VOICES.test(v.name) === wantLower);
      if (match) return match;
    }
    return ranked[0];
  }

  // Nudge the chosen voice up or down a little toward the speaker's pitch.
  function pitchFor(voiceObj, pitchHz) {
    if (!pitchHz) return 1;
    const voiceIsLower = LOWER_VOICES.test(voiceObj.name);
    const typical = voiceIsLower ? 120 : 210; // rough pitch of a typical voice of that kind
    const nudge = 1 + ((pitchHz - typical) / typical) * VOICE.matchStrength;
    return Math.min(1.25, Math.max(0.75, nudge));
  }

  function setActive() {
    const speaking = pending > 0;
    activityListener(speaking);
    if (!speaking && openStreams === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((fn) => fn());
    }
  }

  // Queue one chunk of speech. Returns false if it can't be spoken.
  function speakChunk(text, lang, style, onStart, pitchHz) {
    const voiceObj = pickVoice(lang, style, pitchHz);
    if (!supported || !voiceObj || !text.trim()) return false;
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voiceObj;
    u.lang = voiceObj.lang;
    u.rate = style === "galbot" ? VOICE.galbotRate : VOICE.personRate;
    u.pitch = style === "galbot" ? VOICE.galbotPitch : pitchFor(voiceObj, pitchHz);
    pending++;
    alive.add(u);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      alive.delete(u);
      pending = Math.max(0, pending - 1);
      setActive();
    };
    // Some voices never fire "end". Give up waiting after a generous time.
    const watchdog = setTimeout(finish, 4000 + text.length * 120);
    u.onstart = () => onStart?.(performance.now());
    u.onend = finish;
    u.onerror = finish;
    synth.resume(); // Chrome sometimes gets stuck paused
    synth.speak(u);
    setActive();
    return true;
  }

  // Find the end of the first complete sentence in `buf` (or -1).
  function sentenceEnd(buf, final) {
    // CJK and similar full stops need no space after them.
    let m = buf.match(/^[\s\S]*?[。！？](?=.)/);
    if (m) return m[0].length;
    const re = /[.!?؟।]+["'”’»)\]]*(\s+)/g;
    let match;
    while ((match = re.exec(buf))) {
      const end = match.index + match[0].length;
      const before = buf.slice(0, match.index + 1);
      // Don't split after short abbreviations like "Dr." or "e.g."
      if (/(\b[A-Z][a-z]{0,2}|\be\.g|\bi\.e|\betc)\.$/.test(before)) continue;
      return end;
    }
    if (/\n/.test(buf)) return buf.indexOf("\n") + 1;
    // A very long sentence: break at a comma so speech can start sooner.
    if (buf.length > 140) {
      const cut = buf.slice(0, 140).search(/[,，、;；:：]\s*(?=[^,，、;；:：]*$)/);
      if (cut > 40) return cut + 1;
    }
    return final ? buf.length : -1;
  }

  function stream({ lang, style = "person", pitchHz = null }) {
    let buf = "";
    let ended = false;
    let resolveStarted;
    const started = new Promise((r) => (resolveStarted = r));
    let firstStart = null;
    let spokeAny = false;
    const myGeneration = generation; // if stopAll() runs later, this stream goes quiet
    const onStart = (t) => {
      if (firstStart === null) {
        firstStart = t;
        resolveStarted(t);
      }
    };
    openStreams++;

    const flush = (final) => {
      let cut;
      while (buf && (cut = sentenceEnd(buf, final)) > 0) {
        const sentence = buf.slice(0, cut);
        buf = buf.slice(cut);
        if (speakChunk(sentence, lang, style, onStart, pitchHz)) spokeAny = true;
      }
    };

    return {
      started,
      push(text) {
        if (ended || myGeneration !== generation) return; // stopped by the user
        buf += text;
        flush(false);
      },
      end() {
        if (ended) return;
        ended = true;
        if (myGeneration === generation) flush(true);
        openStreams = Math.max(0, openStreams - 1);
        if (!spokeAny) resolveStarted(null); // nothing to say (or no voice)
        setActive();
      },
    };
  }

  return {
    supported,
    stream,
    hasVoiceFor: (lang) => supported && rankVoices(lang).length > 0,
    voiceName: (lang, style) => pickVoice(lang, style)?.name || null,
    onVoicesChanged: (fn) => voicesListeners.push(fn),
    onActivity: (fn) => (activityListener = fn),
    isSpeaking: () => pending > 0,
    ready: () => voices.length > 0, // Chrome loads its voice list a moment after the page
    // Resolves once nothing is playing and no stream is still open.
    whenIdle: () =>
      pending === 0 && openStreams === 0 ? Promise.resolve() : new Promise((r) => idleWaiters.push(r)),
    stopAll() {
      generation++;
      if (supported) synth.cancel();
      alive.clear();
      pending = 0;
      setActive();
    },
  };
}
