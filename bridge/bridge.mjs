#!/usr/bin/env node
// Radio bridge: links one real walkie-talkie to a Walkie app channel.
//
//   radio speaker  -> USB sound card -> this bridge -> encrypted -> phones
//   phones -> encrypted -> this bridge -> USB sound card -> radio mic + PTT keyed
//
// Run it on a Raspberry Pi or any always-on computer with the radio plugged in through
// a USB audio + PTT cable such as the AIOC (All-In-One-Cable). See bridge/README.md.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { deriveChannel, seal, open } from '../public/crypto.js';
import { muLawEncode, MU_LAW_TABLE } from '../public/mulaw.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------

const env = process.env;
const cfg = {
  server: env.WALKIE_SERVER || 'ws://localhost:8080/ws',
  channel: Number(env.WALKIE_CHANNEL || 1),
  passcode: env.WALKIE_PASSCODE || (env.WALKIE_PASSCODE_FILE ? readFileSync(env.WALKIE_PASSCODE_FILE, 'utf8').trim() : ''),
  name: env.WALKIE_NAME || 'Radio bridge',
  // Raw audio in/out: signed 16-bit little-endian, 16 kHz, mono, on stdout/stdin.
  captureCmd: env.CAPTURE_CMD || 'arecord -q -D plughw:CARD=AllInOneCable,DEV=0 -f S16_LE -r 16000 -c 1 -t raw --buffer-time=40000',
  playbackCmd: env.PLAYBACK_CMD || 'aplay -q -D plughw:CARD=AllInOneCable,DEV=0 -f S16_LE -r 16000 -c 1 -t raw --buffer-time=80000',
  // How to key the radio: aioc (DTR on + RTS off), rts, dtr, vox (radio's own VOX), cmd.
  pttMode: env.PTT_MODE || 'aioc',
  pttDevice: env.PTT_DEVICE || '/dev/ttyACM0',
  pttOnCmd: env.PTT_ON_CMD || '',
  pttOffCmd: env.PTT_OFF_CMD || '',
  pttLeadMs: Number(env.PTT_LEAD_MS || 150),   // radio needs a moment after keying before audio
  pttTailMs: Number(env.PTT_TAIL_MS || 250),   // keep keyed until the last audio has played
  voxDb: Number(env.VOX_THRESHOLD_DB || -38),  // radio audio louder than this opens the bridge
  voxHangMs: Number(env.VOX_HANG_MS || 900),
  preRollMs: Number(env.PRE_ROLL_MS || 200),   // so the first syllable is not cut off
};

if (!cfg.passcode || cfg.passcode.length < 6) {
  console.error('Set WALKIE_PASSCODE (6+ characters, same as the phones) or WALKIE_PASSCODE_FILE.');
  process.exit(1);
}
if (!(cfg.channel >= 1 && cfg.channel <= 99)) {
  console.error('WALKIE_CHANNEL must be 1-99.');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const FRAME_AUDIO = 1, FRAME_NAME = 2;
const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
const FRAME_BYTES = FRAME_SAMPLES * 2;

// ---------- PTT ----------

function makePtt() {
  if (cfg.pttMode === 'vox') return { set() {} };
  if (cfg.pttMode === 'cmd') {
    return {
      set(on) {
        const cmd = on ? cfg.pttOnCmd : cfg.pttOffCmd;
        if (cmd) spawn('sh', ['-c', cmd], { stdio: 'ignore' });
      },
    };
  }
  // Serial line PTT through a tiny helper so we need no native Node modules.
  const helper = spawn('python3', [path.join(here, 'ptt.py'), cfg.pttDevice, cfg.pttMode], { stdio: ['pipe', 'inherit', 'inherit'] });
  helper.on('exit', code => { log(`PTT helper exited (${code}); check PTT_DEVICE`); process.exit(1); });
  return { set(on) { helper.stdin.write(on ? '1\n' : '0\n'); } };
}

const ptt = makePtt();

// ---------- audio processes ----------

function startProcess(cmd, stdio) {
  const p = spawn('sh', ['-c', cmd], { stdio });
  p.on('exit', code => { log(`Audio command exited (${code}): ${cmd}`); process.exit(1); });
  return p;
}

const player = startProcess(cfg.playbackCmd, ['pipe', 'ignore', 'inherit']);
player.stdin.on('error', () => {});
const recorder = startProcess(cfg.captureCmd, ['ignore', 'pipe', 'inherit']);

// ---------- channel connection ----------

const channel = await deriveChannel(cfg.channel, cfg.passcode);
let ws = null;
let joined = false;
let reconnectDelay = 500;
let busy = false;            // someone on the app is talking
let sendQueue = Promise.resolve();
let recvQueue = Promise.resolve();
let seq = 0;

function connect() {
  ws = new WebSocket(cfg.server, { perMessageDeflate: false });
  ws.binaryType = 'arraybuffer';
  ws.on('open', () => {
    reconnectDelay = 500;
    ws.send(JSON.stringify({ t: 'join', room: channel.roomId }));
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) { onAudioFromApp(data); return; }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg.t) {
      case 'joined':
        joined = true;
        busy = msg.busy;
        log(`Joined channel ${cfg.channel} (${msg.n} connected)`);
        break;
      case 'rx-start': busy = true; startKeying(); break;
      case 'rx-end': busy = false; scheduleUnkey(); break;
      case 'tx-granted': onGranted(); break;
      case 'tx-denied': tx = 'idle'; break;
      case 'tx-timeout': tx = 'idle'; log('Talk time limit hit, waiting for radio to go quiet'); txCooldown = true; break;
    }
  });
  ws.on('close', () => {
    joined = false;
    busy = false;
    tx = 'idle';
    scheduleUnkey();
    log(`Disconnected, retrying in ${reconnectDelay} ms`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  });
  ws.on('error', err => log('Connection error:', err.message));
}

