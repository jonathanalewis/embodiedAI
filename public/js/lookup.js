// Free look-ups for free mode (no Claude key): "Hey Click, look up ___" or
// "Hey Click, tell me more about that". Uses Wikipedia, in the asker's language.
// "Hey Click, tell them about ___" answers the OTHER person, in their language.
// (With a Claude key, Claude's web search is used instead, which is smarter.)
//
// Without Claude there's nothing to "understand" the request, so this works
// on simple patterns: the name (or a common mishearing) at the start or end,
// then whatever topic is left after removing filler words.

import { ASSISTANT } from "./config.js";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s?");
const NAME = `(?:${[ASSISTANT.name.toLowerCase(), ...ASSISTANT.soundsLike].map(escape).join("|")})`;
const GREETING = `(?:(?:hey|hi|hello|ok|okay|oye|hola|eh|ey|oi|嘿|喂|헤이|ヘイ|ねえ|эй|ей|अरे|هاي)[\\s,、，]*)${ASSISTANT.needsGreeting ? "" : "?"}`;
const AT_START = new RegExp(`^${GREETING}${NAME}(?![\\p{L}])[\\s,.:;!?¡¿、，。-]*`, "iu");
// "..., Click?" at the end only counts when the name isn't an everyday word.
const AT_END = ASSISTANT.needsGreeting ? /$^/ : new RegExp(`[\\s,.:;!?、，。-]*(?<![\\p{L}])${NAME}[\\s.!?。？！]*$`, "iu");

// "Tell them / explain to her ...": answer the other person instead of the asker.
const TO_OTHER = [
  /\b(tell|explain( this| that| it)? to|let) (them|him|her|the other person)( know)?( about)?\b/gi,
  /\b(dile|digale|dile a (el|ella)|explicale|cuentale|avisale)\b/gi,
  /\b(dis-lui|explique-lui|diga (a|para) (ele|ela)|fala pra (ele|ela)|explica (a|para) (ele|ela)|sag (ihm|ihr)|erklar (ihm|ihr)|digli|dille|spiegagli|spiegale)\b/gi,
];

// Filler words around the topic (a few common languages; others still work,
// because Wikipedia's search ignores most extra words).
const FILLER = [
  /\b(can|could|would) you\b/gi, /\bplease\b/gi, /\b(look|looking) (up|into)\b/gi, /\bsearch( for)?\b/gi,
  /\bfind( out)?\b/gi, /\btell (me|us|her|him|them)\b/gi, /\b(give|get) (me|us)\b/gi, /\b(a little |a bit |some )?more( detail(s)?| information| info)?\b/gi,
  /\b(about|on|regarding)\b/gi, /\bwhat('s| is| are| was| were)\b/gi, /\bwho('s| is| was)\b/gi, /\bexplain\b/gi,
  /\b(puedes|podrias|podria|por favor|busca(r)?|dime|cuentame|mas|informacion|detalles?|sobre|acerca de|que es|quien es)\b/gi,
  /\b(peux-tu|pouvez-vous|s'il (te|vous) plait|cherche(r)?|dis-moi|plus|d'informations|sur|qu'est-ce que)\b/gi,
];
const POINTERS = /^(that|this|it|those|these|eso|esto|ese|esa|ça|cela|isso|isto|das|questo|quello)( (thing|word|one|part|policy|rule|cosa|palabra|parte))?$/i;

// If the utterance is addressed to the interpreter, returns
// { topic, toOther } (topic "" = "that"; toOther = speak to the other person).
export function freeAssistantRequest(text) {
  const original = text.trim();
  let rest;
  if (AT_START.test(original)) rest = original.replace(AT_START, "");
  else if (AT_END.test(original)) rest = original.replace(AT_END, "");
  else return null;
  if (!rest.replace(/[\p{P}\s]/gu, "")) return { bare: true }; // just the name, nothing asked yet
  let topic = rest;
  let toOther = false;
  // Filler removal only for Latin-script languages (accents removed first so
  // the word patterns match); other scripts go to Wikipedia as they are.
  if (/^[\p{Script=Latin}\p{N}\p{P}\s]*$/u.test(topic)) {
    topic = topic.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    for (const f of TO_OTHER) {
      if (f.test(topic)) toOther = true;
      f.lastIndex = 0;
      topic = topic.replace(f, " ");
    }
    for (const f of FILLER) topic = topic.replace(f, " ");
  }
  topic = topic.replace(/[¿?¡!.,;:"“”]/g, " ").replace(/\s+/g, " ").trim();
  topic = topic.replace(/^(the|a|an|el|la|los|las|le|les|un|una|o|a|der|die|il|lo)\s+/i, "");
  if (POINTERS.test(topic)) topic = "";
  return { topic, toOther };
}

// Search Wikipedia in `lang`. Returns the article's opening section split
// into sentences, so Galbot can read a few now and more if asked.
export async function wikipediaLookUp(query, lang) {
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const get = async (params) => (await fetch(`${api}?${new URLSearchParams({ format: "json", origin: "*", ...params })}`)).json();
  const found = await get({ action: "query", list: "search", srsearch: query, srlimit: "1" });
  const title = found?.query?.search?.[0]?.title;
  if (!title) return null;
  const data = await get({ action: "query", prop: "extracts|info", exintro: "1", explaintext: "1", inprop: "url", redirects: "1", titles: title });
  const page = Object.values(data?.query?.pages || {})[0];
  const intro = String(page?.extract || "").replace(/\s+/g, " ").trim();
  if (!intro) return null;
  return {
    title: page.title || title,
    url: page.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    sentences: intro.match(/[^.!?。！？]+[.!?。！？]+(\s|$)|[^.!?。！？]+$/g).map((x) => x.trim()),
  };
}

// The next few sentences (about 2–4 spoken sentences), starting at `from`.
export function nextSentences(article, from, maxChars = 420) {
  let out = "";
  let i = from;
  while (i < article.sentences.length && (out === "" || (out + " " + article.sentences[i]).length <= maxChars) && i - from < 4) {
    out = out ? `${out} ${article.sentences[i]}` : article.sentences[i];
    i++;
  }
  return { text: out, next: i };
}
