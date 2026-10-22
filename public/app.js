import { deriveChannel, seal, open } from './crypto.js';
import * as sfx from './sounds.js';

const FRAME_AUDIO = 1;
const FRAME_NAME = 2;

const $ = id => document.getElementById(id);
const els = {
  allow: $('btn-allow'), display: $('display'), state: $('state'), sub: $('sub'), ch: $('ch-num'),
  led: $('led'), hint: $('hint'), latency: $('latency'), bars: $('bars'),
  talk: $('btn-talk'), pttSide: $('ptt-side'), stop: $('btn-stop'), play: $('btn-play'), rec: $('btn-rec'),
  lights: $('btn-lights'), wail: $('btn-wail'), siren: $('btn-siren'), man: $('btn-man'), horn: $('btn-horn'),
  dialog: $('settings'), form: $('settings-form'),
};

// ---------- settings ----------

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('walkie-settings')) || {};
  } catch {
    return {};
  }
}
function saveSettings() {
  try { localStorage.setItem('walkie-settings', JSON.stringify(settings)); } catch {}
}
const settings = { name: '', channel: 1, passcode: '', ...loadSettings() };

// ---------- state ----------

const st = {
  ctx: null, mic: null, micGain: null, fxToTx: null, fxBus: null, master: null, recDest: null,
  capture: null, player: null, megaphone: null,
  ws: null, wsReady: false, reconnectDelay: 500, channel: null,
  holding: false, tx: 'idle', // idle | requesting | on | ending
  rxName: '', busy: false, members: 0,
  effects: {}, recorder: null, recChunks: [], recording: null, playback: null,
  sendQueue: Promise.resolve(), recvQueue: Promise.resolve(), seq: 0,
  wakeLock: null, pingTimer: null, digits: '',
};

// Counters for diagnostics and automated tests.
const stats = { txFrames: 0, rxFrames: 0, rxBadFrames: 0, lastRxName: '', lastRxAt: 0 };
window.walkieStats = stats;

// ---------- screen ----------

function render() {
  els.ch.textContent = String(settings.channel).padStart(2, '0');
  const d = els.display;
  d.classList.remove('tx', 'rx', 'busy', 'offline');
  let state = 'READY', sub = settings.name ? `${settings.name} · ${st.members} on channel` : '';
  if (st.digits) {
    state = `CH ${st.digits.padEnd(2, '_')}`;
    sub = 'Press OK to switch';
  } else if (!st.wsReady) {
    d.classList.add('offline');
    state = 'NO SIGNAL';
    sub = 'Reconnecting…';
  } else if (st.tx === 'on' || st.tx === 'ending') {
    d.classList.add('tx');
    state = 'TX';
    sub = 'Talking…';
  } else if (st.tx === 'requesting') {
    state = '…';
  } else if (st.busy) {
    d.classList.add('rx');
    state = 'RX';
    sub = st.rxName || 'Incoming';
  }
  els.state.textContent = state;
  els.sub.textContent = sub || ' ';
  els.led.className = 'led' + (st.tx === 'on' ? ' tx' : st.busy ? ' rx' : '');
  const talking = st.tx === 'on' || st.tx === 'requesting';
  els.talk.classList.toggle('on', talking);
  els.pttSide.classList.toggle('on', talking);
}

function flashHint(text) {
  els.hint.textContent = text;
  clearTimeout(flashHint.t);
  flashHint.t = setTimeout(() => { els.hint.textContent = 'Hold TALKIE to talk'; }, 3000);
}

// ---------- audio graph ----------

async function startAudio() {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  st.ctx = ctx;
  await ctx.audioWorklet.addModule('worklet.js');

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  st.mic = ctx.createMediaStreamSource(stream);

  st.master = ctx.createGain();
  st.master.connect(ctx.destination);
  st.recDest = ctx.createMediaStreamDestination();
  st.master.connect(st.recDest);

  // Everything we transmit goes through txBus into the capture worklet.
  const txBus = ctx.createGain();
  st.micGain = ctx.createGain();
  st.micGain.gain.value = 0;
  st.mic.connect(st.micGain).connect(txBus);
  st.micGain.connect(st.recDest);

  // Sound effects play locally and are also sent while transmitting.
  st.fxBus = ctx.createGain();
  st.fxBus.connect(st.master);
  st.fxToTx = ctx.createGain();
  st.fxToTx.gain.value = 0;
  st.fxBus.connect(st.fxToTx).connect(txBus);

  st.capture = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  txBus.connect(st.capture);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  st.capture.connect(sink).connect(ctx.destination); // keeps the worklet running
  st.capture.port.onmessage = e => sendAudio(e.data);

  st.player = new AudioWorkletNode(ctx, 'player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  st.player.connect(st.master);

  const mega = sfx.megaphoneChain(ctx);
  const megaGain = ctx.createGain();
  megaGain.gain.value = 0;
  st.mic.connect(mega.input);
  mega.output.connect(megaGain).connect(st.master);
  st.megaphone = megaGain;

  if (ctx.state === 'suspended') await ctx.resume();
}

// iOS suspends audio when the app goes to the background; resume on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (st.ctx && st.ctx.state !== 'running') st.ctx.resume();
    requestWakeLock();
    if (!st.ws && st.channel) connect();
  }
});

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !st.wakeLock) {
      st.wakeLock = await navigator.wakeLock.request('screen');
      st.wakeLock.addEventListener('release', () => { st.wakeLock = null; });
    }
  } catch {}
}

