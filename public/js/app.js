// The interpreter's conversation logic (the interpreter's name is in config.js).
//
//   ears (listening)  ->  brain (Claude)  ->  stage (screen) + voice (speaker)
//
// Chrome's recognizer listens for one language at a time, so we guess (the
// other person usually answers next) and the language detector (detector.js)
// checks what was really spoken and corrects the guess, both early in an
// utterance and at its end. If the detector can't run, tapping a side's
// language button says who is about to speak.
//
// Adding on: if the same person talks over the translation, the interpreter
// stops, listens, and re-translates the whole message. If they add more right
// after the translation, it is appended to the same lines.

import { LANGUAGES, findLanguage, CONTEXT_TURNS, TIMING, ASSISTANT } from "./config.js";
import { createStage } from "./stage.js";
import { createEars } from "./ears.js";
import { createVoice } from "./voice.js";
import { createDetector } from "./detector.js";
import { checkServer, runTurn, freeModeSupported, prepareFreeMode, runFreeTurn, freeTranslate } from "./brain.js";
import { freeAssistantRequest, wikipediaLookUp, nextSentences } from "./lookup.js";
import { checkNumbers } from "./numbers.js";

const NAME = ASSISTANT.name;
const other = (side) => (side === "A" ? "B" : "A");
const $ = (sel) => document.querySelector(sel);
const stage = createStage();
const voice = createVoice();
const detector = createDetector({ onStatus: detectorStatus });

const state = {
  active: false, // conversation screen is showing
  langs: { A: LANGUAGES[0], B: LANGUAGES[1] },
  turns: [], // conversation history, sent to Claude as context
  instructions: [], // active standing instructions (the chips)
  free: false, // true = no API key, use Chrome's free translator
  server: null, // { reachable, hasKey }
  listenSide: "A", // whose language we listen for next
  queue: Promise.resolve(), // utterances are handled one at a time
  pendingTurns: 0,
  override: null, // side someone tapped while the interpreter was busy
  spoken: [], // what the interpreter said recently (to ignore its own echo)
  wakeLock: null,
  micOpenAt: 0, // when listening last (re)started; audio before this may be our own voice
  utterance: null, // the utterance being heard right now: { startAt, checked, switched, early, prefix, timer }
  pitches: { A: [], B: [] }, // each person's recent voice pitch (Hz), to match their voice
  lastLookUp: null, // free mode: the article last read from, for "tell me more"
  last: null, // the latest translated message { side, turn, selfLine, out, endedAt, abort } (for adding on)
  barge: null, // listening while a translation is spoken: { side, since, confirmed, at, checking, lastCheck }
};

const ears = createEars({
  onInterim: (text) => {
    if (!state.active) return;
    const b = state.barge;
    if (b && !b.confirmed) return bargeInCheck(text); // is that the person, or our own voice?
    if (b?.confirmed) {
      // Talking over the translation: show it as part of the same message.
      state.last?.selfLine.set(`${state.last.turn.text} ${text}`);
      return;
    }
    const u = state.utterance;
    // After a mid-sentence language switch, keep what was said before it.
    stage.interim(state.listenSide, u?.prefixText ? `${u.prefixText} ${text}` : text);
    if (state.pendingTurns === 0) stage.setOrb("hearing");
    if (u?.switched) waitForEndAfterSwitch(u); // still talking
    earlyLanguageCheck();
  },
  onUtterance: (text, meta) => heardUtterance(text, meta),
  onStatus: (status) => earsStatus(status),
});

// ---------------------------------------------------------------------------
// Start screen
// ---------------------------------------------------------------------------
function setupStartScreen() {
  const pickA = $("#lang-A");
  const pickB = $("#lang-B");
  for (const pick of [pickA, pickB]) {
    for (const lang of LANGUAGES) {
      const opt = document.createElement("option");
      opt.value = lang.code;
      opt.textContent = lang.native === lang.name ? lang.name : `${lang.native} · ${lang.name}`;
      pick.append(opt);
    }
    pick.addEventListener("change", updateStartWarnings);
  }
  const saved = loadLanguages();
  pickA.value = saved.A;
  pickB.value = saved.B;

  $("#swap").addEventListener("click", () => {
    [pickA.value, pickB.value] = [pickB.value, pickA.value];
    updateStartWarnings();
  });
  $("#begin").addEventListener("click", begin);
  voice.onVoicesChanged(updateStartWarnings);

  // Find out early whether the Claude API key is set up (also wakes the server).
  checkServer().then((server) => {
    state.server = server;
    updateStartWarnings();
  });
  updateStartWarnings();
}

