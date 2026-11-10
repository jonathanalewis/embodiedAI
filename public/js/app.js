// Galbot's conversation logic.
//
//   ears (listening)  ->  brain (Claude)  ->  stage (screen) + voice (speaker)
//
// Listening uses "ping-pong": after Person A speaks, Galbot listens for
// Person B's language, and vice versa. Tap a side's language button when
// someone speaks twice in a row.

import { LANGUAGES, findLanguage, CONTEXT_TURNS, TIMING } from "./config.js";
import { createStage } from "./stage.js";
import { createEars } from "./ears.js";
import { createVoice } from "./voice.js";
import { checkServer, runTurn, freeModeSupported, prepareFreeMode, runFreeTurn } from "./brain.js";
import { checkNumbers } from "./numbers.js";

const other = (side) => (side === "A" ? "B" : "A");
const $ = (sel) => document.querySelector(sel);
const stage = createStage();
const voice = createVoice();

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
  override: null, // side someone tapped while Galbot was busy
  spoken: [], // what Galbot said recently (to ignore its own echo)
};

const ears = createEars({
  onInterim: (text) => {
    if (!state.active) return;
    stage.interim(state.listenSide, text);
    if (state.pendingTurns === 0) stage.setOrb("hearing");
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
    notes.push("Can't reach the Galbot server. Open the Vercel URL and check the internet connection.");
  } else if (server && !server.hasKey) {
    notes.push(
      freeModeSupported()
        ? "No Claude API key is set up yet, so Galbot will run in free mode: basic translation only, using Chrome's built-in translator."
        : "No Claude API key is set up yet, and this browser has no built-in translator. Add the key in Vercel, or use desktop Chrome for free mode."
    );
  }
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    notes.push("This browser can't do speech recognition. Use Google Chrome on a computer; typing still works.");
  }
  for (const code of [$("#lang-A").value, $("#lang-B").value]) {
    const lang = findLanguage(code);
    if (voice.supported && !voice.hasVoiceFor(lang)) {
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
  state.listenSide = "A";

  // Wake up speech output while we still have the click (Chrome's autoplay rule).
  if (voice.supported) speechSynthesis.speak(new SpeechSynthesisUtterance(""));

  if (!state.server) state.server = await checkServer();
  state.free = !state.server.hasKey;
  if (state.free) {
    $("#start-note").textContent = "Preparing the free on-device translator…";
    const result = await prepareFreeMode(state.langs.A, state.langs.B);
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
  listenTo(state.listenSide);
}

function end() {
  state.active = false;
  ears.pause();
  voice.stopAll();
  $("#talk").hidden = true;
  $("#start").hidden = false;
  updateStartWarnings();
}

// ---------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------
function listenTo(side) {
  state.listenSide = side;
  stage.setListening(side, state.langs);
  if (!state.active) return;
  if (state.pendingTurns > 0 || voice.isSpeaking()) return; // resumes after the turn
  ears.listen(state.langs[side].speech);
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

  if (state.pendingTurns > 0 || voice.isSpeaking()) return; // the turn controls the orb
  if (status === "listening") stage.setOrb("listening");
  else if (status.startsWith("error") || status === "unsupported") stage.setOrb("off");
}

function heardUtterance(text, meta) {
  if (!state.active) return;
  const side = state.listenSide;
  const selfLine = stage.takeInterim(side);
  if (isEcho(text)) {
    selfLine?.remove();
    listenTo(side);
    return;
  }
  handleUtterance(side, text, { via: "voice", ...meta, endedAt: meta.spokeAt, selfLine });
}

// Did the mic just pick up Galbot's own voice?
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
      handleUtterance(side, text, { via: "typed" });
    });
    // "This person is about to speak": listen for their language now.
    root.querySelector(".side-lang").addEventListener("click", () => {
      stage.clearInterim(state.listenSide);
      if (state.pendingTurns > 0) state.override = side; // applies when the turn ends
      else ears.pause();
      listenTo(side);
    });
  }
  // Tap the orb to stop Galbot talking and go back to listening.
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
  ears.pause(); // never listen while Galbot is working or talking
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
  await voice.whenIdle();
  await new Promise((r) => setTimeout(r, TIMING.echoTailMs)); // let the room go quiet
  if (state.pendingTurns > 0 || !state.active) return;
  stage.setOrb("listening");
  listenTo(state.listenSide);
}

