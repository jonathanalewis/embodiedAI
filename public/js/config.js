// Everything you might want to tweak lives here.

// The interpreter's name. People say it to talk to it directly ("Hey Click, ...").
// `name` is used everywhere, including the server's instructions to Claude.
// soundsLike: how speech recognition tends to write the name (used in free mode).
// needsGreeting: the name is also an everyday word, so in free mode only
// "Hey Click / OK Click ..." counts (with a Claude key, Claude judges context).
export const ASSISTANT = {
  name: "Click",
  soundsLike: ["click", "clic", "klick", "klik", "clik", "clique", "cliq", "quick", "클릭", "クリック", "克里克", "点击", "كليك", "клик", "клік", "क्लिक"],
  needsGreeting: true,
};

// ---------------------------------------------------------------------------
// LANGUAGES: to add a language, add ONE line.
//   code   : short id (also used by Chrome's free on-device translator)
//   name   : English name (what Claude is told)
//   native : what people see on screen
//   speech : locale for Chrome speech recognition and for picking a voice
//   rtl    : true for right-to-left scripts
// ---------------------------------------------------------------------------
export const LANGUAGES = [
  { code: "en", name: "English", native: "English", speech: "en-US" },
  { code: "es", name: "Spanish", native: "Español", speech: "es-US" },
  { code: "zh", name: "Mandarin Chinese", native: "中文", speech: "zh-CN" },
  { code: "hi", name: "Hindi", native: "हिन्दी", speech: "hi-IN" },
  { code: "ar", name: "Arabic", native: "العربية", speech: "ar-SA", rtl: true },
  { code: "fr", name: "French", native: "Français", speech: "fr-FR" },
  { code: "pt", name: "Portuguese", native: "Português", speech: "pt-BR" },
  { code: "ru", name: "Russian", native: "Русский", speech: "ru-RU" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt", speech: "vi-VN" },
  { code: "tl", name: "Tagalog", native: "Tagalog", speech: "fil-PH" },
  { code: "ko", name: "Korean", native: "한국어", speech: "ko-KR" },
  { code: "ja", name: "Japanese", native: "日本語", speech: "ja-JP" },
  { code: "de", name: "German", native: "Deutsch", speech: "de-DE" },
  { code: "it", name: "Italian", native: "Italiano", speech: "it-IT" },
  { code: "uk", name: "Ukrainian", native: "Українська", speech: "uk-UA" },
];

// ---------------------------------------------------------------------------
// Listening and speaking timing (milliseconds)
// ---------------------------------------------------------------------------
export const TIMING = {
  pauseMs: 800, // silence that ends an utterance
  finalGraceMs: 250, // wait this long after Chrome itself says "phrase finished"
  echoTailMs: 400, // after the interpreter stops talking, wait this long before switching languages
  restartDelayMs: 150, // pause before restarting recognition after it stops
  earlyCheckMs: 700, // how far into speech the first language check happens
  addOnWindowMs: 4000, // same person speaks again this soon after the translation = adding on
  bargeIn: true, // talking over a translation makes the interpreter stop and listen
};

export const VOICE = {
  personRate: 1.0, // speed of translated speech
  galbotRate: 1.04, // the interpreter's own voice: a touch quicker...
  galbotPitch: 1.2, // ...and a little higher, so it sounds different
  // Voice matching: translations are spoken in a voice a bit like the speaker's.
  lowVoiceBelowHz: 165, // speakers below this pitch get a lower (male-sounding) voice
  matchStrength: 0.5, // 0 = don't adjust pitch, 1 = follow the speaker's pitch fully
};

// How many recent turns to send as context (keeps terms consistent).
export const CONTEXT_TURNS = 8;

export function findLanguage(code) {
  return LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
}