function updateStartWarnings() {
  const notes = [];
  const server = state.server;
  if (server && !server.reachable) {
    notes.push("Can't reach the server. Open the Vercel URL and check the internet connection.");
  } else if (server && !server.hasKey) {
    notes.push(
      freeModeSupported()
        ? `No Claude API key is set up yet, so ${NAME} will run in free mode: basic translation and Wikipedia look-ups, using Chrome's built-in translator.`
        : "No Claude API key is set up yet, and this browser has no built-in translator. Add the key in Vercel, or use desktop Chrome for free mode."
    );
  }
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    notes.push("This browser can't do speech recognition. Use Google Chrome on a computer; typing still works.");
  }
  for (const code of [$("#lang-A").value, $("#lang-B").value]) {
    const lang = findLanguage(code);
    if (voice.supported && voice.ready() && !voice.hasVoiceFor(lang)) {
      notes.push(`This computer has no ${lang.name} voice, so ${lang.name} will be captions only.`);
    }
  }
  $("#start-note").textContent = notes.join(" ");
}

function loadLanguages() {
  try {
    const saved = JSON.parse(localStorage.getItem("galbot.langs") || "null");
    if (saved?.A && saved?.B) return saved;
  } catch {}
  return { A: "en", B: "es" };
}

function saveLanguages(a, b) {
  try {
    localStorage.setItem("galbot.langs", JSON.stringify({ A: a, B: b }));
  } catch {}
}

async function begin() {
  const a = $("#lang-A").value;
  const b = $("#lang-B").value;
  if (a === b) {
    $("#start-note").textContent = "Pick two different languages.";
    return;
  }
  saveLanguages(a, b);
  state.langs = { A: findLanguage(a), B: findLanguage(b) };
  state.turns = [];
  state.instructions = [];
  state.spoken = [];
  state.pitches = { A: [], B: [] };
  state.lastLookUp = null;
  state.last = null;
  state.barge = null;
  state.listenSide = "A";

  // Things Chrome only allows right after a click, so do them first:
  // wake up speech output, start the free translators, open the mic for the detector.
  if (voice.supported) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  const mightBeFree = !state.server?.hasKey && freeModeSupported();
  const freePrep = mightBeFree ? prepareFreeMode(state.langs.A, state.langs.B) : null;
  detector.start(); // loads in the background; everything works without it meanwhile

  if (!state.server?.reachable) state.server = await checkServer();
  state.free = !state.server.hasKey;
  if (state.free) {
    $("#start-note").textContent = "Preparing the free on-device translator…";
    const result = await (freePrep ?? prepareFreeMode(state.langs.A, state.langs.B));
    if (!result.ok) {
      $("#start-note").textContent = `Free mode problem: ${result.reason}`;
      if (!freeModeSupported()) return;
    }
  }

  stage.setLanguages(state.langs);
  stage.setChips([], removeInstruction);
  stage.notice("mode", state.free ? "Free mode · basic translation only" : "");
  for (const side of ["A", "B"]) {
    const lang = state.langs[side];
    stage.notice(`voice-${side}`, voice.supported && !voice.hasVoiceFor(lang) ? `No ${lang.name} voice on this computer: captions only.` : "");
  }
  $("#start").hidden = true;
  $("#talk").hidden = false;
  state.active = true;
  detectorStatus(detector.status, "");
  keepScreenAwake();
  listenTo(state.listenSide);
}

function end() {
  state.active = false;
  state.wakeLock?.release().catch(() => {});
  ears.pause();
  voice.stopAll();
  $("#talk").hidden = true;
  $("#start").hidden = false;
  updateStartWarnings();
}

// Stop the laptop dimming or sleeping mid-conversation.
async function keepScreenAwake() {
  try {
    state.wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (state.active && document.visibilityState === "visible") keepScreenAwake();
});

// Press F (outside a text box) for full screen, like presenting a slide.
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "f" || e.target.closest("input, select, textarea")) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

// ---------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------
function listenTo(side) {
  if (state.barge?.confirmed) return; // someone is talking over the translation; keep their language
  state.listenSide = side;
  stage.setListening(side, state.langs, detector.status === "ready");
  if (!state.active) return;
  if (state.pendingTurns > 0 || voice.isSpeaking()) return; // resumes after the turn
  if (!state.utterance) state.micOpenAt = performance.now();
  ears.listen(state.langs[side].speech);
}

