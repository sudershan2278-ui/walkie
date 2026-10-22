// End-to-end channel encryption.
//
// (channel, passcode) -> PBKDF2-SHA256 -> 64 bytes:
//   first 32 bytes: AES-256-GCM key for every frame on the channel
//   last 32 bytes:  hashed again into the room id the server sees
// The server only ever gets the room id and ciphertext, so it cannot listen in,
// and phones with a different passcode land in a different room.

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 210_000;

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export async function deriveChannel(channel, passcode) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`walkie-v1|channel:${channel}`), iterations: PBKDF2_ITERATIONS },
    base,
    512,
  ));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const roomBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bits.slice(32)));
  return { key, roomId: toHex(roomBytes), aad: roomBytes };
}

// Packet: 12-byte random IV || AES-GCM(ciphertext + 16-byte tag), bound to the room id.
export async function seal({ key, aad }, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function open({ key, aad }, packet) {
  const bytes = new Uint8Array(packet);
  if (bytes.length < 29) return null;
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: aad }, key, bytes.subarray(12)));
  } catch {
    return null; // wrong key or tampered
  }
}
