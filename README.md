# embodiedAI
Stanford University's ME310 project on embodied AI for human to human connection

---

# Galbot Interpreter

Galbot is the robot; its interpreter is called **Click** (the name is one line in `public/js/config.js`). Click stands between two people who don't share a language. They just talk;
Click translates out loud and shows live captions on each person's side of
the screen. Anyone can talk to Click by name ("Click, say that more simply",
"Click, keep it formal from now on", "Click, what time does the post office
close?").

**Live site:** the Vercel URL for this repo (Vercel dashboard → the project → "Domains").
**Test page:** the same URL + `/test.html`.

Use **Google Chrome on a laptop or desktop**. Safari and Firefox don't support the free speech recognition Click uses.

---

## Running a demo

1. Open the live site in Chrome. Put the laptop between the two people, facing both.
2. Pick the **left** person's language and the **right** person's language. Click remembers them for next time.
3. Press **Begin**. The first time, Chrome asks for the microphone: click **Allow**.
4. Talk. After a short pause (about 0.8 s), Click translates out loud.
5. Optional: press **F** for full screen. Press **End** to go back to the start.

What you see:

| On screen | Meaning |
|---|---|
| Big line at the bottom of a side | The newest thing said, in that person's language. Older lines shrink and fade. |
| Grey line | What *this* person said (so they can check Click heard them right). |
| Black line | What the *other* person said, translated. |
| Purple line marked CLICK | Click speaking as itself. It also sounds different (another voice, slightly higher). |
| (sound) Translations in a voice a bit like the speaker's | Free voice matching: Click measures how high or low each person's voice is and picks the closest built-in voice (deeper or higher, male- or female-sounding). It is not a clone of their voice. |
| `English ⇄ Español` under the orb | Automatic language detection is on: anyone can speak at any time. |
| `↺ language detected by sound` | Chrome was listening for the other language; Click noticed from the sound and fixed it. |
| Chip under the orb | A standing instruction is active, so translations are being adapted. Tap it to remove it. |
| `⚠ numbers differ` | A number in the original didn't come through in the translation. Check it. |
| `0.9s text · 1.4s voice` | Delay from the speaker's last word to the first translated text and to the first sound. |
| Small `↗ site.com` pills | Where a look-up answer came from. Click to open. |

The orb shows Click's state: slow breathing = idle, blue glow = listening, pulsing = hearing someone, spinning = translating or thinking, ripples = speaking, grey = microphone problem.

### Handy controls

- **Tap a person's language button** to tell Click who is about to speak. Only needed if automatic language detection is off (a note under the orb says so).
- **Tap the orb** to stop Click talking.
- **Adding more:** if you start talking again while Click is translating, Click stops, listens, and re-translates your whole message (marked "＋ added on (re-translated)"). If you add more within about 4 seconds after Click finishes, it's added to the same lines and only the new part is translated and spoken ("＋ added on").
- **Typing box** at the bottom of each side: type instead of talking if the mic misbehaves.

### Talking to Click

Say **"Hey Click, ..."** (or "OK Click"). "Click" is also an everyday word, so in free mode it only reacts when greeted; with a Claude key, Claude also understands "Click, ..." from context. When Click talks as itself it's warm and upbeat (inspired by companion robots like ElliQ); translations stay word-for-word.

**Who hears the answer** (nobody hears it twice):
- "Hey Click, what's the policy on returns?" → Click answers **you**, in your language; the other person reads a caption.
- "Hey Click, tell them the policy on returns." → Click speaks to **the other person**, in their language; you read a caption.

Just say its name. Speech recognition often mishears it ("Gallbot", "call bot"); that's fine, because Claude judges by sound and context.

- **One-time help:** "Click, can you say that more simply?", "Click, what does that word mean?", "Click, explain to her what a deposit is." Click answers once, then goes back to translating.
- **Standing instructions:** "Click, I'm talking to a young kid, keep it simple." Click confirms in one sentence and a chip appears. "Click, go back to normal translation" (or tapping the chip) turns it off.
- **Look-ups:** any factual question nobody in the room can answer, or "Click, look that up and give us more detail." Click searches the web, answers in 2–4 sentences, says when things vary, and shows its sources.
  - **In free mode** (no Claude key), look-ups use Wikipedia instead: "Click, look up ___" reads a short summary in the asker's language, with a translated caption for the other person and a link. "Click, tell me more" continues with the next part of the same article; "Click, look up that" searches the last thing someone said. Free mode only understands simple look-up requests (other Click requests need the key).

Click never gives its own medical, legal, or financial advice, never contradicts a professional in the room, and says when it isn't sure.

Without a standing instruction, Click translates like a professional interpreter: complete and faithful, first person ("I", not "he says"), questions translated, never answered, and numbers, dates, and names exactly as said.

---

## One-time setup (already done once; repeat only for a new copy)

Nothing to install. GitHub holds the code, Vercel (free) runs the website, and Claude does the thinking.

1. **GitHub:** the repo must be **public**. Vercel's free plan won't deploy a private repo when someone other than the owner made the commit. The API key is never in the code, so public is safe.
2. **Vercel:** go to [vercel.com/new](https://vercel.com/new) → "Continue with GitHub" → **Import** this repo → leave all settings as they are → **Deploy**.
3. **Claude API key** (the only paid part):
   1. Go to [console.anthropic.com](https://console.anthropic.com), sign in, open **Billing** and add a small amount of credit.
   2. Open **API Keys** → **Create Key** → copy it (starts with `sk-ant-`). **Never paste it into the code or a chat.**
   3. In Vercel: open the project → **Settings** → **Environment Variables** → Key `ANTHROPIC_API_KEY`, Value: paste the key → **Save**.
   4. Go to **Deployments** → click **⋯** on the newest one → **Redeploy**. A new key only takes effect after a redeploy.

**No key?** Click still works in **free mode**: basic translation using Chrome's built-in on-device translator (desktop Chrome 138 or newer). Talking to Click, look-ups, and wrong-language detection need the key.

### Cost

Translation uses Claude's fastest model (Haiku): roughly 1/50 of a cent per sentence, so an hour of conversation costs a few cents. Talking to Click uses a stronger model (Sonnet): under 1 cent for a normal request, about 2–5 cents for a look-up (web search included). Everything else is free: Vercel's free plan, Chrome's speech recognition and voices.

---

## Making changes (with Claude Code; no terminal needed)

Ask Claude Code in this repo to make the change and push. Every push to `main` redeploys the live site in about 30 seconds. Refresh the page to see it.

| I want to… | Where |
|---|---|
| Add a language | One line in `public/js/config.js` → `LANGUAGES` |
| Make Click wait longer/shorter before translating | `TIMING.pauseMs` in `public/js/config.js` (800 = 0.8 s) |
| Change Click's voice speed or pitch, or how strongly voices are matched to speakers | `VOICE` in `public/js/config.js` |
| Change how Click translates or behaves | The two prompts in `lib/prompts.js` |
| Change which Claude models are used | `FAST_MODEL` / `SMART_MODEL` at the top of `api/turn.js` |
| Change the look | `public/style.css` (colors are at the top; dark mode right below) |

After changing prompts or models, open **/test.html** and press **Run all tests**.

### How it works (map of the files)

```
public/index.html      the page (start slide + conversation screen)
public/style.css       the look (light + dark mode)
public/js/app.js       conversation logic: who's talking, language checks, echo protection
public/js/ears.js      listening   (Chrome speech recognition)  ← swap for Galbot's own mic later
public/js/voice.js     speaking    (Chrome voices)              ← swap for voice cloning later
public/js/stage.js     the display (captions, orb, chips)       ← add a sign-language panel later
public/js/detector.js  automatic language detection (Whisper running in Chrome)
public/js/brain.js     talks to the server; free-mode fallback
public/js/lookup.js    free-mode look-ups (Wikipedia)
public/js/numbers.js   the number check
public/js/config.js    languages, timing, voice settings
public/test.html       the test page (not part of the app)
api/turn.js            the only server code: calls Claude and streams the answer back
lib/prompts.js         what Claude is told
lib/galbot-parser.js   splits Galbot's replies into spoken part / caption / chips
```

Every utterance goes to `/api/turn`. The fast model replies with a tag: **[T]** translate (it streams the translation right away), **[G]** addressed to Click (the server then asks the stronger model, with web search), **[R]** garbled, probably the wrong language (Click asks the person, in their language, to repeat), or **[N]** just noise. The browser speaks each sentence as soon as it's complete instead of waiting for the whole answer.

### Listening and the language problem

Chrome's free speech recognition can only listen for one language at a time, so on its own it can't tell who is talking. Click adds **automatic language detection** (`public/js/detector.js`): a small speech model (Whisper) that runs inside Chrome, free and private. It keeps the last 30 seconds of microphone audio and decides which of the two chosen languages was spoken:

- About a second into an utterance it checks; if Chrome is listening for the wrong language, Click switches on the spot so the live captions are right.
- At the end of the utterance it checks again. If it was the other language, Click writes the whole utterance down again in the right language and translates it the right way.

So the same person can pause and keep talking, or the other person can reply, and Click follows. The model (~100 MB) downloads once per computer the first time you press Begin. Until it's ready (and on any computer where it can't run), Click falls back to alternating languages and says so under the orb. If Claude is set up, it also spots garbled transcripts and asks the person to repeat.

Click never translates itself: while a translation plays, Click only listens for the *speaker's* language and checks by sound that it's really them (not Click's own voice from the speakers) before stopping; anything heard that matches what Click just said is ignored. Chrome sometimes stops recognition on its own, so Click restarts it automatically, and if the mic is blocked or missing it says so under the orb.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Microphone is blocked" | Click the icon left of the address bar → Microphone → Allow. Press End, then Begin. |
| Nothing happens when I talk | Check the laptop's input device in System Settings → Sound. If the note says language detection is off, tap the speaker's language button. |
| "Automatic language detection is off" | The speech model couldn't download (school or hotel Wi-Fi can block it). Try another network and reload. Click still works by alternating languages. |
| "Free translator: …" error | Press End, then Begin (Chrome only downloads its language packs right after a click). It also retries by itself on the next sentence. |
| "No ___ voice on this computer" | Captions still work. On a Mac: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices → download that language, then reload. |
| Free-mode note on the start screen | The API key isn't set (or the site wasn't redeployed after adding it). See setup step 3. |
| "The Claude API key is not valid" / "out of credit" | Fix the key or add credit in the Anthropic console, then redeploy in Vercel. |
| Translations are slow | Check the readout under each line. The first request after a while can be slower (the server wakes up). Normal is about 1 s to text. |
| Vercel says "deployment blocked" | The repo was made private. Make it public again (GitHub → Settings → bottom of the page). |

**Honest limits:** voices vary by computer (some languages, e.g. Tagalog, often have no voice on Macs, so they're captions only). The number check compares digits, so numbers spoken as words are not checked. Speech recognition needs an internet connection.

---

## Later (the code is ready for these, not built yet)

- **Sign language:** an avatar that signs translations and camera-based sign recognition. The page has an empty `#sign-panel` in the center column; recognition would be another kind of `ears`.
- **Real voice cloning (with consent, paid, e.g. ElevenLabs ~$6/month):** replace `createVoice()` in `public/js/voice.js` with an object that has the same methods. Today's free version only picks a similar-sounding built-in voice.
- **Galbot's own mic, speakers and screen:** `ears.js`, `voice.js` and `stage.js` are the only files that touch audio and display.