// ---------------------------------------------------------------------------
// Automatic language detection
// ---------------------------------------------------------------------------
function detectorStatus(status, detail) {
  if (!state.active) return;
  const messages = {
    loading: `Setting up automatic language detection${detail ? ` (${detail})` : ""}… one-time download.`,
    failed: `Automatic language detection is off: ${detail}. ${NAME} will alternate languages; tap a language button when someone speaks twice in a row.`,
  };
  stage.notice("detector", messages[status] || "");
  stage.setListening(state.listenSide, state.langs, status === "ready");
}

const sideOf = (code) => (state.langs.A.code === code ? "A" : "B");
const codes = () => [state.langs.A.code, state.langs.B.code];

// Audio of the current utterance, from a little before the first word.
function utteranceClip(startAt, endAt) {
  return detector.clip(Math.max(startAt - 1200, state.micOpenAt), endAt);
}

// Shortly into speech: is Chrome listening for the right language? If not,
// switch now so the live captions are right. The words said before the
// switch are written down from the recorded audio and kept.
function earlyLanguageCheck() {
  if (detector.status !== "ready" || state.pendingTurns > 0) return;
  const now = performance.now();
  state.utterance ??= { startAt: now, checked: false, switched: false, timer: null };
  const u = state.utterance;
  if (u.checked || now - u.startAt < TIMING.earlyCheckMs) return;
  u.checked = true;
  const guessed = state.listenSide;
  detector
    .whichLanguage(utteranceClip(u.startAt, performance.now()), codes())
    .then((result) => {
      if (state.utterance !== u || state.pendingTurns > 0) return;
      const spoken = sideOf(result.code);
      u.early = { side: spoken, confidence: result.confidence };
      if (spoken === guessed || result.confidence < 0.85) return;
      // Wrong language: move to the other side and listen in that language.
      u.switched = true;
      stage.clearInterim(guessed);
      stage.interim(spoken, "…");
      state.listenSide = spoken;
      stage.setListening(spoken, state.langs, true);
      ears.listen(state.langs[spoken].speech); // keeps the mic on, new language
      waitForEndAfterSwitch(u);
    })
    .catch((err) => console.warn("early language check failed", err));
}

// After a switch, write down what was said before it (from the recording),
// so it stays on screen and is part of the final text.
function transcribeBeforeSwitch(u) {
  if (u.prefix) return;
  const side = state.listenSide;
  const endAt = performance.now();
  u.prefix = withTimeout(detector.transcribe(utteranceClip(u.startAt, endAt), state.langs[side].code), 6000)
    .then((text) => {
      u.prefixText = text;
      if (state.utterance === u && text) stage.interim(side, `${text} …`);
      return text;
    })
    .catch(() => null);
}

// After switching mid-utterance, Chrome may not hear anything more (the
// person may already be done). If so, finish the utterance ourselves.
function waitForEndAfterSwitch(u) {
  clearTimeout(u.timer);
  u.timer = setTimeout(() => {
    if (state.utterance !== u) return;
    ears.pause();
    stage.clearInterim(state.listenSide);
    state.utterance = null;
    handleUtterance(state.listenSide, "", { via: "voice", firstHeardAt: u.startAt, committedAt: performance.now() - 2500, switched: true, prefix: u.prefix });
  }, TIMING.pauseMs + 2500);
}

// At the end of an utterance: who really spoke, and what exactly did they say?
async function confirmSpeaker(side, text, meta) {
  if (detector.status !== "ready" || !meta.firstHeardAt) return { side, text };
  const started = performance.now();
  const ms = () => performance.now() - started;
  try {
    // Someone talked over a translation. If we weren't sure yet, check that
    // it was really them (not our own voice), then write down their words.
    if (meta.bargeIn || meta.bargeCandidate) {
      const clip = detector.clip(meta.firstHeardAt, meta.committedAt);
      if (meta.bargeCandidate) {
        const r = await withTimeout(detector.whichLanguage(clip, [state.langs[side].code, state.langs[other(side)].code]), 3000);
        if (r.code !== state.langs[side].code || r.confidence < 0.8) return { discard: true };
      }
      const words = await withTimeout(detector.transcribe(clip, state.langs[side].code), 8000).catch(() => "");
      if (meta.bargeCandidate && meta.interrupted) voice.stopAll(); // it was them, talking over us
      return { side, text: words || text, detectMs: ms(), redone: Boolean(words), interrupted: Boolean(meta.interrupted) };
    }
    // We switched language mid-sentence: before-the-switch + after-the-switch.
    if (meta.switched) {
      const before = meta.prefix ? await meta.prefix : null;
      if (before && text.trim()) return { side, text: joinWithoutOverlap(before, text), detectMs: ms(), redone: true };
      const redone = await withTimeout(detector.transcribe(utteranceClip(meta.firstHeardAt, meta.committedAt), state.langs[side].code), 10000);
      return { side, text: redone || before || text, detectMs: ms(), redone: true };
    }
    // The early check already agreed with Chrome: no need to check again (faster).
    if (meta.early && meta.early.side === side && meta.early.confidence >= 0.9) return { side, text, detectMs: 0 };
    const clip = utteranceClip(meta.firstHeardAt, meta.committedAt);
    const seconds = clip.length / 16000;
    if (seconds < 0.6) return { side, text }; // too short to judge
    const result = await withTimeout(detector.whichLanguage(clip, codes()), 3000);
    const spoken = sideOf(result.code);
    // Short clips are easy to misjudge, so ask for more certainty.
    const sure = result.confidence >= (seconds < 1.5 ? 0.9 : 0.75);
    if (spoken === side || !sure) return { side, text, detectMs: ms() };
    // Chrome listened for the wrong language: write it down again in the right one.
    const redone = await withTimeout(detector.transcribe(clip, state.langs[spoken].code), 10000);
    return { side: spoken, text: redone || text, detectMs: ms(), redone: true };
  } catch (err) {
    console.warn("language check failed; using Chrome's guess", err);
    return { side, text };
  }
}

