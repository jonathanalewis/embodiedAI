// Galbot's conversation logic: start screen, then each utterance goes
// brain -> stage (display). Listening and speaking plug in here too.

import { LANGUAGES, findLanguage, CONTEXT_TURNS } from "./config.js";
import { createStage } from "./stage.js";
import { checkServer, runTurn, freeModeSupported, prepareFreeMode, runFreeTurn } from "./brain.js";
import { checkNumbers } from "./numbers.js";

const other = (side) => (side === "A" ? "B" : "A");
const $ = (sel) => document.querySelector(sel);
const stage = createStage();

const state = {
  langs: { A: LANGUAGES[0], B: LANGUAGES[1] },
  turns: [], // conversation history, sent to Claude as context
  instructions: [], // active standing instructions (the chips)
  free: false, // true = no API key, use Chrome's free translator
  server: null, // { reachable, hasKey }
  queue: Promise.resolve(), // utterances are handled one at a time
};

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
  }
  const saved = loadLanguages();
  pickA.value = saved.A;
  pickB.value = saved.B;

  $("#swap").addEventListener("click", () => {
    [pickA.value, pickB.value] = [pickB.value, pickA.value];
  });
  $("#begin").addEventListener("click", begin);

  // Find out early whether the Claude API key is set up (also wakes the server).
  checkServer().then((server) => {
    state.server = server;
    if (!server.reachable) {
      setStartNote("Can't reach the Galbot server. Open the Vercel URL (not the file) and check the internet connection.");
    } else if (!server.hasKey) {
      setStartNote(
        freeModeSupported()
          ? "No Claude API key is set up yet, so Galbot will run in free mode: basic translation only, using Chrome's built-in translator."
          : "No Claude API key is set up yet, and this browser has no built-in translator. Add the key in Vercel, or use desktop Chrome for free mode."
      );
    }
  });
}

function setStartNote(text) {
  $("#start-note").textContent = text;
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
    setStartNote("Pick two different languages.");
    return;
  }
  saveLanguages(a, b);
  state.langs = { A: findLanguage(a), B: findLanguage(b) };
  state.turns = [];
  state.instructions = [];

  if (!state.server) state.server = await checkServer();
  state.free = !state.server.hasKey;
  if (state.free) {
    setStartNote("Preparing the free on-device translator…");
    const result = await prepareFreeMode(state.langs.A, state.langs.B);
    if (!result.ok) {
      setStartNote(`Free mode problem: ${result.reason}`);
      if (!freeModeSupported()) return;
    }
  }

  stage.setLanguages(state.langs);
  stage.setChips([], removeInstruction);
  stage.notice("mode", state.free ? "Free mode · basic translation only" : "");
  stage.setOrb("idle");
  $("#start").hidden = true;
  $("#talk").hidden = false;
}

function end() {
  $("#talk").hidden = true;
  $("#start").hidden = false;
  setStartNote("");
}

// ---------------------------------------------------------------------------
// Typing (backup for when the mic misbehaves)
// ---------------------------------------------------------------------------
function setupTyping() {
  for (const side of ["A", "B"]) {
    const form = document.querySelector(`#side-${side} .type-box`);
    const input = form.querySelector("input");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      handleUtterance(side, text, { via: "typed" });
    });
  }
}

// ---------------------------------------------------------------------------
// One utterance, start to finish
// ---------------------------------------------------------------------------
function handleUtterance(side, text, meta) {
  state.queue = state.queue.then(() => processTurn(side, text, meta)).catch((err) => console.error(err));
  return state.queue;
}

async function processTurn(side, text, meta) {
  const t0 = meta.endedAt ?? performance.now();
  const toSide = other(side);
  const selfLine = meta.selfLine ?? stage.line(side, "self");
  selfLine.set(text);
  let out = stage.line(toSide, "other");
  out.pending();
  stage.setOrb("translating");

  const turn = { who: side, text, translation: "" };
  let route = null;
  let firstTextAt = null;
  let repeatLine = null;
  let galbot = null; // { to, say, cap }
  let serverTiming = {};

  const onEvent = (ev) => {
    switch (ev.t) {
      case "route":
        route = ev.route;
        if (route === "galbot") {
          out.remove();
          selfLine.el.classList.add("to-galbot");
          turn.toGalbot = true;
          stage.setOrb("thinking");
        } else if (route === "repeat") {
          // Probably the other person spoke: ask them (in their language) to repeat.
          out.remove();
          selfLine.dim("Galbot didn't catch this");
          repeatLine = stage.line(toSide, "galbot", { label: "Galbot" });
          stage.setOrb("speaking");
        } else if (route === "noise") {
          out.remove();
          selfLine.dim("Nothing to translate");
        }
        break;
      case "text":
        firstTextAt ??= performance.now();
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
        stage.setOrb("speaking");
        break;
      case "say":
        firstTextAt ??= performance.now();
        galbot?.say.append(ev.text);
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

  // Wrap up: number check, latency readout, remember the turn.
  if (route === "translate" && turn.translation.trim()) {
    const mismatch = checkNumbers(text, turn.translation);
    if (mismatch) {
      const detail = `${mismatch.missing.join(", ") || "—"} → ${mismatch.extra.join(", ") || "—"}`;
      out.addMeta(`⚠ numbers ${escapeHtml(detail)}`, "warn");
      selfLine.addMeta(`⚠ numbers ${escapeHtml(detail)}`, "warn");
    }
  }
  if (out.el.isConnected && !out.text.trim()) out.remove();
  const target = route === "translate" ? out : galbot?.say;
  if (target && firstTextAt) {
    target.addMeta(`${((firstTextAt - t0) / 1000).toFixed(2)}s caption`, "latency");
  }
  console.debug("turn timing (server ms):", serverTiming);

  if (route === "translate" || route === "galbot") state.turns.push(turn);
  if (galbot?.say.text.trim()) state.turns.push({ who: "G", to: galbot.to, text: galbot.say.text.trim() });
  stage.setOrb("idle");
}

function showError(message, line) {
  const text =
    message === "no_key"
      ? "No Claude API key is set up on the server (see README)."
      : message;
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
    state.instructions.push({
      id: crypto.randomUUID(),
      labels: ev.labels,
      text: ev.text,
      from: ev.from,
    });
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
setupTyping();
$("#end").addEventListener("click", end);