// ---------- network ----------

function wsUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

async function joinChannel() {
  st.digits = '';
  els.hint.textContent = 'Securing channel…';
  st.channel = await deriveChannel(settings.channel, settings.passcode);
  st.members = 0;
  st.busy = false;
  if (st.ws && st.wsReady) st.ws.send(JSON.stringify({ t: 'join', room: st.channel.roomId }));
  else connect();
  els.hint.textContent = 'Hold TALKIE to talk';
  render();
}

function connect() {
  if (st.ws) return;
  const ws = new WebSocket(wsUrl());
  ws.binaryType = 'arraybuffer';
  st.ws = ws;

  ws.onopen = () => {
    st.wsReady = true;
    st.reconnectDelay = 500;
    if (st.channel) ws.send(JSON.stringify({ t: 'join', room: st.channel.roomId }));
    clearInterval(st.pingTimer);
    const ping = () => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'ping', ts: performance.now() }));
    ping();
    st.pingTimer = setInterval(ping, 4000);
    render();
  };

  ws.onclose = () => {
    st.ws = null;
    st.wsReady = false;
    st.busy = false;
    clearInterval(st.pingTimer);
    if (st.tx !== 'idle') stopTx(false);
    els.bars.dataset.level = '0';
    els.latency.textContent = '--';
    render();
    setTimeout(connect, st.reconnectDelay);
    st.reconnectDelay = Math.min(st.reconnectDelay * 2, 8000);
  };

  ws.onmessage = e => {
    if (typeof e.data !== 'string') { receiveFrame(e.data); return; }
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    switch (msg.t) {
      case 'joined':
        st.members = msg.n;
        st.busy = msg.busy;
        break;
      case 'count':
        st.members = msg.n;
        break;
      case 'rx-start':
        st.busy = true;
        st.rxName = '';
        sfx.squelch(st.ctx, st.master, 0.08);
        break;
      case 'rx-end':
        st.busy = false;
        setTimeout(() => sfx.squelch(st.ctx, st.master, 0.12), 120);
        break;
      case 'tx-granted':
        onTxGranted();
        break;
      case 'tx-denied':
        st.tx = 'idle';
        sfx.busyTone(st.ctx, st.master);
        flashHint('Channel busy, wait for them to finish');
        break;
      case 'tx-timeout':
        stopTx(false);
        flashHint('Talk time limit reached (60 s)');
        break;
      case 'pong': {
        const ms = Math.round(performance.now() - msg.ts);
        els.latency.textContent = `${ms} ms`;
        els.bars.dataset.level = ms < 80 ? '4' : ms < 160 ? '3' : ms < 300 ? '2' : '1';
        break;
      }
      case 'error':
        flashHint(msg.error === 'room-full' ? 'Channel is full' : 'Could not join channel');
        break;
    }
    render();
  };
}

function sendFrame(type, payload) {
  const ws = st.ws, channel = st.channel;
  if (!ws || !channel) return;
  const plain = new Uint8Array(3 + payload.length);
  plain[0] = type;
  plain[1] = st.seq >> 8;
  plain[2] = st.seq & 0xff;
  st.seq = (st.seq + 1) & 0xffff;
  plain.set(payload, 3);
  // Chain encryptions so frames always leave in order.
  st.sendQueue = st.sendQueue
    .then(() => seal(channel, plain))
    .then(packet => {
      if (ws.readyState === 1 && ws.bufferedAmount < 16 * 1024) { ws.send(packet); if (type === FRAME_AUDIO) stats.txFrames++; }
    })
    .catch(() => {});
}

function sendAudio(frame) {
  if (st.tx === 'on' || st.tx === 'ending') sendFrame(FRAME_AUDIO, frame);
}