// Join the words heard before and after a language switch. The two pieces can
// overlap by a few words around the switch, so drop any repeated words.
function joinWithoutOverlap(before, after) {
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const a = before.trim().split(/\s+/);
  const b = after.trim().split(/\s+/);
  const bNorm = b.map(norm).join(" ");
  if (a.map(norm).join(" ").includes(bNorm)) return before.trim(); // after-part already covered
  for (let k = Math.min(8, a.length, b.length); k > 0; k--) {
    if (a.slice(-k).map(norm).join(" ") === b.slice(0, k).map(norm).join(" ")) return [...a, ...b.slice(k)].join(" ");
  }
  return `${before.trim()} ${after.trim()}`;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

// ---------------------------------------------------------------------------
// Talking over a translation ("barge-in")
// While a translation is spoken in the other person's language, keep
// listening for the speaker's language. If the sound really is them (not our
// own voice coming out of the speakers), stop talking and listen.
// ---------------------------------------------------------------------------
function armBargeIn(side) {
  if (!TIMING.bargeIn || detector.status !== "ready" || !state.active) return;
  state.barge = { side, since: performance.now(), confirmed: false, at: 0, checking: false, lastCheck: 0 };
  state.micOpenAt = performance.now();
  ears.listen(state.langs[side].speech);
}

function bargeInCheck(text) {
  const b = state.barge;
  const now = performance.now();
  if (b.checking || now - b.lastCheck < 600 || now - b.since < 500) return;
  b.checking = true;
  b.lastCheck = now;
  const from = Math.max(now - 1500, b.since);
  const mine = state.langs[b.side].code;
  const theirs = state.langs[other(b.side)].code;
  detector
    .whichLanguage(detector.clip(from, now), [mine, theirs])
    .then((r) => {
      b.checking = false;
      if (state.barge !== b || b.confirmed) return;
      if (r.code === mine && r.confidence >= 0.85 && !isEcho(text)) {
        // It's the speaker. If the translation is still playing, stop it and
        // listen; if it just finished, this is simply them adding more.
        b.confirmed = true;
        b.at = from;
        b.afterSpeech = !voice.isSpeaking();
        if (!b.afterSpeech) {
          voice.stopAll();
          state.last?.abort?.();
        }
        state.override = b.side;
        state.listenSide = b.side;
        state.last?.selfLine.set(`${state.last.turn.text} …`);
        stage.setOrb("hearing");
      } else if (r.code === theirs) {
        ears.restart(); // that was our own voice: throw it away and keep listening
      }
    })
    .catch(() => (b.checking = false));
}

// Is this utterance the same person adding to their last message?
function continuationFor(side, meta) {
  const last = state.last;
  if (!last || last.side !== side || !last.out.el.isConnected) return null;
  if (meta.interrupted) return last;
  if (meta.via !== "voice" || !meta.firstHeardAt) return null;
  return meta.firstHeardAt - last.endedAt < TIMING.addOnWindowMs ? last : null;
}

function earsStatus(status) {
  if (!state.active) return;
  const messages = {
    "error:denied": "Microphone is blocked. Click the icon at the left of the address bar, allow the microphone, then press End and Begin again. Typing still works.",
    "error:mic": "No microphone found. Check that one is connected and selected in your computer's settings.",
    "error:network": "Speech recognition can't reach the internet. Retrying…",
    "error:language": `Chrome can't recognize ${state.langs[state.listenSide].name} speech on this computer. Please type instead.`,
    unsupported: "This browser can't do speech recognition. Use Google Chrome; typing still works.",
  };
  if (status === "listening" || status === "hearing") stage.notice("mic", "");
  else if (messages[status]) stage.notice("mic", messages[status]);
  // The recognizer restarted in the new language after a mid-sentence switch.
  if (status === "listening" && state.utterance?.switched) transcribeBeforeSwitch(state.utterance);

  if (state.pendingTurns > 0 || voice.isSpeaking()) return; // the turn controls the orb
  if (status === "listening") stage.setOrb("listening");
  else if (status.startsWith("error") || status === "unsupported") stage.setOrb("off");
}

function heardUtterance(text, meta) {
  const u = forgetUtterance();
  const b = state.barge;
  state.barge = null;
  if (!state.active) return;
  if (b) {
    // Heard while a translation was being spoken.
    if (isEcho(text)) {
      if (voice.isSpeaking()) armBargeIn(b.side); // our own voice; keep listening
      return;
    }
    handleUtterance(b.side, text, {
      via: "voice",
      ...meta,
      firstHeardAt: b.confirmed ? b.at : Math.max(meta.committedAt - 4000, b.since),
      bargeIn: b.confirmed,
      bargeCandidate: !b.confirmed,
      interrupted: b.confirmed ? !b.afterSpeech : voice.isSpeaking(),
      endedAt: meta.spokeAt,
    });
    return;
  }
  const side = state.listenSide;
  const selfLine = stage.takeInterim(side);
  if (isEcho(text)) {
    selfLine?.remove();
    listenTo(side);
    return;
  }
  handleUtterance(side, text, {
    via: "voice",
    ...meta,
    firstHeardAt: u?.startAt ?? meta.firstHeardAt, // the real start, even if we switched language mid-way
    switched: Boolean(u?.switched),
    early: u?.early,
    prefix: u?.prefix,
    endedAt: meta.spokeAt,
    selfLine,
  });
}

// Stop tracking the utterance in progress (returns what we knew about it).
function forgetUtterance() {
  const u = state.utterance;
  if (u) clearTimeout(u.timer);
  state.utterance = null;
  return u;
}

// Did the mic just pick up our own voice?
function isEcho(heard) {
  const words = tokens(heard);
  if (words.length < 2) return false;
  const now = Date.now();
  return state.spoken.some((s) => {
    if (now - s.at > 20000) return false;
    const said = new Set(tokens(s.text));
    const hits = words.filter((w) => said.has(w)).length;
    return hits / words.length >= 0.7;
  });
}

function tokens(text) {
  const words = text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
  // Languages written without spaces: compare character by character.
  return words.flatMap((w) => (/[぀-ヿ㐀-鿿]/.test(w) ? [...w] : [w]));
}

function rememberSpoken(text) {
  if (!text.trim()) return;
  state.spoken.push({ text, at: Date.now() });
  if (state.spoken.length > 12) state.spoken.shift();
}

// ---------------------------------------------------------------------------
// Typing (backup for when the mic misbehaves) and manual side override
// ---------------------------------------------------------------------------
function setupControls() {
  for (const side of ["A", "B"]) {
    const root = $(`#side-${side}`);
    const form = root.querySelector(".type-box");
    const input = form.querySelector("input");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      stage.clearInterim(state.listenSide);
      forgetUtterance();
      handleUtterance(side, text, { via: "typed" });
    });
    // "This person is about to speak": listen for their language now.
    root.querySelector(".side-lang").addEventListener("click", () => {
      stage.clearInterim(state.listenSide);
      forgetUtterance();
      if (state.pendingTurns > 0) state.override = side; // applies when the turn ends
      else ears.pause();
      listenTo(side);
    });
  }
  // Tap the orb to stop the interpreter talking and go back to listening.
  $("#orb").addEventListener("click", () => {
    if (!state.active) return;
    voice.stopAll();
    if (state.pendingTurns === 0) listenTo(state.listenSide);
  });
  voice.onActivity((speaking) => {
    if (speaking && state.active) stage.setOrb("speaking");
  });
  $("#end").addEventListener("click", end);
}

