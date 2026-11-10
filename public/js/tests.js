// Test runner for public/test.html. Not part of the app.
// Each case sends one typed utterance through /api/turn and checks the events.

import { findLanguage } from "./config.js";
import { runTurn } from "./brain.js";
import { checkNumbers } from "./numbers.js";

// expect.route: translate | galbot | repeat | noise
// expect.numbers: digits must match   expect.question: output must stay a question
// expect.instruction: "set" | "clear" expect.sources: a look-up must show a source
// review: a person should read the output to confirm it is faithful
const CASES = [
  // --- Faithful translation -------------------------------------------------
  { group: "Faithful", title: "Apology, casual", langs: ["en", "es"], text: "I'm sorry I'm late, the bus never came and I had to walk the whole way.", expect: { route: "translate" }, review: true },
  { group: "Faithful", title: "Reassurance, polite", langs: ["es", "en"], text: "No se preocupe, todavía no hemos empezado. Siéntese donde quiera.", expect: { route: "translate" }, review: true },
  { group: "Faithful", title: "Frustration keeps its tone", langs: ["fr", "en"], text: "Franchement, je ne comprends pas pourquoi c'est si compliqué.", expect: { route: "translate" }, review: true },
  { group: "Faithful", title: "Thanks (Arabic, right-to-left)", langs: ["ar", "en"], text: "شكراً جزيلاً على مساعدتك، لقد كنت لطيفاً جداً.", expect: { route: "translate" }, review: true },
  { group: "Faithful", title: "Update about a child", langs: ["en", "ko"], text: "My son has been feeling much better since Tuesday, but he still coughs at night.", expect: { route: "translate" }, review: true },
  { group: "Faithful", title: "Polite confusion (Tagalog)", langs: ["tl", "en"], text: "Pasensya na po, hindi ko po naintindihan ang sinabi ninyo.", expect: { route: "translate" }, review: true },
  { group: "Faithful", title: "Newcomers (Ukrainian)", langs: ["uk", "en"], text: "Ми щойно переїхали сюди і ще нікого тут не знаємо.", expect: { route: "translate" }, review: true },

  // --- Numbers --------------------------------------------------------------
  { group: "Numbers", title: "Time, platform, price", langs: ["en", "es"], text: "The train leaves at 7:15 from platform 4, and a return ticket is $23.40.", expect: { route: "translate", numbers: true } },
  { group: "Numbers", title: "Decimal commas", langs: ["fr", "en"], text: "Le colis pèse 2,3 kilos et l'envoi coûte 14,90 euros.", expect: { route: "translate", numbers: true } },
  { group: "Numbers", title: "Phone number and date", langs: ["en", "ar"], text: "Please call me back at 650-555-0142 before March 14.", expect: { route: "translate", numbers: true } },
  { group: "Numbers", title: "Tickets and rupees", langs: ["hi", "en"], text: "मुझे 3 टिकट चाहिए, हर एक 450 रुपये का।", expect: { route: "translate", numbers: true } },
  { group: "Numbers", title: "Meeting time (Japanese → German)", langs: ["ja", "de"], text: "会議は10時30分からで、45分ぐらいかかります。", expect: { route: "translate", numbers: true } },
  { group: "Numbers", title: "Dosage wording", langs: ["en", "zh"], text: "Take 2 tablets every 8 hours, and no more than 6 in 24 hours.", expect: { route: "translate", numbers: true } },
  { group: "Numbers", title: "Area and rent", langs: ["pt", "en"], text: "O apartamento tem 85 metros quadrados e o aluguel é 2.300 reais por mês.", expect: { route: "translate", numbers: true } },

  // --- Questions are translated, not answered -------------------------------
  { group: "Questions", title: "\"What's that?\"", langs: ["en", "es"], text: "What's that?", expect: { route: "translate", question: true } },
  { group: "Questions", title: "Shipping cost", langs: ["es", "en"], text: "¿Cuánto cuesta enviar esto a México?", expect: { route: "translate", question: true } },
  { group: "Questions", title: "Directions", langs: ["en", "vi"], text: "Can you tell me where the nearest pharmacy is?", expect: { route: "translate", question: true } },
  { group: "Questions", title: "Opening hours (Russian)", langs: ["ru", "en"], text: "Вы не знаете, во сколько закрывается библиотека?", expect: { route: "translate", question: true } },
  { group: "Questions", title: "Factual question to the other person", langs: ["en", "it"], text: "How many people live in this town?", expect: { route: "translate", question: true } },

  // --- Talking to Galbot (including misheard names) -------------------------
  {
    group: "Galbot", title: "Say that more simply", langs: ["en", "es"], text: "Galbot, can you say that more simply?",
    history: [{ who: "B", text: "Tiene que presentar el formulario antes de la fecha límite o se aplicará un recargo por demora.", translation: "You have to submit the form before the deadline or a late surcharge will be applied." }],
    expect: { route: "galbot" },
  },
  { group: "Galbot", title: "Misheard as \"Gallbot\"", langs: ["en", "es"], text: "Gallbot what does deductible mean", expect: { route: "galbot" } },
  {
    group: "Galbot", title: "Misheard as \"call bot\"", langs: ["en", "es"], text: "call bot could you repeat what she just said",
    history: [{ who: "B", text: "La próxima cita es el jueves a las tres.", translation: "The next appointment is on Thursday at three." }],
    expect: { route: "galbot" },
  },
  { group: "Galbot", title: "Misheard in Spanish (\"Galbo\")", langs: ["es", "en"], text: "Galbo, ¿qué significa esa palabra?", history: [{ who: "A", text: "It's on the mezzanine.", translation: "Está en el entrepiso." }], expect: { route: "galbot" } },
  { group: "Galbot", title: "Explain to the other person", langs: ["en", "es"], text: "Galbot, please explain to her what a co-signer is.", expect: { route: "galbot" } },
  { group: "Galbot", title: "Mentioned, not addressed", langs: ["en", "es"], text: "This is Galbot, it's going to translate for both of us.", expect: { route: "translate" } },

  // --- Standing instructions (run in order: on, applied, off) ---------------
  { group: "Instructions", title: "Turn on: keep it simple", sequence: "kid", langs: ["en", "es"], text: "Galbot, I'm talking with a young kid, please keep everything really simple.", expect: { route: "galbot", instruction: "set" } },
  { group: "Instructions", title: "Applied to the next translation", sequence: "kid", langs: ["en", "es"], text: "We need to wait here until your mom comes back from the store, and then we can get ice cream.", expect: { route: "translate" }, review: true },
  { group: "Instructions", title: "Turn off: back to normal", sequence: "kid", langs: ["en", "es"], text: "Galbot, go back to normal translation.", expect: { route: "galbot", instruction: "clear" } },
  { group: "Instructions", title: "Turn on: more formal", langs: ["en", "ja"], text: "Galbot, please be more formal from now on.", expect: { route: "galbot", instruction: "set" } },

  // --- Look-ups -------------------------------------------------------------
  { group: "Look-up", title: "Population of a city", langs: ["en", "es"], text: "Galbot, roughly how many people live in Lisbon?", expect: { route: "galbot", sources: true } },
  { group: "Look-up", title: "Museum hours (asked in Spanish)", langs: ["es", "en"], text: "Galbot, ¿a qué hora cierra normalmente el Museo del Prado?", expect: { route: "galbot", sources: true } },

  // --- Wrong language / noise ------------------------------------------------
  { group: "Recovery", title: "Spanish speech heard by the English recognizer", langs: ["en", "es"], via: "voice", confidence: 0.41, text: "key or a sir war in the poor fever sea are pro hound toe", expect: { route: "repeat" } },
  { group: "Recovery", title: "English speech heard by the Spanish recognizer", langs: ["es", "en"], via: "voice", confidence: 0.38, text: "huero es de bar rum plis", expect: { route: "repeat" } },
  { group: "Recovery", title: "Just a filler sound", langs: ["en", "es"], via: "voice", text: "um", expect: { route: "noise" } },
  { group: "Recovery", title: "Short real reply is not garbled", langs: ["es", "en"], via: "voice", confidence: 0.6, text: "sí claro", expect: { route: "translate" } },
];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function runCase(c, sequenceState) {
  const [a, b] = c.langs.map(findLanguage);
  const instructions = c.sequence ? sequenceState[c.sequence] || [] : [];
  const events = [];
  const started = performance.now();
  let firstText = null;
  let routeAt = null;
  await runTurn(
    {
      text: c.text,
      speaker: "A", // Person A speaks c.langs[0], Person B speaks c.langs[1]
      langs: { A: a.name, B: b.name },
      history: c.history || [],
      instructions,
      via: c.via || "typed",
      confidence: c.confidence,
    },
    (ev) => {
      events.push(ev);
      if (ev.t === "route") routeAt ??= performance.now() - started;
      if ((ev.t === "text" || ev.t === "say") && firstText === null) firstText = performance.now() - started;
    }
  );
  const total = performance.now() - started;

  const route = events.find((e) => e.t === "route")?.route || "(none)";
  const output = events.filter((e) => e.t === "text" || e.t === "say").map((e) => e.text).join("").trim();
  const caption = events.filter((e) => e.t === "caption").map((e) => e.text).join("").trim();
  const errors = events.filter((e) => e.t === "error").map((e) => e.message);
  const instructionEvents = events.filter((e) => e.t === "instruction");
  const sources = events.filter((e) => e.t === "source");

  // Keep standing instructions between the steps of a sequence.
  if (c.sequence) {
    let list = [...instructions];
    for (const ev of instructionEvents) {
      if (ev.action === "set") list.push({ id: crypto.randomUUID(), text: ev.text });
      if (ev.action === "clear") list = list.filter((i) => i.id !== ev.id);
      if (ev.action === "clear_all") list = [];
    }
    sequenceState[c.sequence] = list;
  }

  const checks = [];
  const check = (ok, label) => checks.push({ ok, label });
  if (errors.length) check(false, `Error: ${errors.join("; ")}`);
  check(route === c.expect.route, `Route is "${c.expect.route}" (got "${route}")`);
  if (c.expect.numbers) {
    const m = checkNumbers(c.text, output);
    check(!m, m ? `Numbers differ: missing ${m.missing.join(", ") || "none"}, extra ${m.extra.join(", ") || "none"}` : "All numbers match");
  }
  if (c.expect.question) {
    check(/[?？؟]\s*$/.test(output), "Output is still a question");
    check(output.length < c.text.length * 3 + 20, "Output is not an answer (similar length)");
  }
  if (c.expect.instruction === "set") check(instructionEvents.some((e) => e.action === "set"), "Standing instruction added (chip)");
  if (c.expect.instruction === "clear")
    check(instructionEvents.some((e) => e.action === "clear" || e.action === "clear_all"), "Standing instruction removed");
  if (c.expect.sources) check(sources.length > 0, `Shows a source (${sources.length})`);
  if (c.expect.route === "galbot" || c.expect.route === "translate" || c.expect.route === "repeat") check(output.length > 0, "Produced text");

  const failed = checks.some((x) => !x.ok);
  const status = failed ? "fail" : c.review ? "review" : "pass";
  return { status, route, output, caption, checks, sources, instructions, routeAt, firstText, total, server: events.find((e) => e.t === "done")?.timing };
}

