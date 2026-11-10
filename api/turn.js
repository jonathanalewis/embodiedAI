// /api/turn : the only server code in the Galbot interpreter app.
//
// The browser sends one utterance (plus recent context). This function asks
// Claude what to do with it and streams the answer back as it is written,
// one JSON object per line ("NDJSON"). The browser speaks and displays the
// text as it arrives, so nobody waits for the whole answer.
//
//   GET  /api/turn  -> { ok, hasKey }   (also wakes the function up early)
//   POST /api/turn  -> stream of events, see README "How it works"
//
// The Claude API key lives ONLY in the Vercel environment variable
// ANTHROPIC_API_KEY. It never reaches the browser.

import Anthropic from "@anthropic-ai/sdk";
import {
  INTERPRETER_PROMPT,
  GALBOT_PROMPT,
  interpreterRequest,
  galbotRequest,
} from "../lib/prompts.js";
import { GalbotParser } from "../lib/galbot-parser.js";

// Models (check https://platform.claude.com/docs/en/about-claude/models).
const FAST_MODEL = "claude-haiku-5-5"; // every utterance: route + translate
const SMART_MODEL = "claude-sonnet-5-5"; // only when someone talks to the interpreter by name

// Claude's built-in web search, used for look-ups.
const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 3 };

const TAGS = { T: "translate", G: "galbot", R: "repeat", N: "noise" };

let client = null; // reused between requests while the function stays warm

export default async function handler(req, res) {
  if (req.method === "GET") {
    return sendJson(res, 200, { ok: true, hasKey: Boolean(process.env.ANTHROPIC_API_KEY) });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });
  if (!process.env.ANTHROPIC_API_KEY) return sendJson(res, 503, { error: "no_key" });

  let turn;
  try {
    turn = cleanTurn(await readBody(req));
  } catch (err) {
    return sendJson(res, 400, { error: String(err.message || err) });
  }

  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  const started = Date.now();
  const timing = {};
  const send = (event) => {
    if (event.t === "text" || event.t === "say") timing.firstText ??= Date.now() - started;
    res.write(JSON.stringify(event) + "\n");
  };

  try {
    const route = await interpret(turn, send, timing, started);
    if (route === "galbot") await askGalbot(turn, send, timing, started);
  } catch (err) {
    console.error(err);
    send({ t: "error", message: friendlyError(err) });
  }
  timing.total = Date.now() - started;
  send({ t: "done", timing });
  res.end();
}

// Step 1: the fast model decides what this utterance is and, usually,
// streams the translation straight away.
async function interpret(turn, send, timing, started) {
  const stream = client.messages.stream({
    model: FAST_MODEL,
    max_tokens: 2048,
    thinking: { type: "disabled" }, // fastest possible first word
    output_config: { effort: "low" },
    system: [{ type: "text", text: INTERPRETER_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: interpreterRequest(turn) }],
  });

  let head = "";
  let route = null;
  for await (const event of stream) {
    if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") continue;
    const text = event.delta.text;
    if (route) {
      send({ t: "text", text });
      continue;
    }
    // Wait for the opening tag, e.g. "[T]".
    head += text;
    const m = head.match(/^\s*\[([TGRN])\]\s*/);
    if (m) {
      route = TAGS[m[1]];
      timing.route = Date.now() - started;
      send({ t: "route", route });
      if (route === "galbot" || route === "noise") break; // nothing more needed
      const rest = head.slice(m[0].length);
      if (rest) send({ t: "text", text: rest });
    } else if (head.length > 6) {
      // No tag: assume it is a translation rather than lose it.
      route = "translate";
      send({ t: "route", route });
      send({ t: "text", text: head.trim() });
    }
  }

  if (route === "galbot" || route === "noise") return route;
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    send({ t: "error", message: "Sorry, that one could not be translated." });
  }
  if (!route) {
    // Ended before any tag arrived (very short or empty output).
    route = /\[G\]/.test(head) ? "galbot" : head.trim() ? "translate" : "noise";
    send({ t: "route", route });
    if (route === "translate") send({ t: "text", text: head.replace(/^\s*\[[A-Z]\]\s*/, "") });
  }
  timing.fastModel = usageSummary(final);
  return route;
}

