// G.711 mu-law codec, shared by the phone app (audio worklet) and the radio bridge.

export function muLawEncode(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let s = Math.max(-1, Math.min(1, sample)) * 32767 | 0;
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export const MU_LAW_TABLE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  let s = ((mantissa << 3) + 0x84) << exponent;
  s -= 0x84;
  MU_LAW_TABLE[i] = (sign ? -s : s) / 32768;
}