// ---------------------------------------------------------------------------
// One utterance, start to finish
// ---------------------------------------------------------------------------
function handleUtterance(side, text, meta) {
  state.pendingTurns++;
  if (!meta.bargeIn && !meta.bargeCandidate) state.barge = null;
  ears.pause(); // don't listen while working (except to catch someone talking over a translation)
  state.queue = state.queue
    .then(() => processTurn(side, text, meta))
    .catch((err) => console.error(err))
    .finally(() => {
      state.pendingTurns--;
      if (state.pendingTurns === 0) resumeAfterTurn();
    });
  return state.queue;
}

async function resumeAfterTurn() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.race([voice.whenIdle(), sleep(60000)]); // never wait forever
  if (state.last && state.last.endedAt === Infinity) state.last.endedAt = performance.now();
  if (state.barge?.confirmed) return; // they're talking over us; their words are on the way
  await sleep(TIMING.echoTailMs); // let the room go quiet (still listening for an add-on)
  if (state.pendingTurns > 0 || !state.active || state.barge?.confirmed) return;
  state.barge = null;
  stage.setOrb("listening");
  listenTo(state.listenSide);
}

async function processTurn(side, text, meta) {
  const t0 = meta.endedAt ?? performance.now();
  let selfLine = meta.selfLine ?? null;
  let detected = {};
  if (meta.via === "voice") {
    // Check which language was really spoken, and fix the guess if needed.
    stage.setOrb("translating");
    detected = await confirmSpeaker(side, text, meta);
    if (detected.discard) {
      // Only our own voice. If we're still talking, keep listening for the person.
      if (state.last) state.last.selfLine.set(state.last.turn.text);
      if (voice.isSpeaking()) armBargeIn(side);
      return;
    }
    if (detected.side !== side) {
      selfLine?.remove();
      selfLine = null;
    }
    side = detected.side;
    text = detected.text;
  }
  if (!text.trim()) {
    selfLine?.remove();
    if (meta.bargeIn && state.last) state.last.selfLine.set(state.last.turn.text);
    return;
  }
  const toSide = other(side);
  if (meta.via === "voice") rememberPitch(side, meta);

  // Same person adding to what they just said? Talking over the translation
  // re-translates the whole message; adding right after appends to it.
  const cont = continuationFor(side, { ...meta, interrupted: meta.interrupted || detected.interrupted });
  const interrupted = Boolean(cont && (meta.interrupted || detected.interrupted));
  const sendText = interrupted ? `${cont.turn.text} ${text}` : text;

  selfLine ??= stage.line(side, "self");
  selfLine.set(text);
  if (detected.redone) selfLine.addMeta("↺ language detected by sound", "latency");
  let out = stage.line(toSide, "other");
  out.pending();
  stage.setOrb("translating");

  let turn = { who: side, text, translation: "" };
  let merged = false;
  let newTranslation = ""; // what this turn translated (and speaks)
  let route = null;
  let firstTextAt = null;
  let speech = null; // the voice stream for this turn
  let repeatLine = null;
  let galbot = null; // the interpreter speaking as itself: { to, say, cap }
  let serverTiming = {};
  let nextSide = toSide; // the other person usually answers next
  const controller = new AbortController(); // lets someone talking over us stop this turn

  // Put this turn's text into the previous message's lines instead of new ones.
  const mergeIntoPrevious = () => {
    merged = true;
    selfLine.remove();
    out.remove();
    ({ selfLine, out, turn } = cont);
    selfLine.clearMeta();
    out.clearMeta();
    turn.text = `${turn.text} ${text}`;
    selfLine.set(turn.text);
    if (interrupted) {
      turn.translation = "";
      out.set("");
      out.pending();
    } else {
      turn.translation += " ";
      out.append(" ");
    }
  };

  const onEvent = (ev) => {
    switch (ev.t) {
      case "route":
        route = ev.route;
        if (route === "translate") {
          if (cont) mergeIntoPrevious();
          state.last = { side, turn, selfLine, out, endedAt: Infinity, abort: () => controller.abort() };
          // Spoken in a voice a bit like the speaker's own (free voice matching).
          speech = voice.stream({ lang: state.langs[toSide], style: "person", pitchHz: personPitch(side) });
          armBargeIn(side);
        } else if (route === "galbot") {
          out.remove();
          selfLine.el.classList.add("to-galbot");
          turn.toGalbot = true;
          stage.setOrb("thinking");
        } else if (route === "repeat") {
          // Probably the other person spoke out of turn: ask them, in their
          // language, to say it again, and listen for their language.
          out.remove();
          selfLine.dim(`${NAME} didn't catch this`);
          repeatLine = stage.line(toSide, "galbot", { label: NAME });
          speech = voice.stream({ lang: state.langs[toSide], style: "galbot" });
          nextSide = toSide;
        } else if (route === "noise") {
          out.remove();
          selfLine.dim("Nothing to translate");
          nextSide = side;
        }
        break;
      case "text":
        firstTextAt ??= performance.now();
        speech?.push(ev.text);
        if (route === "repeat") repeatLine.append(ev.text);
        else {
          out.append(ev.text);
          turn.translation += ev.text;
          newTranslation += ev.text;
        }
        break;
      case "galbot_to":
        // Who the interpreter talks to: the asker, or (when asked to "tell
        // them...") the other person. The other one only gets a caption.
        galbot = {
          to: ev.side,
          say: stage.line(ev.side, "galbot", { label: NAME }),
          cap: stage.line(other(ev.side), "galbot", { label: NAME }),
        };
        galbot.cap.pending();
        speech = voice.stream({ lang: state.langs[ev.side], style: "galbot" });
        nextSide = ev.side; // whoever was spoken to will likely answer
        break;
      case "say":
        firstTextAt ??= performance.now();
        galbot?.say.append(ev.text);
        speech?.push(ev.text);
        break;
      case "caption":
        galbot?.cap.append(ev.text);
        break;
      case "status":
        if (ev.state === "searching") stage.setOrb("searching");
        break;
      case "source":
        galbot?.say.addSource(ev.url, ev.title);
        galbot?.cap.addSource(ev.url, ev.title);
        break;
      case "instruction":
        applyInstruction(ev);
        break;
      case "error":
        showError(ev.message, out);
        nextSide = side;
        break;
      case "done":
        serverTiming = ev.timing || {};
        break;
    }
  };

  try {
    if (state.free) {
      const ask = freeAssistantRequest(text); // "Hey Click, look up ___" without a Claude key
      if (ask?.bare) {
        selfLine.el.classList.add("to-galbot");
        out.remove();
        nextSide = side; // they said the name; their question is coming
      } else if (ask) await runFreeLookUp(side, ask, onEvent);
      else await runFreeTurn({ text: sendText, from: state.langs[side], to: state.langs[toSide] }, onEvent);
    } else {
      await runTurn(
        {
          text: sendText,
          speaker: side,
          langs: { A: state.langs.A.name, B: state.langs.B.name },
          // When re-translating a message, don't also send its old version.
          history: state.turns.filter((t) => !(interrupted && t === cont.turn)).slice(-CONTEXT_TURNS),
          instructions: state.instructions.map((i) => ({ id: i.id, text: i.text })),
          via: meta.via,
          confidence: meta.confidence,
        },
        onEvent,
        controller.signal
      );
    }
  } finally {
    speech?.end(); // always close the voice stream, or listening would never resume
  }

  // Remember what was said aloud, so our own echo is ignored.
  rememberSpoken(newTranslation);
  if (repeatLine) rememberSpoken(repeatLine.text);
  if (galbot) rememberSpoken(galbot.say.text);

  // Number check: every number in the original must survive translation.
  if (route === "translate" && newTranslation.trim()) {
    const mismatch = checkNumbers(interrupted ? turn.text : text, newTranslation);
    if (mismatch) {
      const detail = `${mismatch.missing.join(", ") || "—"} → ${mismatch.extra.join(", ") || "—"}`;
      const html = `⚠ numbers differ: ${escapeHtml(detail)}`;
      out.addMeta(html, "warn");
      selfLine.addMeta(html, "warn");
    }
  }
  if (out.el.isConnected && !out.text.trim() && !out.el.querySelector(".warn")) out.remove();
  if (merged) selfLine.addMeta(interrupted ? "＋ added on (re-translated)" : "＋ added on", "latency");

  // Latency readout, measured from the speaker's last word (or the Enter key).
  const target = route === "translate" ? out : galbot?.say || repeatLine;
  if (target && firstTextAt) {
    const caption = (firstTextAt - t0) / 1000;
    const check = detected.detectMs ? ` · lang ${(detected.detectMs / 1000).toFixed(1)}s` : "";
    const item = target.addMeta(`${caption.toFixed(1)}s text${check}`, "latency");
    item.title = `From the end of speech to first words on screen (including the language check). Server timing (ms): ${JSON.stringify(serverTiming)}`;
    speech?.started.then((at) => {
      if (at) item.textContent = `${caption.toFixed(1)}s text · ${((at - t0) / 1000).toFixed(1)}s voice${check}`;
    });
  }

  if ((route === "translate" && !merged) || route === "galbot") state.turns.push(turn);
  if (galbot?.say.text.trim()) state.turns.push({ who: "G", to: galbot.to, text: galbot.say.text.trim() });
  if (route !== "translate") state.last = null; // a later utterance can't add on to this
  state.listenSide = state.override ?? nextSide;
  state.override = null;
  stage.setListening(state.listenSide, state.langs, detector.status === "ready");
  if (!voice.isSpeaking()) stage.setOrb("idle");
}

