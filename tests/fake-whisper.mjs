// Fake transformers.js. The "truth" (who is speaking, what they said) is set
// by the test. Transcribing in the WRONG language returns a hallucination,
// like real Whisper does, so that class of bug shows up in tests.
export class LogitsProcessor { constructor() {} }
const LANGS = ["en","es","zh","hi","ar","fr","pt","ru","vi","tl","ko","ja","de","it","uk"];
const lang_to_id = Object.fromEntries(LANGS.map((c, i) => [`<|${c}|>`, 10 + i]));
export const AutoProcessor = { from_pretrained: async () => async (audio) => ({ input_features: audio }) };
export const AutoTokenizer = { from_pretrained: async () => ({ batch_decode: (out) => [out.text] }) };
export const WhisperForConditionalGeneration = {
  from_pretrained: async () => ({
    generation_config: { lang_to_id, decoder_start_token_id: 1 },
    async generate({ max_new_tokens, logits_processor, language }) {
      await new Promise((r) => setTimeout(r, 60));
      const truth = window.__truth || { lang: "en", text: "" };
      if (max_new_tokens === 1) {
        const logits = { data: new Float32Array(64) };
        logits.data[lang_to_id[`<|${truth.lang}|>`]] = 5;
        for (const p of logits_processor) p._call([[1]], logits);
        return {};
      }
      window.__transcribed = (window.__transcribed || []).concat([language]);
      return { text: language === truth.lang ? truth.text : (language === "es" ? "Lo siento." : "I'm sorry.") };
    },
  }),
};
