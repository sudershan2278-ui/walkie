// Audio worklets for low-delay push-to-talk.
// Network audio is 16 kHz mono, 8-bit mu-law, sent in 20 ms frames (320 bytes).

import { muLawEncode, MU_LAW_TABLE } from './mulaw.js';

const NET_RATE = 16000;
const FRAME = 320; // 20 ms at 16 kHz

// Takes the mic/effects mix, downsamples to 16 kHz and posts 20 ms mu-law frames.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / NET_RATE;
    this.pos = 0;           // fractional read position into the current input block
    this.prev = 0;          // last filtered sample of the previous block
    this.lp = 0;
    this.lpCoef = Math.exp(-2 * Math.PI * 7000 / sampleRate);
    this.frame = new Uint8Array(FRAME);
    this.fill = 0;
    this.active = false;
    this.port.onmessage = e => {
      this.active = !!e.data.active;
      if (!this.active) this.fill = 0;
    };
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || !this.active) return true;
    const n = input.length;
    const filtered = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.lp = input[i] + this.lpCoef * (this.lp - input[i]);
      filtered[i] = this.lp;
    }
    while (this.pos < n) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.prev : filtered[i - 1];
      const b = filtered[i];
      // pos is measured so that index 0 sits between prev and filtered[0]
      this.frame[this.fill++] = muLawEncode(a + (b - a) * frac);
      if (this.fill === FRAME) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Uint8Array(FRAME);
        this.fill = 0;
      }
      this.pos += this.step;
    }
    this.pos -= n;
    this.prev = filtered[n - 1];
    return true;
  }
}

// Plays incoming frames with a small jitter buffer (60 ms) and drops backlog
// above 250 ms so delay can never pile up.
class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(NET_RATE * 2);
    this.read = 0;
    this.write = 0;
    this.frac = 0;
    this.playing = false;
    this.step = NET_RATE / sampleRate;
    this.START = NET_RATE * 0.06;
    this.MAX = NET_RATE * 0.25;
    this.TRIM_TO = NET_RATE * 0.08;
    this.port.onmessage = e => {
      if (e.data === 'reset') { this.read = this.write = 0; this.playing = false; return; }
      const frame = e.data;
      for (let i = 0; i < frame.length; i++) {
        this.buf[this.write % this.buf.length] = MU_LAW_TABLE[frame[i]];
        this.write++;
      }
      if (this.write - this.read > this.MAX) this.read = this.write - this.TRIM_TO;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const available = this.write - this.read;
    if (!this.playing) {
      if (available >= this.START) this.playing = true;
      else return true;
    }
    const len = this.buf.length;
    for (let i = 0; i < out.length; i++) {
      if (this.write - this.read < 2) { this.playing = false; break; }
      const a = this.buf[this.read % len];
      const b = this.buf[(this.read + 1) % len];
      out[i] = a + (b - a) * this.frac;
      this.frac += this.step;
      while (this.frac >= 1) { this.frac -= 1; this.read++; }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
registerProcessor('player', PlayerProcessor);
