// End-to-end test: server + radio bridge (with a fake radio) + three phones in Chromium.
// Run: npm test   (needs Playwright; set PLAYWRIGHT_MODULE if it is not resolvable)

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'walkie-e2e-'));
const PORT = 18080 + Math.floor(Math.random() * 1000);
const URL_ = `http://localhost:${PORT}/`;
const radioFlag = path.join(tmp, 'radio-talking');
const radioOut = path.join(tmp, 'radio-speaker.raw');
const pttLog = path.join(tmp, 'ptt.log');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(50); }
  return false;
}

function run(cmd, args, env = {}) {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.output = '';
  p.stdout.on('data', d => { p.output += d; });
  p.stderr.on('data', d => { p.output += d; });
  procs.push(p);
  return p;
}

const server = run('node', ['server.js'], { PORT: String(PORT) });
await waitFor(() => server.output.includes('Walkie server'));

writeFileSync(radioOut, '');
writeFileSync(pttLog, '');
const bridge = run('node', ['bridge/bridge.mjs'], {
  WALKIE_SERVER: `ws://localhost:${PORT}/ws`,
  WALKIE_CHANNEL: '5',
  WALKIE_PASSCODE: 'secret123',
  CAPTURE_CMD: `node test/fake-radio.mjs capture ${radioFlag}`,
  PLAYBACK_CMD: `cat > ${radioOut}`,
  PTT_MODE: 'cmd',
  PTT_ON_CMD: `echo on >> ${pttLog}`,
  PTT_OFF_CMD: `echo off >> ${pttLog}`,
});
check('bridge joins channel', await waitFor(() => bridge.output.includes('Joined channel 5')), bridge.output.trim().split('\n').pop());

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

async function phone(name, channel, passcode) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.addInitScript(s => localStorage.setItem('walkie-settings', JSON.stringify(s)), { name, channel, passcode });
  await page.goto(URL_);
  await page.click('#btn-allow');
  await page.waitForFunction(() => document.querySelector('#sub').textContent.includes('on channel'));
  return page;
}
const stats = p => p.evaluate(() => ({ ...window.walkieStats }));
const screenState = p => p.evaluate(() => document.querySelector('#state').textContent);

const alice = await phone('Alice', 5, 'secret123');
const bob = await phone('Bob', 5, 'secret123');
const eve = await phone('Eve', 5, 'wrongpass1');

check('phones with the right passcode see each other and the bridge',
  await waitFor(async () => (await bob.textContent('#sub')).includes('3 on channel')), await bob.textContent('#sub'));
check('phone with the wrong passcode is on its own',
  (await eve.textContent('#sub')).includes('1 on channel'), await eve.textContent('#sub'));

// 1. Phone to phone (and radio)
const pressAt = await alice.evaluate(() => Date.now());
await alice.hover('#btn-talk');
await alice.mouse.down();
check('Alice screen shows TX', await waitFor(async () => (await screenState(alice)) === 'TX'));
check('Bob screen shows RX from Alice', await waitFor(async () => (await screenState(bob)) === 'RX' && (await bob.textContent('#sub')) === 'Alice'));
await waitFor(async () => (await stats(bob)).rxFrames > 0);
const firstRx = (await stats(bob)).lastRxAt;

// Bob tries to talk over Alice
await bob.hover('#btn-talk');
await bob.mouse.down();
await sleep(300);
check('Bob is blocked while Alice talks', (await stats(bob)).txFrames === 0 && (await screenState(bob)) === 'RX');
await bob.mouse.up();

await sleep(1700);
await alice.mouse.up();
await sleep(600);
const a1 = await stats(alice), b1 = await stats(bob), e1 = await stats(eve);
check('Alice sent ~2 s of audio', a1.txFrames >= 80, `${a1.txFrames} frames`);
check('Bob received Alice\'s audio', b1.rxFrames >= a1.txFrames - 5 && b1.rxBadFrames === 0, `${b1.rxFrames} frames`);
check('Eve (wrong passcode) heard nothing', e1.rxFrames === 0 && e1.rxBadFrames === 0, `${e1.rxFrames} frames`);
check('press-to-first-audio delay is low', firstRx - pressAt < 250, `${firstRx - pressAt} ms on localhost`);
check('Bob screen back to READY', (await screenState(bob)) === 'READY');

const radioBytes = statSync(radioOut).size;
check('radio speaker got Alice\'s audio through the bridge', radioBytes >= 16000 * 2 * 1.5, `${(radioBytes / 32000).toFixed(2)} s`);
const ptt = readFileSync(pttLog, 'utf8').trim().split('\n');
check('radio PTT keyed then released', ptt.join(',') === 'on,off', ptt.join(','));

// 2. Radio to phones
writeFileSync(radioFlag, '1');
check('Alice hears the radio', await waitFor(async () => (await screenState(alice)) === 'RX' && (await alice.textContent('#sub')) === 'Radio bridge'));
await sleep(1500);
rmSync(radioFlag);
check('channel frees after the radio goes quiet', await waitFor(async () => (await screenState(alice)) === 'READY', 3000));
const a2 = await stats(alice), b2 = await stats(bob), e2 = await stats(eve);
check('Alice got radio audio', a2.rxFrames >= 70, `${a2.rxFrames} frames`);
check('Bob got radio audio', b2.rxFrames - b1.rxFrames >= 70, `${b2.rxFrames - b1.rxFrames} frames`);
check('Eve still heard nothing', e2.rxFrames === 0);
check('bridge did not key the radio for its own audio', readFileSync(pttLog, 'utf8').trim().split('\n').length === 2);

// 3. Channel switching keeps channels apart
await bob.click('[data-key="7"]');
await bob.click('[data-key="ok"]');
await waitFor(async () => (await bob.textContent('#ch-num')) === '07');
await sleep(400);
await alice.hover('#btn-talk');
await alice.mouse.down();
await sleep(800);
await alice.mouse.up();
await sleep(400);
check('Bob on channel 7 does not hear channel 5', (await stats(bob)).rxFrames === b2.rxFrames);

// 4. Effects and recording work without errors
await alice.click('#btn-rec');
await alice.click('#btn-siren');
await sleep(500);
await alice.click('#btn-stop');
check('PLAY enabled after recording', await waitFor(() => alice.isEnabled('#btn-play')));
await alice.screenshot({ path: path.join(tmp, 'alice.png') });

for (const [n, p] of [['Alice', alice], ['Bob', bob], ['Eve', eve]]) {
  check(`${n} page has no errors`, p.errors.length === 0, p.errors.join(' | '));
}

// 5. Reconnect after the server restarts
server.kill();
check('phone shows NO SIGNAL when server is down', await waitFor(async () => (await screenState(alice)) === 'NO SIGNAL'));
const server2 = run('node', ['server.js'], { PORT: String(PORT) });
await waitFor(() => server2.output.includes('Walkie server'));
check('phone reconnects by itself', await waitFor(async () => (await screenState(alice)) === 'READY', 12000));
check('bridge reconnects by itself', await waitFor(() => (bridge.output.match(/Joined channel 5/g) || []).length >= 2, 12000));

console.log(`\nScreenshot: ${path.join(tmp, 'alice.png')}`);
await browser.close();
procs.forEach(p => p.kill());
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
