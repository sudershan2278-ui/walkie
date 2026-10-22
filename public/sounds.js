// Synthesized radio sounds: no audio files to download, so everything starts instantly.

export function sirenHiLo(ctx, out) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  gain.gain.value = 0.18;
  const t0 = ctx.currentTime;
  for (let i = 0; i < 120; i++) osc.frequency.setValueAtTime(i % 2 ? 650 : 950, t0 + i * 0.45);
  osc.connect(gain).connect(out);
  osc.start();
  return () => { gain.gain.setTargetAtTime(0, ctx.currentTime, 0.02); osc.stop(ctx.currentTime + 0.1); };
}

export function sirenWail(ctx, out) {
  const osc = ctx.createOscillator();
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.value = 1000;
  lfo.type = 'triangle';
  lfo.frequency.value = 0.25;
  lfoGain.gain.value = 450;
  gain.gain.value = 0.14;
  lfo.connect(lfoGain).connect(osc.frequency);
  osc.connect(gain).connect(out);
  osc.start();
  lfo.start();
  return () => {
    gain.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
    osc.stop(ctx.currentTime + 0.1);
    lfo.stop(ctx.currentTime + 0.1);
  };
}

export function airHorn(ctx, out) {
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2200;
  gain.gain.value = 0;
  gain.gain.setTargetAtTime(0.22, ctx.currentTime, 0.01);
  const oscs = [233, 294, 349].map(f => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    o.connect(filter);
    o.start();
    return o;
  });
  filter.connect(gain).connect(out);
  return () => {
    gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
    oscs.forEach(o => o.stop(ctx.currentTime + 0.2));
  };
}

// Short tone pair played at the end of every transmission.
export function rogerBeep(ctx, out) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  gain.gain.value = 0.25;
  const t = ctx.currentTime;
  osc.frequency.setValueAtTime(1200, t);
  osc.frequency.setValueAtTime(1600, t + 0.07);
  gain.gain.setValueAtTime(0, t + 0.14);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + 0.16);
  return 160;
}

// Low "bonk" when the channel is busy.
export function busyTone(ctx, out) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = 330;
  gain.gain.value = 0.12;
  const t = ctx.currentTime;
  gain.gain.setValueAtTime(0, t + 0.12);
  gain.gain.setValueAtTime(0.12, t + 0.2);
  gain.gain.setValueAtTime(0, t + 0.32);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + 0.35);
}

// Burst of static, like a radio's squelch opening or closing.
export function squelch(ctx, out, seconds = 0.12) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 2500;
  gain.gain.value = 0.12;
  src.buffer = buffer;
  src.connect(filter).connect(gain).connect(out);
  src.start();
}

// Megaphone voice: telephone band plus a little distortion.
export function megaphoneChain(ctx) {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 500;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3200;
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(3 * x);
  }
  shaper.curve = curve;
  const gain = ctx.createGain();
  gain.gain.value = 1.4;
  hp.connect(lp).connect(shaper).connect(gain);
  return { input: hp, output: gain };
}