function receiveFrame(data) {
  const channel = st.channel;
  if (!channel) return;
  st.recvQueue = st.recvQueue
    .then(() => open(channel, data))
    .then(plain => {
      if (!plain || plain.length < 3) { stats.rxBadFrames++; return; }
      if (plain[0] === FRAME_AUDIO) {
        stats.rxFrames++;
        stats.lastRxAt = Date.now();
        const audio = plain.slice(3);
        st.player.port.postMessage(audio, [audio.buffer]);
      } else if (plain[0] === FRAME_NAME) {
        st.rxName = new TextDecoder().decode(plain.subarray(3)).slice(0, 20);
        stats.lastRxName = st.rxName;
        render();
      }
    })
    .catch(() => {});
}

// ---------- push to talk ----------

function startTx() {
  st.holding = true;
  if (!st.ctx) { flashHint('Tap “Allow mic” first'); return; }
  if (!st.wsReady || !st.channel) { flashHint('No signal yet'); return; }
  if (st.tx !== 'idle') return;
  if (st.busy) { sfx.busyTone(st.ctx, st.master); flashHint('Channel busy'); return; }
  if (navigator.vibrate) navigator.vibrate(15);
  st.tx = 'requesting';
  st.ws.send(JSON.stringify({ t: 'tx-start' }));
  render();
}

function onTxGranted() {
  if (!st.holding) {
    st.ws && st.ws.send(JSON.stringify({ t: 'tx-end' }));
    st.tx = 'idle';
    return;
  }
  st.tx = 'on';
  st.player.port.postMessage('reset');
  sendFrame(FRAME_NAME, new TextEncoder().encode(settings.name || 'Unknown'));
  st.micGain.gain.setTargetAtTime(1, st.ctx.currentTime, 0.005);
  st.fxToTx.gain.value = 1;
  st.capture.port.postMessage({ active: true });
}

function releaseTx() {
  st.holding = false;
  if (st.tx === 'on') stopTx(true);
}

function stopTx(withRoger) {
  const finish = () => {
    st.capture.port.postMessage({ active: false });
    st.fxToTx.gain.value = 0;
    if (st.ws && st.ws.readyState === 1) {
      // Let the last encrypted frames go out before releasing the channel.
      st.sendQueue.then(() => st.ws && st.ws.send(JSON.stringify({ t: 'tx-end' })));
    }
    st.tx = 'idle';
    render();
  };
  if (!st.ctx) return;
  st.micGain.gain.setTargetAtTime(0, st.ctx.currentTime, 0.005);
  if (withRoger && st.tx === 'on') {
    st.tx = 'ending';
    const ms = sfx.rogerBeep(st.ctx, st.fxBus);
    setTimeout(finish, ms + 40);
  } else {
    finish();
  }
  render();
}

function bindHold(el, down, up) {
  el.addEventListener('pointerdown', e => { e.preventDefault(); el.setPointerCapture?.(e.pointerId); down(); });
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('contextmenu', e => e.preventDefault());
}
bindHold(els.talk, startTx, releaseTx);
bindHold(els.pttSide, startTx, releaseTx);

// Space bar or headset button on desktop/Bluetooth keyboards.
window.addEventListener('keydown', e => {
  if (e.code === 'Space' && !e.repeat && !els.dialog.open) { e.preventDefault(); startTx(); }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space' && !els.dialog.open) { e.preventDefault(); releaseTx(); }
});

// ---------- effects ----------

function toggleEffect(name, btn, make) {
  if (!st.ctx) { flashHint('Tap “Allow mic” first'); return; }
  if (st.effects[name]) {
    st.effects[name]();
    delete st.effects[name];
    btn.classList.remove('on');
  } else {
    st.effects[name] = make(st.ctx, st.fxBus);
    btn.classList.add('on');
  }
}

els.siren.addEventListener('click', () => toggleEffect('siren', els.siren, sfx.sirenHiLo));
els.wail.addEventListener('click', () => toggleEffect('wail', els.wail, sfx.sirenWail));
bindHold(els.horn, () => {
  if (!st.ctx) return flashHint('Tap “Allow mic” first');
  if (!st.effects.horn) { st.effects.horn = sfx.airHorn(st.ctx, st.fxBus); els.horn.classList.add('on'); }
}, () => {
  if (st.effects.horn) { st.effects.horn(); delete st.effects.horn; els.horn.classList.remove('on'); }
});

els.lights.addEventListener('click', () => {
  const on = document.body.classList.toggle('lights');
  els.lights.classList.toggle('on', on);
});