async function processTurn(side, text, meta) {
  const t0 = meta.endedAt ?? performance.now();
  const toSide = other(side);
  const selfLine = meta.selfLine ?? stage.line(side, "self");
  selfLine.set(text);
  const out = stage.line(toSide, "other");
  out.pending();
  stage.setOrb("translating");

  const turn = { who: side, text, translation: "" };
  let route = null;
  let firstTextAt = null;
  let speech = null; // the voice stream for this turn
  let repeatLine = null;
  let galbot = null; // { to, say, cap }
  let serverTiming = {};
  let nextSide = toSide; // ping-pong by default

  const onEvent = (ev) => {
    switch (ev.t) {
      case "route":
        route = ev.route;
        if (route === "translate") {
          speech = voice.stream({ lang: state.langs[toSide], style: "person" });
        } else if (route === "galbot") {
          out.remove();
          selfLine.el.classList.add("to-galbot");
          turn.toGalbot = true;
          stage.setOrb("thinking");
        } else if (route === "repeat") {
          // Probably the other person spoke out of turn: ask them, in their
          // language, to say it again, and listen for their language.
          out.remove();
          selfLine.dim("Galbot didn't catch this");
          repeatLine = stage.line(toSide, "galbot", { label: "Galbot" });
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
        }
        break;
      case "galbot_to":
        galbot = {
          to: ev.side,
          say: stage.line(ev.side, "galbot", { label: "Galbot" }),
          cap: stage.line(other(ev.side), "galbot", { label: "Galbot" }),
        };
        galbot.cap.pending();
        speech = voice.stream({ lang: state.langs[ev.side], style: "galbot" });
        nextSide = ev.side; // whoever Galbot spoke to will likely answer
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

  if (state.free) {
    await runFreeTurn({ text, from: state.langs[side], to: state.langs[toSide] }, onEvent);
  } else {
    await runTurn(
      {
        text,
        speaker: side,
        langs: { A: state.langs.A.name, B: state.langs.B.name },
        history: state.turns.slice(-CONTEXT_TURNS),
        instructions: state.instructions.map((i) => ({ id: i.id, text: i.text })),
        via: meta.via,
        confidence: meta.confidence,
      },
      onEvent
    );
  }
  speech?.end();

  // Remember what Galbot said aloud, so its own echo is ignored.
  rememberSpoken(turn.translation);
  if (repeatLine) rememberSpoken(repeatLine.text);
  if (galbot) rememberSpoken(galbot.say.text);

  // Number check: every number in the original must survive translation.
  if (route === "translate" && turn.translation.trim()) {
    const mismatch = checkNumbers(text, turn.translation);
    if (mismatch) {
      const detail = `${mismatch.missing.join(", ") || "—"} → ${mismatch.extra.join(", ") || "—"}`;
      const html = `⚠ numbers differ: ${escapeHtml(detail)}`;
      out.addMeta(html, "warn");
      selfLine.addMeta(html, "warn");
    }
  }
  if (out.el.isConnected && !out.text.trim() && !out.el.querySelector(".warn")) out.remove();

  // Latency readout, measured from the speaker's last word (or the Enter key).
  const target = route === "translate" ? out : galbot?.say || repeatLine;
  if (target && firstTextAt) {
    const caption = (firstTextAt - t0) / 1000;
    const item = target.addMeta(`${caption.toFixed(1)}s text`, "latency");
    item.title = `From the end of speech to first words on screen. Server timing (ms): ${JSON.stringify(serverTiming)}`;
    speech?.started.then((at) => {
      if (at) item.textContent = `${caption.toFixed(1)}s text · ${((at - t0) / 1000).toFixed(1)}s voice`;
    });
  }

  if (route === "translate" || route === "galbot") state.turns.push(turn);
  if (galbot?.say.text.trim()) state.turns.push({ who: "G", to: galbot.to, text: galbot.say.text.trim() });
  state.listenSide = state.override ?? nextSide;
  state.override = null;
  stage.setListening(state.listenSide, state.langs);
  if (!voice.isSpeaking()) stage.setOrb("idle");
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
setupStartScreen();
setupControls();
