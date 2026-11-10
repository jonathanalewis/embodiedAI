// Speech input ("the ears"), using Chrome's free Web Speech API.
//
// Listens continuously in ONE language at a time (that's a Web Speech
// limit). An utterance ends after a short pause. Chrome stops recognition
// on its own now and then, so this restarts it automatically and reports
// any real problem instead of going silent.
//
// To use a different microphone source later (e.g. Galbot's own mic),
// write another object with the same methods: listen(locale), pause().
//
//   const ears = createEars({ onInterim, onUtterance, onStatus });
//   ears.listen("es-US");   // start, or switch language
//   ears.pause();           // stop and throw away any half-heard words
//
// onStatus receives: "listening" | "hearing" | "paused" | "unsupported" |
//   "error:denied" | "error:mic" | "error:network" | "error:language" | "error:other"

import { TIMING } from "./config.js";

export function createEars({ onInterim, onUtterance, onStatus }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    onStatus("unsupported");
    return { supported: false, listen() {}, pause() {} };
  }

  let rec = null; // the current recognizer, if any
  let session = 0; // bumps on every (re)start; events from old sessions are ignored
  let wanted = false; // should we be listening right now?
  let locale = "en-US";
  let heard = ""; // words of the current utterance so far
  let lastChange = 0; // when those words last changed
  let firstHeardAt = 0; // when the first word of this utterance showed up
  let confidences = [];
  let commitTimer = null;
  let restartTimer = null;
  let startAskedAt = 0;
  let started = false;
  let quickFailures = 0;
  let blocked = false; // mic permission denied: stop trying until the page reloads

  function start() {
    clearTimeout(restartTimer);
    restartTimer = null;
    if (!wanted || rec || blocked) return;
    const id = ++session;
    const r = new SR();
    r.lang = locale;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    started = false;
    startAskedAt = performance.now();

    r.onstart = () => {
      if (id !== session) return;
      started = true;
      onStatus("listening");
    };
    r.onresult = (e) => {
      if (id !== session) return;
      quickFailures = 0;
      gotResult(e);
    };
    r.onerror = (e) => {
      if (id !== session) return;
      gotError(e.error);
    };
    r.onend = () => {
      if (id !== session) return;
      rec = null;
      if (heard.trim()) commit(); // Chrome stopped mid-utterance: keep what we have
      if (performance.now() - startAskedAt < 1500) quickFailures++;
      if (wanted) scheduleRestart();
    };

    rec = r;
    try {
      r.start();
    } catch (err) {
      console.warn("recognition start failed", err);
      rec = null;
      scheduleRestart();
    }
  }

  function stop() {
    if (!rec) return;
    session++; // ignore anything the old recognizer still sends
    try {
      rec.abort();
    } catch {}
    rec = null;
  }

  function scheduleRestart() {
    if (restartTimer || !wanted || blocked) return;
    // Back off if Chrome keeps failing straight away (e.g. no network).
    const delay = Math.min(TIMING.restartDelayMs * 2 ** quickFailures, 4000);
    restartTimer = setTimeout(start, delay);
  }

  function gotResult(e) {
    let text = "";
    let allFinal = true;
    const confs = [];
    for (let i = 0; i < e.results.length; i++) {
      const result = e.results[i];
      text += result[0].transcript;
      if (result.isFinal) confs.push(result[0].confidence);
      else allFinal = false;
    }
    text = text.replace(/\s+/g, " ").trim();
    confidences = confs;
    if (text && text !== heard) {
      if (!heard) firstHeardAt = performance.now();
      heard = text;
      lastChange = performance.now();
      onStatus("hearing");
      onInterim(heard);
    }
    if (!heard) return;
    // End of utterance: a pause, or Chrome saying the phrase is finished.
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, allFinal ? TIMING.finalGraceMs : TIMING.pauseMs);
  }

  function commit() {
    clearTimeout(commitTimer);
    const text = heard.trim();
    const spokeAt = lastChange;
    const valid = confidences.filter((c) => c > 0);
    const confidence = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : undefined;
    heard = "";
    confidences = [];
    if (!text) return;
    // Stop listening; the app restarts us (maybe in the other language).
    wanted = false;
    stop();
    onStatus("paused");
    onUtterance(text, { confidence, spokeAt, firstHeardAt, committedAt: performance.now(), lang: locale });
  }

  function gotError(error) {
    switch (error) {
      case "no-speech":
      case "aborted":
        return; // normal; onend restarts
      case "not-allowed":
      case "service-not-allowed":
        blocked = true;
        wanted = false;
        onStatus("error:denied");
        return;
      case "audio-capture":
        onStatus("error:mic");
        return;
      case "network":
        onStatus("error:network");
        return;
      case "language-not-supported":
        wanted = false;
        onStatus("error:language");
        return;
      default:
        console.warn("speech recognition error:", error);
        onStatus("error:other");
    }
  }

  // Safety net: if we should be listening but nothing is running (or a start
  // got stuck), start again.
  setInterval(() => {
    if (!wanted || blocked) return;
    if (!rec && !restartTimer) start();
    else if (rec && !started && performance.now() - startAskedAt > 5000) {
      stop();
      start();
    }
  }, 1500);

  return {
    supported: true,
    listen(newLocale) {
      if (blocked) {
        onStatus("error:denied");
        return;
      }
      const switching = newLocale !== locale;
      locale = newLocale;
      wanted = true;
      if (rec && switching) {
        heard = "";
        stop();
      }
      if (!rec) scheduleRestart();
    },
    // Throw away what's been heard so far and start a fresh recognizer
    // (same language). Used when the mic only picked up our own voice.
    restart() {
      if (!wanted) return;
      clearTimeout(commitTimer);
      heard = "";
      stop();
      scheduleRestart();
    },
    pause() {
      wanted = false;
      clearTimeout(commitTimer);
      clearTimeout(restartTimer);
      restartTimer = null;
      heard = "";
      stop();
      onStatus("paused");
    },
  };
}
