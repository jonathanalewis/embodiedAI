// Number check: every number in the original should appear in the
// translation, and the translation should not contain new numbers.
//
// We compare runs of digits, ignoring separators, so "1,500" = "1.500" =
// "1 500" and "3:30" = "3 h 30". Non-Western digits (Arabic, Devanagari,
// full-width...) are converted first. Numbers spelled out as words are not
// checked; the interpreter prompt asks Claude to keep digits as digits.

const DIGIT_SETS = [
  0x0660, // Arabic-Indic ٠
  0x06f0, // Extended Arabic-Indic ۰
  0x0966, // Devanagari ०
  0xff10, // Full-width ０
];

function toAsciiDigits(text) {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const base = DIGIT_SETS.find((b) => code >= b && code <= b + 9);
    out += base !== undefined ? String(code - base) : ch;
  }
  return out;
}

function digitRuns(text) {
  const runs = toAsciiDigits(text).match(/\d+/g) || [];
  return runs.map((r) => r.replace(/^0+(?=\d)/, "")); // "07" -> "7"
}

// Returns null when everything matches, otherwise { missing, extra }.
export function checkNumbers(original, translation) {
  const a = digitRuns(original);
  const b = digitRuns(translation);
  const remaining = [...b];
  const missing = [];
  for (const n of a) {
    const i = remaining.indexOf(n);
    if (i >= 0) remaining.splice(i, 1);
    else missing.push(n);
  }
  if (!missing.length && !remaining.length) return null;
  return { missing, extra: remaining };
}
