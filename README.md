# Walkie

A push-to-talk walkie-talkie for Android and iOS phones that also links to real hardware radios.
If your radio's battery dies, open Walkie on your phone and you still hear and talk to everyone on that radio channel.

```
 Real radios on the air  ⇄  Radio bridge (Pi + spare radio + AIOC cable)  ⇄  Walkie server  ⇄  Phones (Android / iOS)
```

## What's in here

| Part | Folder | What it does |
|---|---|---|
| Phone app | `public/` | Installable web app (PWA) with the radio screen: hold **TALKIE** to talk, **REC/PLAY**, **SIRENS**, **WAIL**, **HORN**, **MAN** (megaphone), **LIGHTS**, **STOP ALL**, keypad to change channel (1–99). |
| Server | `server.js` | Relays encrypted audio between everyone on a channel. One talker at a time, like a radio. |
| Radio bridge | `bridge/` | Plugs one real radio into a channel. Radio audio goes to the phones; phone audio keys the radio and goes out on the air. |
| Test | `test/e2e.mjs` | Starts everything (with a fake radio) and checks phones, passcodes, bridge both ways, and reconnects. |

## Security

- **Passcode-locked channels.** Each channel has a passcode (6+ characters). Your phone turns *channel + passcode* into an encryption key (PBKDF2, 210,000 rounds).
- **End-to-end encrypted audio.** Every 20 ms audio frame is sealed with AES-256-GCM on the phone. The server only sees scrambled bytes and a hashed room id. It never sees passcodes and cannot listen in.
- **Wrong passcode = different room.** Someone with the wrong passcode hears nothing, and tampered audio is rejected.
- **Server hardening:** strict Content-Security-Policy, HTTPS-only headers, small message size limit, per-connection rate limit, 64 people per channel max, 60 s talk limit, dead-connection cleanup, optional `ALLOWED_ORIGINS` lock.
- Phones need **https://** for the mic and encryption to work (any normal host gives you this).

Anyone with the channel passcode can listen, so share it only with your team. The audio going out over the air from the radio bridge is normal unencrypted radio, like any walkie-talkie.

## Low lag

- Audio is sent every **20 ms** in tiny frames (16 kHz voice, about 130 kbit/s) with no compression delay.
- The phone keeps only a **60 ms** buffer and throws away any backlog over 250 ms, so delay never builds up.
- Expect roughly **100–250 ms** from mouth to ear on 4G or Wi‑Fi (about what you get on a digital radio). Picking a server region near your team keeps it at the low end. The screen shows the live delay to the server in the top right.

## Run the server

Needs Node.js 20+.

```sh
npm ci
npm start              # http://localhost:8080
```

Opening `http://localhost:8080` works on the same computer. **Phones need HTTPS**, so deploy it:

- **Render:** connect this repo, it reads `render.yaml`. Set `ALLOWED_ORIGINS` to your app URL, e.g. `https://walkie.onrender.com`.
- **Docker anywhere:** `docker build -t walkie . && docker run -p 8080:8080 walkie`, behind any HTTPS proxy (Caddy, Cloudflare, Fly.io, Railway…).

## Use it on a phone

1. Open your server's `https://` address in Chrome (Android) or Safari (iOS).
2. **Add to Home Screen** (Android: menu ⋮ → Install app; iPhone: Share → Add to Home Screen). It then opens full screen like a normal app.
3. Tap **ALLOW MIC**, enter your name, channel and the team passcode.
4. **Hold TALKIE** (or the side button on the radio picture) to talk, let go to listen. You hear a roger beep when you let go and static when someone else starts or stops.
5. Change channel with the keypad (two digits, then the round OK button) or the ◀ ▶ keys. **P1/P2** open settings.

Keep the app open while you're on duty; phones pause web audio when the app is fully in the background. The app keeps the screen awake while it's open.

## Set up the radio bridge

### What you need

- A Raspberry Pi (3B+ or newer) or any Linux computer with internet, left on.
- One spare radio set to your team's channel, on a charger.
- A USB audio + PTT cable for that radio. The **AIOC (All-In-One-Cable)** is about $20–30 and fits Baofeng/Kenwood 2-pin (K1) radios. It shows up as a sound card plus a serial port that keys the radio.

### Install

```sh
sudo apt install -y nodejs npm alsa-utils python3
git clone <this repo> ~/walkie && cd ~/walkie && npm ci --omit=dev
cp bridge/bridge.env.example bridge/bridge.env && chmod 600 bridge/bridge.env
nano bridge/bridge.env          # server address, channel, passcode
arecord -l                      # check the AIOC shows up as "AllInOneCable"
```

Try it in the foreground:

```sh
set -a; . bridge/bridge.env; set +a; node bridge/bridge.mjs
```

Then run it on boot:

```sh
sudo cp bridge/walkie-bridge.service /etc/systemd/system/
sudo systemctl enable --now walkie-bridge
journalctl -u walkie-bridge -f   # live log
```

### How it behaves

- **Radio → phones:** when the radio receives someone, the bridge hears it (voice-activated, `VOX_THRESHOLD_DB`), grabs the channel and sends the audio to all phones. It keeps 200 ms of audio from just before, so the first word isn't cut off. Phones show **RX: Radio bridge**.
- **Phones → radio:** when someone on a phone talks, the bridge keys the radio's PTT, waits 150 ms for the transmitter to come up, then plays the voice out on the air.
- Only one side talks at a time, so the radio and phones never talk over each other.

### Radio tips

- Turn the radio's **squelch on** (level 3–5) so the bridge only hears real transmissions, not hiss.
- Set radio volume around half and adjust `VOX_THRESHOLD_DB` if it triggers on noise (raise toward -30) or misses quiet voices (lower toward -45).
- No AIOC? Set `PTT_MODE=vox` and turn on the radio's own VOX, or `PTT_MODE=rts`/`dtr` for other serial PTT cables, or `PTT_MODE=cmd` with your own `PTT_ON_CMD`/`PTT_OFF_CMD` (e.g. a GPIO script).
- Use the bridge only on channels and power levels you're licensed for (PMR446 / FRS are licence-free in most places).

## Test

```sh
npm test
```

Starts the server, a radio bridge with a simulated radio, and three phones in a headless Chromium browser (two with the right passcode, one with a wrong one), then checks talking both ways, busy channel blocking, encryption, channel switching, effects, recording, and automatic reconnects.

## Settings reference

Server: `PORT` (8080), `ALLOWED_ORIGINS` (comma-separated `https://` origins; empty allows any).

Bridge (`bridge/bridge.env`): `WALKIE_SERVER`, `WALKIE_CHANNEL`, `WALKIE_PASSCODE` or `WALKIE_PASSCODE_FILE`, `WALKIE_NAME`, `CAPTURE_CMD`, `PLAYBACK_CMD`, `PTT_MODE` (`aioc`/`rts`/`dtr`/`vox`/`cmd`), `PTT_DEVICE`, `PTT_ON_CMD`, `PTT_OFF_CMD`, `PTT_LEAD_MS`, `PTT_TAIL_MS`, `VOX_THRESHOLD_DB`, `VOX_HANG_MS`, `PRE_ROLL_MS`.