function render(c, r, el) {
  const status = r ? r.status : "wait";
  el.innerHTML = `
    <div class="head">
      <span class="badge ${status}">${r ? status : "running…"}</span>
      <span class="title">${esc(c.title)}</span>
      <span class="group">${esc(c.group)} · ${esc(c.langs.join(" → "))}</span>
    </div>
    <dl class="io">
      <dt>Said</dt><dd lang="${c.langs[0]}">${esc(c.text)}</dd>
      ${c.history?.length ? `<dt>Context</dt><dd>${esc(c.history.map((h) => h.text).join(" / "))}</dd>` : ""}
      ${r?.instructions?.length ? `<dt>Active</dt><dd>${esc(r.instructions.map((i) => i.text).join(" / "))}</dd>` : ""}
      ${r ? `<dt>Galbot</dt><dd>${esc(r.output) || "<i>(nothing)</i>"}</dd>` : ""}
      ${r?.caption ? `<dt>Caption</dt><dd>${esc(r.caption)}</dd>` : ""}
      ${r?.sources?.length ? `<dt>Sources</dt><dd>${r.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join(" · ")}</dd>` : ""}
    </dl>
    ${r ? `<div class="checks">${r.checks.map((x) => `<span class="${x.ok ? "pass" : "fail"}">${x.ok ? "✓" : "✗"} ${esc(x.label)}</span>`).join("")}</div>` : ""}
    ${r ? `<div class="timing">route ${ms(r.routeAt)} · first words ${ms(r.firstText)} · total ${ms(r.total)}</div>` : ""}`;
}

const ms = (v) => (v == null ? "—" : `${(v / 1000).toFixed(2)}s`);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

$("#run").addEventListener("click", async () => {
  const button = $("#run");
  button.disabled = true;
  const results = $("#results");
  results.replaceChildren();
  const sequenceState = {};
  const tally = { pass: 0, review: 0, fail: 0 };
  const firstTextTimes = [];
  for (const c of CASES) {
    const el = document.createElement("div");
    el.className = "case";
    results.append(el);
    render(c, null, el);
    el.scrollIntoView({ block: "nearest" });
    const r = await runCase(c, sequenceState);
    render(c, r, el);
    tally[r.status]++;
    if (c.expect.route === "translate" && r.firstText != null) firstTextTimes.push(r.firstText);
    $("#summary").textContent = `${tally.pass} pass · ${tally.review} to review · ${tally.fail} fail`;
  }
  const med = median(firstTextTimes);
  $("#summary").textContent += med ? ` · median time to first translated words: ${(med / 1000).toFixed(2)}s` : "";
  button.disabled = false;
});