function sendFrame(type, payload) {
  const sock = ws;
  const plain = new Uint8Array(3 + payload.length);
  plain[0] = type;
  plain[1] = seq >> 8;
  plain[2] = seq & 0xff;
  seq = (seq + 1) & 0xffff;
  plain.set(payload, 3);
  sendQueue = sendQueue
    .then(() => seal(channel, plain))
    .then(packet => { if (sock.readyState === 1 && sock.bufferedAmount < 16 * 1024) sock.send(packet); })
    .catch(() => {});
}

// ---------- app -> radio ----------

let keyed = false;
let keyedAt = 0;
let unkeyTimer = null;
let lastAppAudio = 0;
let pending = [];            // audio held back while the radio's transmitter comes up

function startKeying() {
  clearTimeout(unkeyTimer);
  if (keyed) return;
  keyed = true;
  keyedAt = Date.now();
  pending = [];
  ptt.set(true);
  log('App talking -> radio keyed');
  setTimeout(() => {
    for (const chunk of pending) player.stdin.write(chunk);
    pending = null;
  }, cfg.pttLeadMs);
}

function scheduleUnkey() {
  if (!keyed) return;
  clearTimeout(unkeyTimer);
  const leadLeft = Math.max(0, cfg.pttLeadMs - (Date.now() - keyedAt));
  unkeyTimer = setTimeout(() => {
    if (busy) return;
    keyed = false;
    ptt.set(false);
    voxMutedUntil = Date.now() + 400; // ignore the radio's own squelch tail
    log('Radio unkeyed');
  }, leadLeft + cfg.pttTailMs);
}

function onAudioFromApp(data) {
  recvQueue = recvQueue
    .then(() => open(channel, data))
    .then(plain => {
      if (!plain || plain.length < 3 || plain[0] !== FRAME_AUDIO) return;
      if (!keyed) startKeying();
      lastAppAudio = Date.now();
      const pcm = Buffer.alloc((plain.length - 3) * 2);
      for (let i = 3; i < plain.length; i++) {
        pcm.writeInt16LE(Math.round(MU_LAW_TABLE[plain[i]] * 32767), (i - 3) * 2);
      }
      if (pending) pending.push(pcm); else player.stdin.write(pcm);
    })
    .catch(() => {});
}

// ---------- radio -> app ----------

let tx = 'idle';             // idle | requesting | on
let txCooldown = false;
let voxMutedUntil = 0;
let lastLoud = 0;
let carry = Buffer.alloc(0);
const preRoll = [];
const PRE_ROLL_FRAMES = Math.ceil(cfg.preRollMs / 20);
const voxLevel = Math.pow(10, cfg.voxDb / 20);

function encodeFrame(buf) {
  const out = new Uint8Array(FRAME_SAMPLES);
  let sumSq = 0;
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sumSq += s * s;
    out[i] = muLawEncode(s);
  }
  return { mu: out, rms: Math.sqrt(sumSq / FRAME_SAMPLES) };
}

function onGranted() {
  if (tx !== 'requesting') { ws.send(JSON.stringify({ t: 'tx-end' })); return; }
  tx = 'on';
  sendFrame(FRAME_NAME, new TextEncoder().encode(cfg.name));
  for (const f of preRoll.splice(0)) sendFrame(FRAME_AUDIO, f);
  log('Radio talking -> sent to app');
}

function endTx() {
  if (tx === 'on') {
    sendQueue.then(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'tx-end' })));
    log('Radio quiet -> released channel');
  }
  tx = 'idle';
}

recorder.stdout.on('data', chunk => {
  carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
  while (carry.length >= FRAME_BYTES) {
    const { mu, rms } = encodeFrame(carry.subarray(0, FRAME_BYTES));
    carry = carry.subarray(FRAME_BYTES);
    const now = Date.now();
    // While we are transmitting app audio the radio cannot receive; ignore its input.
    const loud = !keyed && now >= voxMutedUntil && rms >= voxLevel;
    if (loud) lastLoud = now;
    const active = now - lastLoud < cfg.voxHangMs;

    if (tx === 'on') {
      sendFrame(FRAME_AUDIO, mu);
      if (!active) endTx();
      continue;
    }
    preRoll.push(mu);
    if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
    if (!active) txCooldown = false;
    if (loud && tx === 'idle' && !txCooldown && joined && !busy) {
      tx = 'requesting';
      ws.send(JSON.stringify({ t: 'tx-start' }));
    }
  }
});

function shutdown() {
  ptt.set(false);
  setTimeout(() => process.exit(0), 100);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log(`Bridge starting: channel ${cfg.channel}, PTT ${cfg.pttMode}, server ${cfg.server}`);
connect();
