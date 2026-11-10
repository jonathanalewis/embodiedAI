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

// Must be called from a click (Chrome needs a user gesture to download packs).
export async function prepareFreeMode(langA, langB) {
  if (!freeModeSupported()) return { ok: false, reason: "This browser has no built-in translator. Use desktop Chrome." };
  const problems = [];
  for (const [from, to] of [[langA, langB], [langB, langA]]) {
    const key = `${from.code}>${to.code}`;
    if (translators.has(key)) continue;
    try {
      const availability = await self.Translator.availability({ sourceLanguage: from.code, targetLanguage: to.code });
      if (availability === "unavailable") {
        problems.push(`${from.name} → ${to.name} isn't available offline`);
        continue;
      }
      translators.set(key, self.Translator.create({ sourceLanguage: from.code, targetLanguage: to.code }));
    } catch (err) {
      problems.push(`${from.name} → ${to.name}: ${err.message}`);
    }
  }
  return { ok: problems.length === 0, reason: problems.join("; ") };
}

export async function runFreeTurn({ text, from, to }, onEvent) {
  const started = performance.now();
  const translator = translators.get(`${from.code}>${to.code}`);
  if (!translator) {
    onEvent({ t: "error", message: `Free mode can't translate ${from.name} to ${to.name} on this computer.` });
    onEvent({ t: "done", timing: {} });
    return;
  }
  try {
    const result = await (await translator).translate(text);
    onEvent({ t: "route", route: "translate" });
    onEvent({ t: "text", text: result });
  } catch (err) {
    onEvent({ t: "error", message: `Free translator failed: ${err.message}` });
  }
  onEvent({ t: "done", timing: { total: Math.round(performance.now() - started) } });
}
