# Notes for Claude Code (Galbot Interpreter)

Galbot is the robot. The interpreter persona is called **Click** (`ASSISTANT.name` in `public/js/config.js`,
also read by the server prompts). Internal code names (`galbot_to`, `galbot-parser.js`) are kept on purpose.

The two people working in this repo are mechanical engineers, not software engineers.
Explain what they need to do in plain steps. Keep code simple and readable.

## How this project works
- Plain HTML/CSS/JS in `public/` (ES modules, **no build step, no framework**). Keep it that way.
- One Vercel serverless function: `api/turn.js` (Node, `@anthropic-ai/sdk`). Shared server code lives in `lib/`
  (files inside `api/` become endpoints, so don't put helpers there).
- **Every push to `main` deploys the live site** (Vercel, connected to this public repo). Nobody runs a terminal.
- The Claude API key is ONLY the Vercel environment variable `ANTHROPIC_API_KEY`. Never put a key in code,
  in the browser, or in a commit.
- Without a key the app runs in "free mode" (Chrome's built-in Translator API) for basic translation.

## Product rules (from the team)
- General-purpose interpreter: **nothing setting-specific**. No scenario presets, role fields, setting pickers,
  or hardcoded scenario examples in the app or its prompts. Varied examples are fine in `public/js/tests.js` only.
- Default translation is faithful (complete, first person, questions translated not answered, numbers exact).
  Adaptation happens only through standing instructions, which must stay visible as chips.
- Galbot never gives its own medical/legal/financial advice, never contradicts professionals in the room,
  never makes things up.
- Language detection (`detector.js`: Whisper via transformers.js from a CDN, runs in the browser) must always
  fail safe: if it can't load, Galbot falls back to alternating languages.
- Audio input (`ears.js`), speech output (`voice.js`) and display (`stage.js`) stay behind their small
  interfaces so sign language, voice cloning and Galbot's own hardware can plug in later.

## Testing (do this before pushing changes to listening or turn logic)
- `node tests/conversation.test.cjs` runs 13 simulated conversations in a real browser (free mode, all
  speech/voice/model parts faked realistically). All must pass. If you change behavior, add a scenario.
- Lesson learned: listening while the interpreter talks ("barge-in") caused the other person's replies to be
  attributed to the speaker and garbage ("I'm sorry") to be tacked on. The mic stays OFF while speaking;
  interrupting is explicit (tap the orb / Space). Don't reintroduce barge-in without a scenario proving
  the other person's replies still work.

## Conventions
- Adding a language = one line in `public/js/config.js`.
- Models are constants at the top of `api/turn.js`. Check current model IDs in the Anthropic docs before changing.
- After changing prompts or models, ask the user to open `/test.html` and run the tests (it costs a few cents).
- The browser target is desktop Chrome (Web Speech API).
