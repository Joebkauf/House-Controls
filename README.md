# Optimum Remote

An iPad and iPhone remote for the Optimum Stream boxes (Altice DV8555, an
Android TV box) and the Sony and Samsung TVs behind them. Big channel tiles,
volume, mute, channel up/down, a keypad, pairing, several rooms. One small
Node "bridge" runs on the house network and talks to each box the same way
the Google TV phone app does (Android TV Remote protocol v2). No developer
mode, no ADB, no Optimum account. Volume and power go straight to the TV
over its own network API, so nothing depends on HDMI-CEC.

On an iPad the page is a three-column wall. On an iPhone the channel wall
fills the screen with a quick bar underneath (power, volume, mute, channel)
and a More button that slides up the full pad. Same address, same page.

## How it fits together

```
iPad / iPhone (Safari, saved to the home screen)
   │  http://<bridge>:4680      (plain web page, works on any phone/tablet)
   ▼
bridge  (node server.js on a PC / Mac mini / Raspberry Pi that stays on)
   ├── Android TV Remote v2 ──▶ Optimum Stream box   (channels, guide, apps)
   ├── Sony REST + PSK ───────▶ Sony Bravia          (volume, mute, power)
   └── Samsung WebSocket ─────▶ Samsung / The Frame  (volume, mute, power, Art mode)
```

The bridge must be on the same Wi-Fi/LAN as the boxes. The box's remote
protocol is a raw TLS socket, which a browser cannot open, so the page cannot
talk to the box directly; the bridge is the translator.

## First night at home (15 minutes)

1. **Check the box answers the protocol.** On your phone, install the Google TV
   app, open Remote, and see whether a Stream box is offered for pairing. If it
   is, everything below works. (If it is not, see "If pairing never shows a
   code".)
2. **Pick the machine that stays on.** Any Windows PC, Mac or Raspberry Pi on
   the house network. Install Node 20 or newer.
3. **Run the bridge.**
   ```
   cd optimum-remote
   npm install
   node server.js
   ```
   It prints `Optimum Remote bridge on http://0.0.0.0:4680`. Give that machine
   a fixed IP in the router so the address never moves.
4. **Open it on the iPad:** `http://<that machine's IP>:4680`. Safari share
   button → Add to Home Screen. It opens full screen with no browser bar.
5. **Add a box:** ⚙ Boxes & setup → Find boxes on the Wi-Fi (or type the IP
   from the box's Settings → Device & Remote Settings → About → Status) → Add
   → Pair. The TV shows a six-character code; type it on the iPad. The pairing
   is remembered (a cert file in `data/certs/`), so this happens once per box.
6. **Fill in channel numbers:** tap Edit, type each channel's number, Done.
   Star the ones you watch. Tiles with no number say so until you set one.

7. **Add the TV behind the box:** ⚙ → Add TV next to the room → Sony or
   Samsung → the TV's IP → Save TV.
   - **Sony:** on the TV, Settings → Network → Home Network → IP Control →
     Authentication = "Normal and Pre-Shared Key", type a key, Simple IP
     control On, Remote start On. Type the same key in the form.
   - **Samsung (Frame too):** Save, then tap Allow on TV. The TV shows an
     "Allow Optimum Remote?" prompt; pick Allow. The bridge keeps the token.
     On the TV, General → Network → Expert Settings → Power On with Mobile
     must be on for the Power button to wake it.
   - Tick "Samsung The Frame" for the Frames. That adds the Art mode button.

Repeat 5 and 7 for each room. The left rail (or the chips at the top on a
phone) switches rooms.

## What each control sends

| Button | Key sent to the box |
|---|---|
| Power | TV set up: the TV's own power (Wake-on-LAN to turn on). Otherwise `POWER` to the box |
| − / + (hold to repeat) | TV set up: the TV's volume. Otherwise `VOLUME_DOWN` / `VOLUME_UP` to the box |
| Mute | TV set up: the TV's mute. Otherwise `MUTE` to the box |
| Art mode ↔ TV (Frames) | a short power press on the Frame, which swaps picture and art |
| CH ∨ / CH ∧ | `CHANNEL_DOWN` / `CHANNEL_UP` |
| Last, Guide, CC | `LAST_CHANNEL`, `GUIDE`, `CAPTIONS` |
| Back, Home, Play | `BACK`, `HOME`, `MEDIA_PLAY_PAUSE` |
| Channel tile / keypad + Go | the digits, 220 ms apart, then optionally Enter or OK (setting in ⚙) |
| Arrows / OK | `DPAD_*` / `DPAD_CENTER` |

The box reports back its standby state and the app in front (Optimum TV,
Netflix, YouTube…), which is what the left rail shows. A Sony TV reports its
volume level and mute, so the bar is live. A Samsung TV does not report its
level over this channel; the buttons work and the TV's own on-screen bar
shows the number. "Volume & power go to" in the TV form can send them
through the box over HDMI-CEC instead, per room.

## Things to confirm on the real sets

- **Frame power off.** Over the network a Frame treats a short power press
  as "swap to Art mode" and a held press as "off". The bridge holds the key
  for three seconds to turn a Frame off. If a Frame goes to art instead,
  say so; the alternative is the Frame's art-mode channel.
- **Samsung wake.** A Samsung that is fully off answers only to
  Wake-on-LAN, which needs "Power On with Mobile" on the TV and the TV on
  Wi-Fi or Ethernet with a fixed IP. The bridge learns the TV's MAC from
  the TV the first time it sees it on.
- **Sony wake.** With Remote start On the Sony turns on from the REST call;
  the bridge also sends Wake-on-LAN first.
- **Number entry.** After the digits the Optimum TV app usually tunes by
  itself after a second. If it sits there waiting, switch "After typing a
  channel number" in ⚙ to Press Enter or Press OK.

## If pairing never shows a code

That means the box does not run the Android TV Remote Service (rare on an
Android TV box, but operator boxes can strip it). Plan B is ADB over the
network: Settings → Device Preferences → About → tap Build seven times →
Developer options → Network debugging. Then the bridge sends
`input keyevent` commands instead. Say so and I will add that path.

## Running it as a service

- **Windows:** Task Scheduler, "At log on", `node C:\optimum-remote\server.js`,
  or `npm i -g pm2` then `pm2 start server.js --name tv && pm2 save`.
- **Raspberry Pi / Mac:** `pm2` the same way, or a systemd unit.

Options: `PORT` (default 4680), `DATA_DIR` (default `./data`), `DEMO=1`
(pretend boxes, for trying the page anywhere).

## Files

- `server.js` — the bridge: pairing, key sending, state push (SSE), config.
- `tv.js` — the Sony and Samsung drivers, Wake-on-LAN, SSDP discovery.
- `public/remote.html` — the whole iPad page (one file; also works on its own
  in demo mode when no bridge answers).
- `config.example.json` — starter channel list; copied to `data/config.json`
  on first run and edited from the page after that.
- `data/` — your config (box IPs, TV IPs, the Sony key, the Samsung token)
  and the pairing certs. Back this folder up; it is not in git.