// Step 2 (only when someone talked to Galbot): the stronger model answers
// as Galbot, with web search available for look-ups.
async function askGalbot(turn, send, timing, started) {
  const parser = new GalbotParser({ asker: turn.speaker, instructions: turn.instructions, send });
  const messages = [{ role: "user", content: galbotRequest(turn) }];
  const searchResults = [];
  const sentSources = new Set();
  const sendSource = (url, title) => {
    if (!url || sentSources.has(url)) return;
    sentSources.add(url);
    send({ t: "source", url, title: title || url });
  };

  // A web search can make the API pause a long turn ("pause_turn");
  // we simply continue it, at most a few times.
  for (let round = 0; round < 3; round++) {
    const stream = client.beta.messages.stream({
      model: SMART_MODEL,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" }, // quick, conversational answers
      // If Claude declines for a safety reason, the API retries on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: GALBOT_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [WEB_SEARCH],
      messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "server_tool_use") send({ t: "status", state: "searching" });
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) searchResults.push({ url: r.url, title: r.title });
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") parser.push(event.delta.text);
        if (event.delta.type === "citations_delta") {
          const c = event.delta.citation;
          if (c && c.type === "web_search_result_location") sendSource(c.url, c.title);
        }
      }
    }

    const final = await stream.finalMessage();
    timing.smartModel = usageSummary(final);
    if (final.stop_reason === "refusal") {
      send({ t: "error", message: "Sorry, I can't help with that request." });
      break;
    }
    if (final.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: final.content });
  }
  parser.end();

  // Searched but nothing was cited? Still show where the answer came from.
  if (!sentSources.size) searchResults.slice(0, 2).forEach((r) => sendSource(r.url, r.title));
  timing.galbotDone = Date.now() - started;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cleanTurn(body) {
  if (!body || typeof body !== "object") throw new Error("Missing JSON body");
  const text = String(body.text || "").trim().slice(0, 2000);
  if (!text) throw new Error("Missing text");
  const speaker = body.speaker === "B" ? "B" : "A";
  const langs = {
    A: String(body.langs?.A || "English").slice(0, 40),
    B: String(body.langs?.B || "Spanish").slice(0, 40),
  };
  const history = (Array.isArray(body.history) ? body.history : []).slice(-10).map((h) => ({
    who: ["A", "B", "G"].includes(h.who) ? h.who : "A",
    to: h.to === "A" || h.to === "B" ? h.to : undefined,
    text: String(h.text || "").slice(0, 1500),
    translation: h.translation ? String(h.translation).slice(0, 1500) : "",
    toGalbot: Boolean(h.toGalbot),
  }));
  const instructions = (Array.isArray(body.instructions) ? body.instructions : [])
    .slice(0, 6)
    .map((i) => ({ id: String(i.id || ""), text: String(i.text || "").slice(0, 400) }));
  return {
    text,
    speaker,
    langs,
    history,
    instructions,
    via: body.via === "voice" ? "voice" : "typed",
    confidence: typeof body.confidence === "number" ? body.confidence : undefined,
  };
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body; // Vercel parsed it
  if (typeof req.body === "string") return JSON.parse(req.body);
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function usageSummary(message) {
  const u = message.usage || {};
  return {
    model: message.model,
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
  };
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "The Claude API key is not valid. Check ANTHROPIC_API_KEY in Vercel.";
  if (err instanceof Anthropic.PermissionDeniedError) return "The Claude API key does not have access to this model.";
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate-limited right now. Wait a moment and try again.";
  if (err instanceof Anthropic.BadRequestError) {
    const msg = String(err.message || "");
    if (/credit balance/i.test(msg)) return "The Claude account is out of credit.";
    return `Claude rejected the request: ${msg.slice(0, 200)}`;
  }
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach Claude. Check the internet connection.";
  if (err instanceof Anthropic.APIError) return `Claude error ${err.status}: ${String(err.message).slice(0, 200)}`;
  return `Something went wrong: ${String(err.message || err).slice(0, 200)}`;
}
