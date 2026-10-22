// Stand-in for a radio's sound card in tests.
//   capture <flagfile>: writes 16 kHz s16le audio in real time: a tone while <flagfile> exists, else silence.
import { existsSync } from 'node:fs';

const [, , mode, flag] = process.argv;
if (mode !== 'capture') process.exit(2);
const RATE = 16000, CHUNK = 320;
let phase = 0;
setInterval(() => {
  const on = existsSync(flag);
  const buf = Buffer.alloc(CHUNK * 2);
  for (let i = 0; i < CHUNK; i++) {
    const s = on ? Math.sin(phase) * 0.3 : (Math.random() - 0.5) * 0.002;
    phase += (2 * Math.PI * 700) / RATE;
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  process.stdout.write(buf);
}, 20);
