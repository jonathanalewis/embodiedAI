// Everything you might want to tweak lives here.

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
  echoTailMs: 400, // keep the mic off this long after Galbot stops talking
  restartDelayMs: 150, // pause before restarting recognition after it stops
};

export const VOICE = {
  personRate: 1.0, // speed of translated speech
  galbotRate: 1.04, // Galbot's own voice: a touch quicker...
  galbotPitch: 1.2, // ...and a little higher, so it sounds different
};

// How many recent turns to send as context (keeps terms consistent).
export const CONTEXT_TURNS = 8;

export function findLanguage(code) {
  return LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
}