// ---------------------------------------------------------------------------
// Free-mode look-ups (Wikipedia). The answer goes to the asker in their
// language, or, for "tell them ...", to the other person in theirs. The
// person not spoken to gets a caption, so nobody hears it twice.
// ---------------------------------------------------------------------------
async function runFreeLookUp(side, { topic, toOther }, onEvent) {
  const asker = state.langs[side];
  const otherLang = state.langs[other(side)];
  onEvent({ t: "route", route: "galbot" });
  onEvent({ t: "status", state: "searching" });
  let answer = null;
  const last = state.lastLookUp;
  if (!topic && last && last.lang === asker.code && last.next < last.article.sentences.length) {
    // "Tell me more": keep reading the article we just used.
    answer = nextSentences(last.article, last.next);
    last.next = answer.next;
  } else {
    // A new topic, or "that" = the last thing someone said.
    const said = [...state.turns].reverse().find((t) => (t.who === "A" || t.who === "B") && !t.toGalbot);
    const query = topic || (said ? (said.who === side ? said.text : said.translation) : "");
    try {
      const article = query ? await wikipediaLookUp(query, asker.code) : null;
      if (article) {
        answer = nextSentences(article, 0);
        state.lastLookUp = { article, next: answer.next, lang: asker.code };
      }
    } catch (err) {
      console.warn("look-up failed", err);
    }
    if (!answer) {
      onEvent({ t: "error", message: query ? `${NAME} couldn't find "${query}" on Wikipedia.` : `${NAME} didn't catch what to look up.` });
      onEvent({ t: "done", timing: {} });
      return;
    }
  }
  const { article } = state.lastLookUp;
  const translated = await freeTranslate(answer.text, asker, otherLang);
  if (toOther && translated) {
    // Speak to the other person in their language; the asker reads along.
    onEvent({ t: "galbot_to", side: other(side) });
    onEvent({ t: "say", text: translated });
    onEvent({ t: "caption", text: answer.text });
  } else {
    onEvent({ t: "galbot_to", side });
    onEvent({ t: "say", text: answer.text || "…" });
    if (translated) onEvent({ t: "caption", text: translated });
  }
  onEvent({ t: "source", url: article.url, title: article.title });
  onEvent({ t: "done", timing: {} });
}

