// The "brain": sends one utterance to /api/turn and hands back events as
// they stream in. If no Claude API key is set up, it falls back to Chrome's
// free on-device translator (basic translation only).
//
// Events (one object each):
//   { t: "route", route }          translate | galbot | repeat | noise
//   { t: "text", text }            a chunk of translation (or repeat request)
//   { t: "galbot_to", side }       Galbot is speaking to side A or B
//   { t: "say", text }             a chunk of Galbot's spoken reply
//   { t: "caption", text }         a chunk of Galbot's reply for the other side
//   { t: "instruction", ... }      add / remove a standing instruction
//   { t: "status", state }         e.g. "searching"
//   { t: "source", url, title }    where a look-up answer came from
//   { t: "error", message }
//   { t: "done", timing }

export async function checkServer() {
  try {
    const res = await fetch("/api/turn", { method: "GET", cache: "no-store" });
    if (!res.ok) return { reachable: false, hasKey: false };
    const data = await res.json();
    return { reachable: true, hasKey: Boolean(data.hasKey) };
  } catch {
    return { reachable: false, hasKey: false };
  }
}

export async function runTurn(payload, onEvent, signal) {
  let res;
  try {
    res = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") return;
    onEvent({ t: "error", message: "Can't reach the Galbot server. Check the internet connection." });
    onEvent({ t: "done", timing: {} });
    return;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    onEvent({ t: "error", message: data.error === "no_key" ? "no_key" : data.error || `Server error ${res.status}` });
    onEvent({ t: "done", timing: {} });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (err.name !== "AbortError") onEvent({ t: "error", message: "The connection dropped mid-answer." });
      onEvent({ t: "done", timing: {} });
      return;
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        /* ignore a malformed line */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Free mode: Chrome's built-in Translator (runs on this computer, no cost).
// Available in desktop Chrome 138+. Language packs download on first use.
// ---------------------------------------------------------------------------
const translators = new Map();

export function freeModeSupported() {
  return typeof self !== "undefined" && "Translator" in self;
}

// Start both translators. Call this straight from the Begin click: Chrome
// only lets a page download a language pack right after a click.
// A failed start is NOT remembered, so the next try starts fresh.
export async function prepareFreeMode(langA, langB) {
  if (!freeModeSupported()) return { ok: false, reason: "This browser has no built-in translator. Use desktop Chrome." };
  // Ask for both directions at once, while the click still counts.
  const attempts = [[langA, langB], [langB, langA]].map(([from, to]) =>
    getTranslator(from, to).then(
      () => null,
      (err) => `${from.name} → ${to.name}: ${describe(err)}`
    )
  );
  const problems = (await Promise.all(attempts)).filter(Boolean);
  return { ok: problems.length === 0, reason: problems.join("; ") };
}

function getTranslator(from, to) {
  const key = `${from.code}>${to.code}`;
  if (!translators.has(key)) {
    const made = self.Translator.create({ sourceLanguage: from.code, targetLanguage: to.code }).catch((err) => {
      translators.delete(key); // forget the failure so we can retry
      throw err;
    });
    translators.set(key, made);
  }
  return translators.get(key);
}

function describe(err) {
  if (err?.name === "NotAllowedError") return "Chrome needs a click to download the language pack. Press End, then Begin.";
  if (err?.name === "NotSupportedError") return "this language pair isn't offered by Chrome's built-in translator.";
  if (err?.name === "QuotaExceededError") return "the sentence was too long for the free translator.";
  return `${err?.name || "Error"}: ${err?.message || err}`;
}

export async function runFreeTurn({ text, from, to }, onEvent) {
  const started = performance.now();
  if (!freeModeSupported()) {
    onEvent({ t: "error", message: "This browser has no built-in translator. Use desktop Chrome." });
    onEvent({ t: "done", timing: {} });
    return;
  }
  // Try twice: if the translator broke, the second try builds a fresh one.
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const translator = await getTranslator(from, to);
      const result = await translator.translate(text);
      onEvent({ t: "route", route: "translate" });
      onEvent({ t: "text", text: result });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      translators.delete(`${from.code}>${to.code}`);
    }
  }
  if (lastError) onEvent({ t: "error", message: `Free translator: ${describe(lastError)}` });
  onEvent({ t: "done", timing: { total: Math.round(performance.now() - started) } });
}

// Translate one piece of text with the free translator (null if it can't).
export async function freeTranslate(text, from, to) {
  if (!freeModeSupported() || from.code === to.code) return from.code === to.code ? text : null;
  try {
    return await (await getTranslator(from, to)).translate(text);
  } catch {
    return null;
  }
}