els.man.addEventListener('click', () => {
  if (!st.ctx) return flashHint('Tap “Allow mic” first');
  const on = !els.man.classList.contains('on');
  els.man.classList.toggle('on', on);
  st.megaphone.gain.setTargetAtTime(on ? 1 : 0, st.ctx.currentTime, 0.01);
  if (on) flashHint('Megaphone on: speak into the phone. Keep the volume low to avoid feedback.');
});

// ---------- record / play ----------

els.rec.addEventListener('click', () => {
  if (!st.ctx) return flashHint('Tap “Allow mic” first');
  if (st.recorder) {
    st.recorder.stop();
    return;
  }
  if (typeof MediaRecorder === 'undefined') return flashHint('Recording is not supported on this phone');
  st.recChunks = [];
  const rec = new MediaRecorder(st.recDest.stream);
  rec.ondataavailable = e => e.data.size && st.recChunks.push(e.data);
  rec.onstop = () => {
    if (st.recording) URL.revokeObjectURL(st.recording);
    st.recording = URL.createObjectURL(new Blob(st.recChunks, { type: rec.mimeType }));
    st.recorder = null;
    els.rec.classList.remove('on');
    els.play.disabled = false;
    flashHint('Recording saved. Tap PLAY to hear it.');
  };
  rec.start();
  st.recorder = rec;
  els.rec.classList.add('on');
  flashHint('Recording the channel… tap REC again to stop');
});

els.play.addEventListener('click', () => {
  if (!st.recording) return;
  if (st.playback) { stopPlayback(); return; }
  const audio = new Audio(st.recording);
  st.playback = audio;
  els.play.classList.add('on');
  audio.onended = stopPlayback;
  audio.play().catch(stopPlayback);
});

function stopPlayback() {
  if (!st.playback) return;
  st.playback.pause();
  st.playback = null;
  els.play.classList.remove('on');
}

els.stop.addEventListener('click', () => {
  Object.values(st.effects).forEach(stop => stop());
  st.effects = {};
  [els.siren, els.wail, els.horn, els.lights, els.man].forEach(b => b.classList.remove('on'));
  document.body.classList.remove('lights');
  if (st.megaphone) st.megaphone.gain.value = 0;
  if (st.recorder) st.recorder.stop();
  stopPlayback();
  if (st.tx !== 'idle') { st.holding = false; stopTx(false); }
});

// ---------- keypad and settings ----------

document.querySelectorAll('[data-key]').forEach(btn => {
  btn.addEventListener('click', () => {
    const k = btn.dataset.key;
    if (/^\d$/.test(k)) {
      st.digits = (st.digits + k).slice(-2);
      render();
    } else if (k === 'ok') {
      const n = parseInt(st.digits, 10);
      st.digits = '';
      if (n >= 1 && n <= 99) setChannel(n); else render();
    } else if (k === 'up' || k === 'down') {
      setChannel(((settings.channel - 1 + (k === 'up' ? 1 : 98)) % 99) + 1);
    } else if (k === 'menu' || k === 'settings') {
      openSettings();
    }
  });
});

function setChannel(n) {
  if (n === settings.channel) { render(); return; }
  if (st.tx !== 'idle') { st.holding = false; stopTx(false); }
  settings.channel = n;
  saveSettings();
  if (st.ctx) joinChannel(); else render();
}

function openSettings() {
  const f = els.form.elements;
  f.name.value = settings.name;
  f.channel.value = settings.channel;
  f.passcode.value = settings.passcode;
  els.dialog.showModal();
}

els.dialog.addEventListener('close', () => {
  if (els.dialog.returnValue !== 'save') return;
  const f = els.form.elements;
  settings.name = f.name.value.trim().slice(0, 20);
  settings.channel = Math.min(99, Math.max(1, parseInt(f.channel.value, 10) || 1));
  settings.passcode = f.passcode.value;
  saveSettings();
  if (st.ctx) joinChannel(); else begin();
});

// ---------- start ----------

async function begin() {
  if (!settings.name || !settings.passcode || settings.passcode.length < 6) {
    openSettings();
    return;
  }
  if (!window.isSecureContext) {
    flashHint('Open this app over https:// so the microphone and encryption work');
    return;
  }
  try {
    els.allow.disabled = true;
    els.hint.textContent = 'Starting microphone…';
    await startAudio();
  } catch (err) {
    els.allow.disabled = false;
    els.hint.textContent = 'Microphone blocked. Allow it in your browser settings and try again.';
    console.error(err);
    return;
  }
  els.allow.hidden = true;
  els.display.hidden = false;
  requestWakeLock();
  await joinChannel();
}

els.allow.addEventListener('click', begin);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

render();
