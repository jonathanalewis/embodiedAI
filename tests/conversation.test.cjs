// Conversation tests: simulated people talking to the app in a real browser
// (free mode, no API key, no network). Run before changing anything in
// public/js/app.js, ears.js, detector.js, voice.js or lookup.js:
//
//   node tests/conversation.test.cjs
//
// Needs Playwright with Chromium (preinstalled in Claude Code cloud sessions).
// Fakes: speech recognition (a recognizer only hears words spoken while it
// runs, and outputs garbage in the wrong language), speech output, Chrome's
// translator, and the Whisper detector (tests/fake-whisper.mjs, which
// hallucinates "I'm sorry" if asked to transcribe the wrong language).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fakeLib = fs.readFileSync(path.join(__dirname, 'fake-whisper.mjs'), 'utf8');
const PORT = 3123;

const fakes = () => {
  window.__log = [];
  const log = (...a) => window.__log.push((performance.now()/1000).toFixed(2) + ' ' + a.join(' '));
  // A recognizer only hears words spoken while it is running. In the wrong
  // language it produces garbage, like Chrome does.
  class FakeSR {
    constructor() { this.heard = []; this.running = false; }
    start() { this.running = true; this.heard = []; window.__rec = this; log('rec.start', this.lang); setTimeout(() => this.onstart && this.onstart(), 30); }
    abort() { if (!this.running) return; this.running = false; log('rec.abort', this.lang); setTimeout(() => this.onend && this.onend(), 10); }
    stop() { this.abort(); }
    hear(word, lang) {
      this.heard.push(this.lang.startsWith(lang) ? word : 'garbl');
      const res = [{ transcript: this.heard.join(' '), confidence: 0 }]; res.isFinal = false;
      this.onresult({ results: [res] });
    }
    finish() { if (!this.heard.length) return; const res = [{ transcript: this.heard.join(' '), confidence: 0.8 }]; res.isFinal = true; this.onresult({ results: [res] }); }
  }
  Object.defineProperty(window, 'SpeechRecognition', { value: FakeSR, configurable: true, writable: true });
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: FakeSR, configurable: true, writable: true });
  // A person speaking: words over time, heard by whatever recognizer is on.
  window.__speak = async (lang, text, msPerWord = 160) => {
    window.__truth = { lang, text };
    log('PERSON', lang, JSON.stringify(text));
    for (const w of text.split(' ')) {
      const r = window.__rec;
      if (r && r.running) r.hear(w, lang);
      else log('  (mic off, lost:', w + ')');
      await new Promise(z => setTimeout(z, msPerWord));
    }
    const r = window.__rec; if (r && r.running) r.finish();
  };
  const voices = [{ name: 'Google US English', lang: 'en-US' }, { name: 'Samantha', lang: 'en-US' }, { name: 'Google español de Estados Unidos', lang: 'es-US' }, { name: 'Paulina', lang: 'es-MX' }];
  let queue = [];
  window.__ttsBusy = () => queue.length > 0;
  const synth = {
    getVoices: () => voices,
    speak(u) { if (!u.text) return; queue.push(u); log('TTS', u.lang, JSON.stringify(u.text)); if (queue.length === 1) play(); },
    cancel() { if (queue.length) log('TTS.cancel'); const q = queue; queue = []; q.forEach(u => u.onend && u.onend()); },
    resume() {}, addEventListener() {},
  };
  function play() { const u = queue[0]; if (!u) return; u.onstart && u.onstart(); setTimeout(() => { if (queue[0] !== u) return; queue.shift(); u.onend && u.onend(); play(); }, 400 + u.text.length * 40); }
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, writable: true, value: class { constructor(t) { this.text = t; } } });
  window.Translator = { availability: async () => 'available', create: async ({ targetLanguage: t }) => ({ translate: async (x) => `<${t}> ${x}` }) };
};