// ---------------------------------------------------------------------------
// Free voice matching: remember how high or low each person's voice is
// ---------------------------------------------------------------------------
function rememberPitch(side, meta) {
  if (!detector.hasAudio || !meta.firstHeardAt) return;
  const hz = detector.pitch(utteranceClip(meta.firstHeardAt, meta.committedAt));
  if (!hz) return;
  state.pitches[side].push(hz);
  if (state.pitches[side].length > 6) state.pitches[side].shift();
}

function personPitch(side) {
  const list = [...state.pitches[side]].sort((a, b) => a - b);
  return list.length ? list[Math.floor(list.length / 2)] : null;
}

function showError(message, line) {
  const text = message === "no_key" ? "No Claude API key is set up on the server (see README)." : message;
  if (line?.el.isConnected) {
    line.set("");
    line.addMeta(`⚠ ${escapeHtml(text)}`, "warn");
  } else {
    stage.notice("error", text);
    setTimeout(() => stage.notice("error", ""), 8000);
  }
}

// ---------------------------------------------------------------------------
// Standing instructions (the chips under the orb)
// ---------------------------------------------------------------------------
function applyInstruction(ev) {
  if (ev.action === "set") {
    state.instructions.push({ id: crypto.randomUUID(), labels: ev.labels, text: ev.text, from: ev.from });
  } else if (ev.action === "clear") {
    state.instructions = state.instructions.filter((i) => i.id !== ev.id);
  } else if (ev.action === "clear_all") {
    state.instructions = [];
  }
  stage.setChips(state.instructions, removeInstruction);
}

function removeInstruction(id) {
  state.instructions = state.instructions.filter((i) => i.id !== id);
  stage.setChips(state.instructions, removeInstruction);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------------------
// The name on the title slide and browser tab comes from config.js.
$("#wordmark").textContent = NAME;
document.title = NAME;
setupStartScreen();
setupControls();
