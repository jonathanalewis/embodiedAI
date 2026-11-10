// Free look-ups for free mode (no Claude key): "Galbot, look up ___" or
// "Galbot, tell me more about that". Uses Wikipedia, in the asker's language.
// (With a Claude key, Galbot uses Claude's web search instead, which is smarter.)
//
// Without Claude there's nothing to "understand" the request, so this works
// on simple patterns: Galbot's name (or a common mishearing) at the start or
// end, then whatever topic is left after removing filler words.

// Galbot's name as speech recognition tends to write it (accents removed).
const NAME = "(?:hey |ok |okay |oye )?(?:gal+ ?b[oa]t+s?|gall ?bot|call ?bot|cal ?bot|gold ?bot|gal ?but|galbo|galvo|gabot|gaul ?bot)";
const AT_START = new RegExp(`^${NAME}\\b[\\s,.:;!?-]*`, "i");
const AT_END = new RegExp(`[\\s,.:;!?-]*\\b${NAME}[\\s.!?]*$`, "i");

// Filler words around the topic (a few common languages; others still work,
// because Wikipedia's search ignores most extra words).
const FILLER = [
  /\b(can|could|would) you\b/gi, /\bplease\b/gi, /\b(look|looking) (up|into)\b/gi, /\bsearch( for)?\b/gi,
  /\bfind( out)?\b/gi, /\btell (me|us|her|him|them)\b/gi, /\b(give|get) (me|us)\b/gi, /\b(a little |a bit |some )?more( detail(s)?| information| info)?\b/gi,
  /\b(about|on|regarding)\b/gi, /\bwhat('s| is| are| was| were)\b/gi, /\bwho('s| is| was)\b/gi, /\bexplain\b/gi,
  /\b(puedes|podrías|podria|por favor|busca(r)?|dime|cuéntame|cuentame|más|mas|información|informacion|detalles?|sobre|acerca de|qué es|que es|quién es|quien es)\b/gi,
  /\b(peux-tu|pouvez-vous|s'il (te|vous) plait|cherche(r)?|dis-moi|plus|d'informations|sur|qu'est-ce que)\b/gi,
];
const POINTERS = /^(that|this|it|those|these|eso|esto|ese|esa|ça|cela|isso|isto|das|questo|quello)( (thing|word|one|part|cosa|palabra|parte))?$/i;

// If the utterance is addressed to Galbot, returns { topic } ("" = "that").
export function freeGalbotRequest(text) {
  const original = text.trim();
  let rest;
  if (AT_START.test(original)) rest = original.replace(AT_START, "");
  else if (AT_END.test(original)) rest = original.replace(AT_END, "");
  else return null;
  let topic = rest;
  // Filler removal only for Latin-script languages (accents removed first so
  // the word patterns match); other scripts go to Wikipedia as they are.
  if (/^[\p{Script=Latin}\p{N}\p{P}\s]*$/u.test(topic)) {
    topic = topic.normalize("NFD").replace(/[̀-ͯ]/g, "");
    for (const f of FILLER) topic = topic.replace(f, " ");
  }
  topic = topic.replace(/[¿?¡!.,;:"“”]/g, " ").replace(/\s+/g, " ").trim();
  topic = topic.replace(/^(the|a|an|el|la|los|las|le|les|un|una|o|a|der|die|il|lo)\s+/i, "");
  if (POINTERS.test(topic)) topic = "";
  return { topic };
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
