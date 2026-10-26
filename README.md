# House Controls

An iPad and iPhone remote for the house's TVs: pick a room, tap Netflix or
Prime or a channel, and go. Every room has a TV (Sony or Samsung) and,
if there is one, a cable box of ANY kind:

- **Optimum Stream** or any other Android TV / Google TV box: pairs with a
  code on the screen, the way the Google TV phone app does.
- **DirecTV Genie**: talks over the network once "External Device" is
  allowed in the Genie's settings. Shows the title of what's on.
- **Anything else** (Xfinity, Spectrum, whatever Florida turns out to be): a
  $25 Broadlink RM4 mini infrared blaster sits next to the box and learns
  the box's own remote, key by key, from the setup screen.
- **No box at all**: the TV takes the whole remote and opens its own apps.

Big app and channel tiles, volume, mute, a keypad, pairing, as many rooms
as you have. One small
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
   ├── Android TV Remote v2 ──▶ Optimum Stream / any Android TV box  (channels, guide, apps)
   │                        └▶ Sony Bravia (it IS an Android TV: apps, arrows, back, home)
   ├── DirecTV HTTP (:8080) ──▶ Genie                 (channels, guide, what's on)
   ├── Broadlink RM4 mini ────▶ any other cable box   (learned infrared, played back)
   ├── Sony REST + PSK ───────▶ Sony Bravia           (volume level, mute, power)
   └── Samsung WebSocket+REST ▶ Samsung / The Frame   (whole remote, apps, volume, power, Art mode)
```

The bridge must be on the same Wi-Fi/LAN as the boxes. The box's remote
protocol is a raw TLS socket, which a browser cannot open, so the page cannot
talk to the box directly; the bridge is the translator.

## Rooms

A room is a TV plus a cable box of one of four kinds (above). Volume, mute
and power always go to the TV. Channels, guide and the number pad go to the
box. Apps go to whatever can open them: an Android TV box, a Sony TV (it is
one), or a Samsung TV's own launcher.

**Keys go to: Box / TV.** In a room with both a cable box and a smart TV,
the arrows, OK, Back and Home have two possible targets. A switch under
Power picks which. Tapping an app tile flips it to TV, tapping a channel
flips it back to Box, so you rarely touch it.

**Infrared rooms.** Add the room with "Other box, via infrared blaster" and
the blaster's IP (Find lists the blasters it sees). Then ⚙ → Learn keys:
tap Learn beside a key, press that key on the box's own remote within 15
seconds, done. Do power, the digits, channel up/down and guide first; a key
that is not learned yet says so when you tap it. Infrared is one-way, so
the page cannot know what channel such a box is on; it shows the last one
you picked here.

**Sony TV alone**: a Sony is itself an Android TV, so it pairs exactly like
a Stream box (a code on the screen) and the apps and arrows go straight to
it. **Samsung TV alone**: the TV takes the whole remote.

The **Apps** tab is the first tab: Netflix, Prime Video, YouTube, Disney+,
Hulu, Max, Apple TV, Peacock, Paramount+, Spotify, and Optimum TV where
there is a box. A greyed tile says why it is not available in that room.

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

7. **Add the TV behind the box** (or make a TV-only room): ⚙ → Add a room:
   name, Stream box IP (or blank), Sony or Samsung, the TV's IP → Add room.
   For a room that already exists, TV… next to it opens the same form.
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
| Power on a Frame | a HELD power press, so it turns off instead of switching to Art mode (never used here) |
| App tile | box or Sony: an app link over the Android TV protocol. Samsung alone: the TV's own app launcher |
| Arrows, OK, Back, Home | the box, or the TV, per the Keys-go-to switch |
| Channel tile / keypad | the digits on the box (Android TV keys, Genie tune, or learned infrared) |
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

## Shopping list (per house)

- The always-on computer for the bridge: a Raspberry Pi 5 starter kit
  (case, power supply, memory card) or any PC that stays on.
- One Broadlink RM4 mini per cable box that is not Android TV or DirecTV.
  It plugs into USB power and sits within sight of the box's front panel.
- Fixed IP addresses in the router for every TV, box and blaster.

## Things to confirm on the real sets

- **Infrared codes.** Some boxes need the key held a moment; if a learned
  key does nothing on playback, learn it again holding the key slightly
  longer. Digits that go too fast for a box can be slowed (the bridge sends
  them 300 ms apart).
- **DirecTV.** The Genie's "External Device" setting must be Allow, and the
  bridge must be on the same subnet.

- **App links.** The Android TV protocol opens an app by handing it a web
  link (netflix.com, primevideo.com…). Any app that ignores its link falls
  back to the TV's home screen; tell me which and I'll switch that tile to
  the app's own scheme. Samsung app IDs are the standard Tizen ones;
  Peacock and Paramount+ are not filled in for Samsung yet.

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
- `cable.js` — the DirecTV Genie and infrared-blaster drivers, blaster discovery.
- `public/remote.html` — the whole iPad page (one file; also works on its own
  in demo mode when no bridge answers).
- `config.example.json` — starter channel list; copied to `data/config.json`
  on first run and edited from the page after that.
- `data/` — your config (box IPs, TV IPs, the Sony key, the Samsung token)
  and the pairing certs. Back this folder up; it is not in git.

## Thermostats (AprilAire 8800-series)

The **Thermostats** tab shows every AprilAire Wi-Fi thermostat in the house: the room temperature and humidity,
whether it is heating, cooling or idle, the heat / cool setpoints with − and + buttons, Heat / Cool / Auto / Off,
the fan, and the hold ("Holding until 6:00 PM · Back to the schedule"). The bridge talks to each thermostat
directly on the house network (TCP port 8000, the thermostat's own automation protocol — `aprilaire.js`), so no
cloud account is involved and the AprilAire phone app keeps working beside it.

One-time setup, on each thermostat itself: open its **Contractor Menu** and set **Connection Type** to
**Automation**. Then in the app: ⚙ Boxes & setup → Thermostats → **Find thermostats on the Wi-Fi** (anything
answering on port 8000 is asked for its name), add the ones it finds, Save. Give each thermostat a fixed address
in the router (a DHCP reservation) so it never moves. A thermostat takes one automation connection at a time, so
only one bridge may be set up for it. The socket goes quiet after a while; the bridge reconnects every hour on
purpose and after any drop.