async function scenario(browser, name, { detectorWorks = true } = {}, steps) {
  if (process.env.ONLY && !name.startsWith(process.env.ONLY)) return true;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://cdn.jsdelivr.net/**', r => detectorWorks ? r.fulfill({ status: 200, contentType: 'text/javascript', body: fakeLib }) : r.fulfill({ status: 404, body: '' }));
  await page.addInitScript(fakes);
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForTimeout(400);
  await page.click('#begin');
  await page.waitForTimeout(1200);
  const h = {
    page,
    speak: (lang, text, ms) => page.evaluate(([l, t, m]) => window.__speak(l, t, m), [lang, text, ms || 160]),
    wait: (ms) => page.waitForTimeout(ms),
    quiet: async () => { // a person waits until Click is done and listening again, then pauses ~0.5 s
      await page.waitForTimeout(400);
      await page.waitForFunction(() => {
        const ok = !window.__ttsBusy() && window.__rec && window.__rec.running && document.querySelector('#orb').dataset.state === 'listening' && !document.querySelector('.line.interim, .line.pending');
        window.__okSince = ok ? (window.__okSince || performance.now()) : 0;
        return ok && performance.now() - window.__okSince > 200;
      }, null, { timeout: 30000, polling: 50 });
      await page.waitForTimeout(500);
    },
    lines: async (side) => (await page.locator(`#side-${side} .line .line-text`).allInnerTexts()),
    tts: async () => (await page.evaluate(() => window.__log)).filter(l => / TTS /.test(l)).map(l => l.replace(/^\S+ /, '')),
    log: async () => (await page.evaluate(() => window.__log)),
  };
  let problems = [];
  const expect = (cond, msg) => { if (!cond) problems.push(msg); };
  await steps(h, expect);
  const A = await h.lines('A'), B = await h.lines('B');
  const all = [...A, ...B].join(' | ');
  expect(!/sorry|siento/i.test(all), 'a hallucinated "I\'m sorry / Lo siento" appeared');
  expect(!/garbl/.test(all), 'garbled wrong-language text was shown or translated');
  if (errors.length) problems.push('page errors: ' + errors.join('; '));
  console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${name}`);
  if (problems.length || process.env.VERBOSE) {
    problems.forEach(p => console.log('   ✗', p));
    console.log('   A:', JSON.stringify(A)); console.log('   B:', JSON.stringify(B));
    console.log('   TTS:', JSON.stringify(await h.tts()));
    if (process.env.LOG) console.log((await h.log()).map(l => '     ' + l).join('\n'));
  }
  await ctx.close();
  return problems.length === 0;
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, 'dev-server.mjs')], { env: { ...process.env, PORT: String(PORT), ANTHROPIC_API_KEY: '' }, stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const results = [];

  results.push(await scenario(browser, '1. Reported bug: one English line, then several Spanish replies', {}, async (h, expect) => {
    await h.speak('en', 'hey how are you doing'); await h.quiet();
    await h.speak('es', 'muy bien gracias y tu'); await h.quiet();
    await h.speak('es', 'me llamo Ana'); await h.quiet();
    await h.speak('en', 'nice to meet you Ana'); await h.quiet();
    const A = await h.lines('A'), B = await h.lines('B');
    // The Spanish speaker's two quick replies are one person continuing: tacked on.
    expect(A.length === 3 && B.length === 3, `expected 3 messages per side, got A=${JSON.stringify(A)} B=${JSON.stringify(B)}`);
    expect(A[0] === 'hey how are you doing' && B[0] === '<es> hey how are you doing', 'first English line wrong');
    expect(B[1] === 'muy bien gracias y tu me llamo Ana', 'Spanish replies should be on the Spanish side, joined');
    expect(A[1] === '<en> muy bien gracias y tu <en> me llamo Ana', 'Spanish replies should be translated into English on the English side');
    expect(A[2] === 'nice to meet you Ana' && B[2] === '<es> nice to meet you Ana', 'last English line wrong');
    const tts = await h.tts();
    expect(tts.length === 4 && tts.filter(t => /muy bien/.test(t)).length === 1, `each part should be spoken exactly once: ${JSON.stringify(tts)}`);
  }));

  results.push(await scenario(browser, '1b. Same, but the Spanish speaker pauses longer between replies (separate messages)', {}, async (h, expect) => {
    await h.speak('en', 'hey how are you doing'); await h.quiet();
    await h.speak('es', 'muy bien gracias y tu'); await h.quiet();
    await h.wait(5000);
    await h.speak('es', 'me llamo Ana'); await h.quiet();
    const A = await h.lines('A'), B = await h.lines('B');
    expect(B.length === 3 && B[2] === 'me llamo Ana' && A[2] === '<en> me llamo Ana', `later Spanish reply should be its own message: A=${JSON.stringify(A)} B=${JSON.stringify(B)}`);
  }));

  results.push(await scenario(browser, '2. Same person adds more right after the translation (tacked on, not repeated)', {}, async (h, expect) => {
    await h.speak('en', 'the train leaves at seven'); await h.quiet();
    await h.speak('en', 'and it costs twenty dollars'); await h.quiet();
    const A = await h.lines('A'), B = await h.lines('B');
    expect(A.length === 1 && A[0] === 'the train leaves at seven and it costs twenty dollars', `English should be one combined line: ${JSON.stringify(A)}`);
    expect(B.length === 1 && B[0] === '<es> the train leaves at seven <es> and it costs twenty dollars', `Spanish should be one line with the add-on appended: ${JSON.stringify(B)}`);
    const tts = await h.tts();
    expect(tts.length === 2 && /and it costs/.test(tts[1]) && !/train/.test(tts[1]), `the add-on must speak only the new part: ${JSON.stringify(tts)}`);
  }));

  results.push(await scenario(browser, '3. Other person replies immediately (not tacked on)', {}, async (h, expect) => {
    await h.speak('en', 'where is the station'); await h.quiet();
    await h.speak('es', 'esta a dos calles'); await h.quiet();
    const A = await h.lines('A'), B = await h.lines('B');
    expect(A.length === 2 && B.length === 2, `expected 2 separate messages, got A=${JSON.stringify(A)} B=${JSON.stringify(B)}`);
    expect(B[1] === 'esta a dos calles', 'Spanish reply should be its own line on the Spanish side');
  }));

  results.push(await scenario(browser, '4. Interrupt with Space while Click is talking, then add more', {}, async (h, expect) => {
    await h.speak('en', 'please wait here until the doctor calls your name and then go to room four');
    await h.page.waitForFunction(() => window.__ttsBusy(), null, { timeout: 10000 });
    await h.wait(300);
    await h.page.keyboard.press('Space');
    await h.wait(900);
    await h.speak('en', 'and bring your card'); await h.quiet();
    const A = await h.lines('A'), B = await h.lines('B');
    expect(A.length === 1 && /room four and bring your card$/.test(A[0]), `English should be one line ending with the add-on: ${JSON.stringify(A)}`);
    expect(B.length === 1 && /<es> and bring your card$/.test(B[0]), `Spanish should have the add-on tacked on: ${JSON.stringify(B)}`);
    const log = await h.log();
    expect(log.some(l => l.endsWith('TTS.cancel')), 'speech was not stopped by Space');
    const tts = await h.tts();
    expect(/and bring your card/.test(tts.at(-1)) && !/doctor/.test(tts.at(-1)), `after the interrupt only the new part should be spoken: ${JSON.stringify(tts)}`);
  }));

  results.push(await scenario(browser, '5. Same person speaks again later (wrong guess fixed, new message)', {}, async (h, expect) => {
    await h.speak('en', 'thank you so much'); await h.quiet();
    await h.wait(5000); // longer than the add-on window
    await h.speak('en', 'can I ask you one more question please'); await h.quiet();
    const A = await h.lines('A'), B = await h.lines('B');
    expect(A.length === 2 && A[1] === 'can I ask you one more question please', `second English message should be its own, correctly transcribed line: ${JSON.stringify(A)}`);
    expect(B.length === 2 && B[1] === '<es> can I ask you one more question please', `and translated into Spanish: ${JSON.stringify(B)}`);
  }));

  results.push(await scenario(browser, '6. Detector unavailable: alternating languages still works, nothing merged', { detectorWorks: false }, async (h, expect) => {
    await h.speak('en', 'good morning'); await h.quiet();
    await h.speak('es', 'buenos dias'); await h.quiet();
    await h.speak('en', 'how can I help'); await h.quiet();
    const A = await h.lines('A'), B = await h.lines('B');
    expect(A.length === 3 && B.length === 3, `expected 3 messages, got A=${JSON.stringify(A)} B=${JSON.stringify(B)}`);
    expect(B[1] === 'buenos dias' && A[1] === '<en> buenos dias', 'Spanish reply wrong');
  }));

  results.push(await scenario(browser, '7. Two people back and forth, six turns', {}, async (h, expect) => {
    const turns = [['en', 'hi there'], ['es', 'hola'], ['en', 'do you need help'], ['es', 'si por favor'], ['es', 'busco la farmacia'], ['en', 'it is on the left']];
    for (const [l, t] of turns) { await h.speak(l, t); await h.quiet(); }
    const A = await h.lines('A'), B = await h.lines('B');
    // "si por favor" and "busco la farmacia" are the same person within seconds: tacked on.
    expect(B.includes('si por favor busco la farmacia') || (B.includes('si por favor') && B.includes('busco la farmacia')), `Spanish lines wrong: ${JSON.stringify(B)}`);
    expect(A.at(-1) === 'it is on the left' && B.at(-1) === '<es> it is on the left', 'last English line wrong');
    expect(!A.some(x => /^(hola|si|busco)/.test(x)) && !B.some(x => /^(hi|do you|it is)/.test(x)), 'an original showed up on the wrong side');
  }));

  results.push(await scenario(browser, '8. Click hears its own voice echo: ignored', {}, async (h, expect) => {
    await h.speak('en', 'the museum opens at nine'); await h.quiet();
    await h.speak('es', '<es> the museum opens at nine'); await h.quiet(); // the room echoes the translation
    const A = await h.lines('A'), B = await h.lines('B');
    expect(A.length === 1 && B.length === 1, `the echo must be ignored: A=${JSON.stringify(A)} B=${JSON.stringify(B)}`);
  }));

  results.push(await scenario(browser, '9. Very short Spanish reply when Click expected English', {}, async (h, expect) => {
    await h.speak('en', 'is this your bag'); await h.quiet();
    await h.speak('es', 'si'); await h.quiet();             // expected (Spanish), fine
    await h.wait(5000);
    await h.speak('es', 'gracias', 160); await h.quiet();    // Click guessed English this time
    const A = await h.lines('A'), B = await h.lines('B');
    expect(B.includes('gracias') && A.includes('<en> gracias'), `short Spanish reply should land on the Spanish side: A=${JSON.stringify(A)} B=${JSON.stringify(B)}`);
  }));

  results.push(await scenario(browser, '10. "Hey Click" look-up in the middle, then the conversation continues', {}, async (h, expect) => {
    await h.page.route(/wikipedia\.org/, (r) => {
      const u = new URL(r.request().url());
      const body = u.searchParams.get('list') === 'search'
        ? { query: { search: [{ title: 'Louvre' }] } }
        : { query: { pages: { 1: { title: 'Louvre', fullurl: 'https://en.wikipedia.org/wiki/Louvre', extract: 'The Louvre is an art museum in Paris. It is the most visited museum in the world.' } } } };
      r.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    });
    await h.speak('en', 'we are going to the Louvre'); await h.quiet();
    await h.speak('en', 'hey click look up the Louvre'); await h.quiet();
    await h.speak('es', 'que bien me encanta'); await h.quiet();
    const A = await h.lines('A'), B = await h.lines('B');
    expect(A.some(x => /The Louvre is an art museum/.test(x)), `Click's answer should be spoken to the asker in English: ${JSON.stringify(A)}`);
    expect(B.some(x => /<es> The Louvre is an art museum/.test(x)), `the other person should get a Spanish caption: ${JSON.stringify(B)}`);
    expect(B.at(-1) === 'que bien me encanta' && A.at(-1) === '<en> que bien me encanta', `the Spanish reply after the look-up should be its own message: A=${JSON.stringify(A)} B=${JSON.stringify(B)}`);
    const tts = await h.tts();
    expect(tts.filter(t => /Louvre is an art/.test(t)).length === 1, `the look-up answer should be spoken once, to one person: ${JSON.stringify(tts)}`);
  }));

  results.push(await scenario(browser, '11. Tapping the orb when Click is not talking does nothing harmful', {}, async (h, expect) => {
    await h.page.click('#orb'); await h.wait(300); await h.page.keyboard.press('Space'); await h.wait(800);
    await h.speak('en', 'hello there'); await h.quiet();
    await h.speak('es', 'hola'); await h.quiet();
    const A = await h.lines('A'), B = await h.lines('B');
    expect(A.length === 2 && B.length === 2 && B[1] === 'hola', `normal conversation expected: A=${JSON.stringify(A)} B=${JSON.stringify(B)}`);
  }));

  results.push(await scenario(browser, '12. After an interrupt, the OTHER person answers instead (not tacked on)', {}, async (h, expect) => {
    await h.speak('en', 'please fill in this form with your name address and phone number');
    await h.page.waitForFunction(() => window.__ttsBusy(), null, { timeout: 10000 });
    await h.wait(300);
    await h.page.keyboard.press('Space');
    await h.wait(900);
    await h.speak('es', 'ya lo hice esta manana'); await h.quiet();
    const A = await h.lines('A'), B = await h.lines('B');
    expect(B.at(-1) === 'ya lo hice esta manana' && A.at(-1) === '<en> ya lo hice esta manana', `the Spanish answer should be its own message: A=${JSON.stringify(A)} B=${JSON.stringify(B)}`);
    expect(A.length === 2, 'the English message must not get Spanish tacked on');
  }));

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} scenarios passed`);
  await browser.close();
  server.kill();
  process.exit(passed === results.length ? 0 : 1);
})();
