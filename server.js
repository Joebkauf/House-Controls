// Optimum Remote bridge — runs on a PC / Raspberry Pi on the same Wi-Fi as the
// TVs. Each ROOM has a TV (Sony / Samsung) and/or a cable box:
//   androidtv : Optimum Stream and any other Android TV / Google TV box (Android TV Remote v2,
//               the protocol the Google TV phone app uses — a code on the screen, once)
//   directv   : a DirecTV Genie over its own HTTP port
//   ir        : anything else, through a Broadlink RM4 mini infrared blaster that learns the
//               box's own remote
// A Sony TV is itself an Android TV, so it also gets an Android TV connection (apps, arrows).
//
//   DEMO=1 node server.js   → fake rooms, so the page can be tried anywhere
//   PORT=4680 node server.js
//   DATA_DIR=./data         → config.json + one cert file per paired device
'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const TV = require('./tv');
const CABLE = require('./cable');

const PORT = Number(process.env.PORT || 4680);
const DEMO = process.env.DEMO === '1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CERT_DIR = path.join(DATA_DIR, 'certs');
fs.mkdirSync(CERT_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toLocaleTimeString('en-US'), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'room';

// ---------- config -------------------------------------------------------
const EXAMPLE = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
function loadConfig() {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  if (!cfg) {
    cfg = EXAMPLE();
    if (DEMO) cfg.boxes = [
      { id: 'living', name: 'Living Room', host: '192.168.1.50', boxType: 'androidtv', tv: { brand: 'sony', host: '192.168.1.60', psk: 'demo', route: 'tv' } },
      { id: 'bedroom', name: 'Bedroom', host: '192.168.1.51', boxType: 'androidtv', tv: { brand: 'samsung', host: '192.168.1.61', frame: true, route: 'tv' } },
      { id: 'den', name: 'Den (TV only)', host: '', boxType: 'none', tv: { brand: 'samsung', host: '192.168.1.62', frame: false, route: 'tv' } },
      { id: 'fl-family', name: 'Florida Family Room', host: '192.168.2.40', boxType: 'ir', ir: { codes: { POWER: 'x', CHANNEL_UP: 'x', CHANNEL_DOWN: 'x', 0: 'x', 1: 'x', 2: 'x', 3: 'x', 4: 'x', 5: 'x', 6: 'x', 7: 'x', 8: 'x', 9: 'x', GUIDE: 'x' } }, tv: { brand: 'samsung', host: '192.168.2.60', route: 'tv' } },
    ];
    saveConfig(cfg);
  }
  cfg.boxes = (cfg.boxes || []).map((b) => ({ ...b, boxType: b.boxType || (b.host ? 'androidtv' : 'none') }));
  cfg.channels = cfg.channels || [];
  cfg.channelEnter = cfg.channelEnter || 'none'; // 'none' | 'enter' | 'center'
  if (!cfg.apps) { cfg.apps = EXAMPLE().apps; saveConfig(cfg); }
  return cfg;
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n'); }
let config = loadConfig();

// ---------- rooms ----------------------------------------------------------
// room = { cfg, box: <androidtv link | cable driver | null>, tv: <tv driver | null>, sonyLink: <androidtv link | null>, focus }
const rooms = new Map();
const listeners = new Set();
const identify = { active: false, boxes: new Map(), tvs: new Map(), found: null, matched: null, timer: null }; // the "show every TV its address" session
function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of listeners) res.write(payload);
}

const tvRouted = (r) => !!(r.tv && (r.cfg.tv.route || 'tv') === 'tv');
const tvTakesKeys = (r) => !!(r.sonyLink || (r.tv && r.tv.sendKey));
const BOX_LABEL = { androidtv: 'Android TV box', directv: 'DirecTV Genie', ir: 'Cable box (infrared)', none: '' };

function publicRoom(r) {
  const b = r.box, tv = r.tv, type = r.cfg.boxType;
  const focusTv = r.focus === 'tv' && tvTakesKeys(r);
  const out = {
    id: r.cfg.id, name: r.cfg.name, host: r.cfg.host, boxType: type, boxLabel: BOX_LABEL[type] || type,
    // compatibility fields the page reads
    status: 'no-box', needsCode: false, lastChannel: null, powered: null, app: null, title: null, callsign: null, lastError: null,
    volume: tvRouted(r) ? tv.volume : (b && b.volume) || null,
    volumeFrom: tvRouted(r) ? 'tv' : 'box',
    focus: focusTv ? 'tv' : 'box', tvTakesKeys: tvTakesKeys(r), hasBothSides: type !== 'none' && tvTakesKeys(r),
    irKeys: type === 'ir' ? CABLE.IR_KEYS.map(([k, label]) => ({ key: k, label, learned: !!(b && b.codes[k]) })) : null,
    irLearning: type === 'ir' && b ? b.learning : null,
    tv: r.cfg.tv && r.cfg.tv.brand ? {
      brand: r.cfg.tv.brand, host: r.cfg.tv.host, route: r.cfg.tv.route || 'tv', hasPsk: !!r.cfg.tv.psk,
      status: tv ? tv.status : 'unknown', powered: tv ? tv.powered : null, frame: !!(tv && tv.frame),
      model: tv && tv.model || null, error: tv && tv.error || null, paired: !!(tv && (tv.brand === 'sony' || tv.token)),
      linkStatus: r.sonyLink ? r.sonyLink.status : null, linkNeedsCode: !!(r.sonyLink && r.sonyLink.needsCode), app: r.sonyLink ? r.sonyLink.app : null,
    } : null,
  };
  if (type === 'androidtv' && b) Object.assign(out, { status: b.status, needsCode: !!b.needsCode, lastChannel: b.lastChannel || null, powered: b.powered, app: b.app, lastError: b.lastError || null });
  else if ((type === 'directv' || type === 'ir') && b) Object.assign(out, { status: b.status === 'ok' ? 'ready' : b.status, lastChannel: b.channel || null, powered: b.powered, title: b.title || null, callsign: b.callsign || null, lastError: b.error || null });
  if (focusTv && r.sonyLink) out.app = r.sonyLink.app;
  return out;
}
function publicState() {
  return { demo: DEMO, boxes: [...rooms.values()].map(publicRoom), channels: config.channels, apps: config.apps, channelEnter: config.channelEnter, identify: publicIdentify() };
}

// ---------- Android TV link (Stream box, any Android TV box, a Sony TV) ----------
let AndroidRemote, RemoteKeyCode, RemoteDirection;
if (!DEMO) ({ AndroidRemote, RemoteKeyCode, RemoteDirection } = require('androidtv-remote'));
// Pairing certificates are kept per DEVICE ADDRESS, so a box paired once (even
// from the "show every TV its address" step) stays paired whatever room it lands in.
const certPath = (key) => path.join(CERT_DIR, `${String(key).replace(/[^0-9A-Za-z.-]/g, '_')}.json`);
const readCertFile = (key) => { try { return JSON.parse(fs.readFileSync(certPath(key), 'utf8')); } catch { return null; } };
const readCert = (id, host) => readCertFile(host) || (id && readCertFile(id)) || null;

// Samsung "Allow" tokens, also per TV address.
const TOKENS_PATH = path.join(DATA_DIR, 'tv-tokens.json');
const readTokens = () => { try { return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')); } catch { return {}; } };
const saveTvToken = (host, token) => { const all = readTokens(); all[host] = token; fs.writeFileSync(TOKENS_PATH, JSON.stringify(all, null, 2)); };

function androidLink(id, host, label, serviceName) {
  // status: needs-pairing | pairing | connecting | ready | offline
  const L = { id, host, label, status: 'needs-pairing', needsCode: false, powered: null, volume: null, app: null, lastError: null, remote: null, lastChannel: null };
  L.connect = async ({ pair = false } = {}) => {
    if (DEMO) { L.status = 'ready'; L.powered = true; L.volume = L.volume || { level: 12, max: 40, muted: false }; L.app = L.app || 'com.altice.optimum.tv'; broadcast(); return; }
    if (L.remote) { try { L.remote.stop(); } catch {} L.remote = null; }
    const cert = pair ? null : readCert(id, host);
    if (!cert && !pair) { L.status = 'needs-pairing'; broadcast(); return; }
    L.status = pair ? 'pairing' : 'connecting'; L.lastError = null; broadcast();
    const remote = new AndroidRemote(host, { pairing_port: 6467, remote_port: 6466, service_name: serviceName || 'House Controls', cert: cert || {} });
    L.remote = remote;
    remote.on('secret', () => { L.status = 'pairing'; L.needsCode = true; broadcast(); });
    remote.on('powered', (p) => { L.powered = p; broadcast(); });
    remote.on('volume', (v) => { L.volume = { level: v.level, max: v.maximum, muted: v.muted }; broadcast(); });
    remote.on('current_app', (a) => { L.app = a; broadcast(); });
    remote.on('error', (e) => { L.lastError = String(e && e.error ? JSON.stringify(e.error) : e); log(`[${id}] error`, L.lastError); broadcast(); });
    remote.on('unpaired', () => { log(`[${id}] ${label} says we are not paired`); try { fs.unlinkSync(certPath(host)); } catch {} try { fs.unlinkSync(certPath(id)); } catch {} L.status = 'needs-pairing'; L.remote = null; broadcast(); });
    remote.on('ready', () => { L.status = 'ready'; L.needsCode = false; fs.writeFileSync(certPath(host), JSON.stringify(remote.getCertificate())); log(`[${id}] ready`); broadcast(); });
    try {
      const started = await remote.start();
      if (!started && L.status !== 'ready') { L.status = cert ? 'offline' : 'needs-pairing'; L.needsCode = false; L.lastError = L.lastError || (pair ? 'the box stopped asking for a code; tap Pair again' : 'could not connect'); broadcast(); }
    } catch (e) { L.status = cert ? 'offline' : 'needs-pairing'; L.needsCode = false; L.lastError = e.code || e.message || String(e); log(`[${id}] connect failed`, L.lastError); broadcast(); }
  };
  L.cancelPairing = () => { L.close(); L.needsCode = false; L.status = readCert(id, host) ? 'offline' : 'needs-pairing'; L.lastError = null; broadcast(); if (readCert(id, host)) L.connect(); };
  L.notReady = () => err(`${label}: ${{ 'needs-pairing': 'not paired yet (⚙ → Pair)', pairing: 'still pairing', connecting: 'connecting', offline: 'not reachable' }[L.status] || L.status}`, 409);
  L.sendKey = (name) => {
    if (L.status !== 'ready') throw L.notReady();
    if (DEMO) return demoKey(L, name);
    const k = RemoteKeyCode[`KEYCODE_${name}`];
    if (k === undefined) throw err(`unknown key ${name}`);
    L.remote.sendKey(k, RemoteDirection.SHORT);
  };
  L.tune = async (digits) => {
    for (const d of digits) { L.sendKey(d); await sleep(220); }
    if (config.channelEnter === 'enter') L.sendKey('ENTER');
    if (config.channelEnter === 'center') L.sendKey('DPAD_CENTER');
    L.lastChannel = digits;
  };
  L.openApp = (app) => {
    if (L.status !== 'ready') throw L.notReady();
    if (DEMO) { L.app = app.pkg; broadcast(); return; }
    if (!app.link) { L.sendKey('HOME'); return; }
    L.remote.sendAppLink(app.link);
  };
  L.sendCode = (code) => {
    if (DEMO) { L.needsCode = false; L.connect(); return; }
    if (!L.remote || !L.needsCode) throw err('not asking for a code right now', 409);
    L.remote.sendCode(code);
  };
  L.close = () => { try { L.remote && L.remote.stop(); } catch {} L.remote = null; };
  L.canTune = true; L.hasApps = true; L.codes = {};
  return L;
}
function demoKey(L, name) {
  const v = L.volume;
  if (name === 'VOLUME_UP') v.level = Math.min(v.max, v.level + 1);
  else if (name === 'VOLUME_DOWN') v.level = Math.max(0, v.level - 1);
  else if (name === 'MUTE' || name === 'VOLUME_MUTE') v.muted = !v.muted;
  else if (name === 'POWER') L.powered = !L.powered;
  else if (name === 'HOME') L.app = 'com.google.android.tvlauncher';
  else if (/^\d$/.test(name) || name === 'CHANNEL_UP' || name === 'CHANNEL_DOWN') L.app = 'com.altice.optimum.tv';
  broadcast();
}

// ---------- the TV in each room ------------------------------------------------
function demoTv(cfg) {
  const t = { brand: cfg.brand, frame: cfg.brand === 'samsung' && !!cfg.frame, status: 'ok', powered: true, model: cfg.brand === 'sony' ? 'XR-65A80L (demo)' : 'QN55LS03B (demo)',
    volume: cfg.brand === 'sony' ? { level: 18, max: 100, muted: false } : null, token: cfg.brand === 'samsung' ? 'demo' : undefined };
  const step = (d) => async () => { if (t.volume) t.volume.level = Math.max(0, Math.min(t.volume.max, t.volume.level + d)); };
  Object.assign(t, {
    volumeUp: step(2), volumeDown: step(-2),
    setVolume: cfg.brand === 'sony' ? async (n) => { t.volume.level = Math.max(0, Math.min(100, Math.round(n))); } : null,
    mute: async () => { if (t.volume) t.volume.muted = !t.volume.muted; },
    powerToggle: async () => { t.powered = !t.powered; }, powerOn: async () => { t.powered = true; }, powerOff: async () => { t.powered = false; },
    artMode: cfg.brand === 'samsung' ? async () => { t.art = !t.art; } : null,
    allow: async () => { t.token = 'demo'; }, poll: async () => t, close: () => {},
    sendKey: cfg.brand === 'samsung' ? async () => {} : undefined, launchApp: cfg.brand === 'samsung' ? async () => {} : undefined,
  });
  return t;
}
function attachTv(r) {
  const cfg = r.cfg.tv;
  const sig = cfg && cfg.brand ? JSON.stringify([cfg.brand, cfg.host, cfg.psk, cfg.port, cfg.plainWs, cfg.infoPort]) : '';
  if (r.tvSig !== sig) {
    if (r.tv) { try { r.tv.close(); } catch {} clearInterval(r.tvPoll); r.tv = null; }
    r.tvSig = sig;
    if (sig) {
      if (DEMO) r.tv = demoTv(cfg);
      else if (cfg.brand === 'sony') r.tv = TV.sony(cfg, broadcast);
      else if (cfg.brand === 'samsung') { if (!cfg.token && readTokens()[cfg.host]) { cfg.token = readTokens()[cfg.host]; saveConfig(config); } r.tv = TV.samsung({ ...cfg, clientName: `House Controls · TV ${cfg.host}` }, broadcast, (token) => { cfg.token = token; saveConfig(config); saveTvToken(cfg.host, token); }); }
      if (r.tv && !DEMO) { r.tv.poll().catch(() => {}); r.tvPoll = setInterval(() => r.tv && r.tv.poll().catch(() => {}), 15000); }
    }
  }
  if (r.tv) r.tv.frame = r.tv.frame || !!(cfg && cfg.frame);
  // A Sony is an Android TV: give it its own link for apps / arrows (unless the box slot already points at it).
  const wantLink = cfg && cfg.brand === 'sony' && cfg.host && !(r.cfg.boxType === 'androidtv' && r.cfg.host === cfg.host);
  const linkSig = wantLink ? cfg.host : '';
  if (r.linkSig !== linkSig) {
    if (r.sonyLink) { r.sonyLink.close(); r.sonyLink = null; }
    r.linkSig = linkSig;
    if (wantLink) { r.sonyLink = androidLink(`${r.cfg.id}-tv`, cfg.host, `${r.cfg.name} Sony TV`); r.sonyLink.connect(); }
  }
}

// ---------- the box in each room -------------------------------------------------
function attachBox(r) {
  const c = r.cfg;
  const sig = c.boxType === 'none' ? '' : JSON.stringify([c.boxType, c.host, c.boxType === 'ir' ? (c.ir && c.ir.mac) : null, c.boxType === 'ir' ? (c.ir && c.ir.enterAfterDigits) : null]);
  if (r.boxSig === sig) return;
  if (r.box) { try { r.box.close(); } catch {} clearInterval(r.boxPoll); r.box = null; }
  r.boxSig = sig;
  if (!sig) return;
  if (c.boxType === 'androidtv') { r.box = androidLink(c.id, c.host, `${c.name} box`); r.box.connect(); return; }
  if (DEMO) { r.box = demoCable(c); return; }
  const saveIr = (codes, extra) => { c.ir = { ...(c.ir || {}), codes, ...(extra || {}) }; saveConfig(config); };
  if (c.boxType === 'directv') r.box = CABLE.directv({ host: c.host, port: c.port }, broadcast);
  else if (c.boxType === 'ir') r.box = CABLE.ir({ host: c.host, ...(c.ir || {}) }, broadcast, saveIr);
  if (r.box) { r.box.poll().catch(() => {}); r.boxPoll = setInterval(() => r.box && r.box.poll().catch(() => {}), 20000); }
}
function demoCable(c) {
  const t = { type: c.boxType, status: 'ok', powered: true, channel: c.boxType === 'directv' ? '206' : null, title: c.boxType === 'directv' ? 'SportsCenter' : null, callsign: c.boxType === 'directv' ? 'ESPNHD' : null,
    codes: (c.ir && c.ir.codes) || {}, learning: null, canTune: true, hasApps: false, error: null };
  Object.assign(t, {
    sendKey: async (name) => { if (t.type === 'ir' && !t.codes[name]) throw err(`${name.replace(/_/g, ' ').toLowerCase()} is not learned yet (⚙ → Learn keys)`, 409); if (name === 'POWER') t.powered = !t.powered; if (name === 'CHANNEL_UP' || name === 'CHANNEL_DOWN') { t.channel = String(Number(t.channel || 7) + (name === 'CHANNEL_UP' ? 1 : -1)); t.title = null; } },
    tune: async (n) => { t.channel = String(n); t.title = null; },
    learn: async (name) => { t.learning = name; broadcast(); await sleep(1500); t.codes[name] = 'demo'; t.learning = null; },
    forget: (name) => { delete t.codes[name]; },
    poll: async () => t, close: () => {},
  });
  return t;
}

function syncRooms() {
  for (const cfg of config.boxes) {
    if (!rooms.has(cfg.id)) rooms.set(cfg.id, { cfg, box: null, tv: null, sonyLink: null, focus: 'box' });
    const r = rooms.get(cfg.id); r.cfg = cfg;
    attachBox(r); attachTv(r);
  }
  for (const [id, r] of rooms) {
    if (!config.boxes.find((c) => c.id === id)) {
      try { r.box && r.box.close(); r.tv && r.tv.close(); r.sonyLink && r.sonyLink.close(); } catch {}
      clearInterval(r.boxPoll); clearInterval(r.tvPoll); rooms.delete(id);
    }
  }
}
syncRooms();

// ---------- what a key does in a room ----------------------------------------------
const TV_KEYS = { VOLUME_UP: 'volumeUp', VOLUME_DOWN: 'volumeDown', MUTE: 'mute', VOLUME_MUTE: 'mute', POWER: 'powerToggle', TV_POWER: 'powerToggle', ART_MODE: 'artMode' };
const NAV_KEYS = /^(DPAD_|BACK$|HOME$|MENU$|EXIT$|ENTER$|INFO$|MEDIA_|CAPTIONS$|SETTINGS$)/;
async function sendKey(r, name) {
  const tvAct = TV_KEYS[name];
  if (tvAct && r.tv && (tvRouted(r) || name === 'TV_POWER' || name === 'ART_MODE')) {
    if (!r.tv[tvAct]) throw err(`the ${r.tv.brand} TV cannot do ${name}`);
    try { await r.tv[tvAct](); } catch (e) { r.tv.error = e.message; broadcast(); throw Object.assign(e, { status: 502 }); }
    broadcast(); return;
  }
  if (name === 'ART_MODE') throw err('Art mode needs a Samsung Frame set up under ⚙');
  const toTv = r.focus === 'tv' && tvTakesKeys(r);
  const noBox = r.cfg.boxType === 'none' || !r.box;
  if (toTv || noBox) {
    if (r.sonyLink) { r.sonyLink.sendKey(name); return; }
    if (r.tv && r.tv.sendKey) {
      const code = TV.SAMSUNG_KEYS[name];
      if (!code) throw err(`a Samsung TV has no ${name} key`);
      await r.tv.sendKey(code).catch((e) => { throw Object.assign(e, { status: 502 }); });
      return;
    }
    throw err(`${r.cfg.name} has no box or TV that can take that key`, 409);
  }
  if (r.cfg.boxType === 'androidtv') { r.box.sendKey(name); return; }
  await r.box.sendKey(name); broadcast();
}
async function tuneChannel(r, number) {
  const digits = String(number).replace(/\D/g, '');
  if (!digits) throw err('no channel number');
  r.focus = 'box';
  if (r.cfg.boxType === 'none' || !r.box) { // TV-only room: the TV's own tuner
    for (const d of digits) { await sendKey(r, d); await sleep(300); }
    if (config.channelEnter !== 'none') await sendKey(r, 'ENTER');
  } else if (r.cfg.boxType === 'androidtv') await r.box.tune(digits);
  else await r.box.tune(digits);
  broadcast();
}
async function setVolume(r, target) {
  if (tvRouted(r) && r.tv.setVolume) { await r.tv.setVolume(target); broadcast(); return; }
  const v = tvRouted(r) ? r.tv.volume : r.box && r.box.volume;
  if (!v) throw err('volume level unknown yet; use + / −', 409);
  target = Math.max(0, Math.min(v.max, Math.round(target)));
  const steps = target - v.level, key = steps > 0 ? 'VOLUME_UP' : 'VOLUME_DOWN';
  for (let i = 0; i < Math.abs(steps); i++) { await sendKey(r, key); await sleep(120); }
}
async function openApp(r, appId) {
  const app = (config.apps || []).find((a) => a.id === appId);
  if (!app) throw err('unknown app', 404);
  if (r.cfg.boxType === 'androidtv' && r.box && !(app.boxOnly === false)) { r.focus = 'box'; r.box.openApp(app); broadcast(); return; }
  if (app.boxOnly) throw err(`${app.name} needs an Android TV box in the room`);
  if (r.sonyLink) { r.focus = 'tv'; r.sonyLink.openApp(app); broadcast(); return; }
  if (r.tv && r.tv.launchApp) {
    if (!app.samsung) throw err(`${app.name} is not set up for Samsung yet`);
    r.focus = 'tv'; await r.tv.launchApp(app.samsung); r.tv.app = app.pkg; broadcast(); return;
  }
  throw err(`${r.cfg.name} has nothing that can open apps`, 409);
}

// ---------- web ----------------------------------------------------------
const app = express();
app.use(express.json());
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'remote.html'), 'utf8');
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="House">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
</head><body>${PAGE}</body></html>`);
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

const getRoom = (req, res) => { const r = rooms.get(req.params.id); if (!r) res.status(404).json({ error: 'no such room' }); return r; };
const wrap = (fn) => async (req, res) => {
  try { const out = await fn(req, res); if (out !== undefined) res.json(out); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || String(e) }); }
};

app.get('/api/state', (_req, res) => res.json(publicState()));
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(publicState())}\n\n`);
  listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); listeners.delete(res); });
});

app.post('/api/box/:id/key', wrap(async (req, res) => { const r = getRoom(req, res); if (!r) return; await sendKey(r, String(req.body.key || '').toUpperCase().replace(/^KEYCODE_/, '')); return { ok: true }; }));
app.post('/api/box/:id/channel', wrap(async (req, res) => { const r = getRoom(req, res); if (!r) return; await tuneChannel(r, req.body.number); return { ok: true }; }));
app.post('/api/box/:id/volume', wrap(async (req, res) => { const r = getRoom(req, res); if (!r) return; await setVolume(r, Number(req.body.level)); return { ok: true, volume: publicRoom(r).volume }; }));
app.post('/api/box/:id/app', wrap(async (req, res) => { const r = getRoom(req, res); if (!r) return; await openApp(r, String(req.body.app || '')); return { ok: true }; }));
app.post('/api/box/:id/focus', wrap(async (req, res) => { const r = getRoom(req, res); if (!r) return; r.focus = req.body.focus === 'tv' ? 'tv' : 'box'; broadcast(); return { ok: true }; }));

// Android TV pairing — the box, or (target=tv) a Sony TV's own link.
const linkOf = (r, req) => (req.body && req.body.target === 'tv') || (req.query && req.query.target === 'tv') ? r.sonyLink : (r.cfg.boxType === 'androidtv' ? r.box : null);
app.post('/api/box/:id/pair', wrap(async (req, res) => { const r = getRoom(req, res); if (!r) return; const L = linkOf(r, req); if (!L) throw err('nothing to pair here'); L.connect({ pair: true }); return { ok: true }; }));
app.post('/api/box/:id/code', wrap(async (req, res) => {
  const r = getRoom(req, res); if (!r) return; const L = linkOf(r, req); if (!L) throw err('nothing to pair here');
  const code = String(req.body.code || '').trim().toUpperCase(); if (!code) throw err('enter the code the TV shows');
  L.sendCode(code); return { ok: true };
}));
app.post('/api/box/:id/pair/cancel', wrap(async (req, res) => { const r = getRoom(req, res); if (!r) return; const L = linkOf(r, req); if (L) L.cancelPairing(); return { ok: true }; }));
app.post('/api/box/:id/reconnect', wrap(async (req, res) => { const r = getRoom(req, res); if (!r) return; const L = linkOf(r, req); if (L) L.connect(); else if (r.box) r.box.poll(); return { ok: true }; }));

// Infrared: learn a key from the real remote, or forget one.
app.post('/api/box/:id/ir/learn', wrap(async (req, res) => {
  const r = getRoom(req, res); if (!r) return;
  if (r.cfg.boxType !== 'ir' || !r.box) throw err('this room has no infrared blaster');
  const key = String(req.body.key || '').toUpperCase();
  if (!CABLE.IR_KEYS.find(([k]) => k === key)) throw err('unknown key');
  await r.box.learn(key); broadcast();
  return { ok: true };
}));
app.post('/api/box/:id/ir/forget', wrap(async (req, res) => { const r = getRoom(req, res); if (!r) return; if (r.cfg.boxType !== 'ir' || !r.box) throw err('this room has no infrared blaster'); r.box.forget(String(req.body.key || '').toUpperCase()); broadcast(); return { ok: true }; }));

// TV in a room: save its settings, or (Samsung) ask the TV to Allow us.
app.post('/api/box/:id/tv', wrap(async (req, res) => {
  const r = getRoom(req, res); if (!r) return;
  const t = req.body || {}; const cfg = r.cfg;
  if (!t.brand) delete cfg.tv;
  else {
    const prev = cfg.tv || {};
    cfg.tv = { brand: t.brand, host: String(t.host || prev.host || '').trim(), route: t.route || prev.route || 'tv',
      psk: t.brand === 'sony' ? (t.psk !== undefined ? String(t.psk) : prev.psk) : undefined,
      token: t.brand === 'samsung' && t.host === prev.host ? prev.token : undefined,
      mac: t.mac || prev.mac, frame: t.frame !== undefined ? !!t.frame : prev.frame };
    if (!cfg.tv.host) throw err('type the TV IP address');
  }
  saveConfig(config); syncRooms(); broadcast();
  return publicState();
}));
app.post('/api/box/:id/tv/allow', wrap(async (req, res) => {
  const r = getRoom(req, res); if (!r) return;
  if (!r.tv || !r.tv.allow) throw err('only a Samsung TV needs Allow');
  r.tv.allow().then(broadcast).catch(() => broadcast());
  return { ok: true };
}));

// Find things on the LAN: Android TV boxes (mDNS), TVs (SSDP), infrared blasters (Broadlink).
async function discoverAll() {
  if (DEMO) return { found: [{ name: 'Optimum Stream (demo)', host: '192.168.1.52' }, { name: 'Optimum Stream (2)', host: '192.168.1.53' }], tvs: [{ brand: 'sony', host: '192.168.1.60' }, { brand: 'samsung', host: '192.168.1.61' }, { brand: 'samsung', host: '192.168.1.63' }], blasters: [{ host: '192.168.2.40', model: 'RM4 mini (demo)', mac: 'aa:bb:cc:00:11:22', devType: 20992 }] };
  const { Bonjour } = require('bonjour-service');
  const bonjour = new Bonjour();
  const found = new Map();
  const browser = bonjour.find({ type: 'androidtvremote2' }, (s) => {
    const host = (s.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || s.host;
    found.set(host, { name: s.name, host });
  });
  const [tvs, blasters] = await Promise.all([TV.ssdpSearch(3000), CABLE.discoverBlasters(), sleep(3000)]);
  browser.stop(); bonjour.destroy();
  return { found: [...found.values()], tvs, blasters };
}
app.get('/api/discover', wrap(() => discoverAll()));

// "Show every TV its own address": start a pairing with EVERY box found (each TV
// shows a code) and an Allow request on EVERY Samsung, each named with its own
// address. The person types the code on the TV in front of them; whichever box
// accepts it is that room's box, already paired.
const roomOf = (host) => (config.boxes.find((b) => b.host === host || (b.tv && b.tv.host === host)) || {}).name || null;
function publicIdentify() {
  if (!identify.active && !identify.matched) return null;
  return {
    active: identify.active, matched: identify.matched,
    boxes: [...identify.boxes.values()].map((L) => ({ host: L.host, status: L.status, needsCode: L.needsCode, error: L.lastError, room: roomOf(L.host) })),
    tvs: [...identify.tvs.values()].map((t) => ({ host: t.host, status: t.status, allowed: !!t.token, room: roomOf(t.host) })),
  };
}
function stopIdentify({ keepTvs = false } = {}) {
  for (const L of identify.boxes.values()) L.close();
  identify.boxes.clear();
  if (!keepTvs) { for (const t of identify.tvs.values()) { try { t.close(); } catch {} } identify.tvs.clear(); }
  identify.active = !!(keepTvs && identify.tvs.size);
  clearTimeout(identify.timer);
  broadcast();
}
async function startIdentify() {
  stopIdentify(); identify.matched = null;
  const d = await discoverAll(); identify.found = d;
  for (const f of d.found) {
    const L = androidLink(`find-${f.host}`, f.host, `box ${f.host}`, `House Controls · box ${f.host}`);
    identify.boxes.set(f.host, L);
    if (DEMO) { L.status = 'pairing'; L.needsCode = true; } else L.connect({ pair: true });
  }
  for (const t of d.tvs) {
    if (t.brand !== 'samsung') continue;
    const tv = DEMO ? { host: t.host, status: 'needs-allow', token: null, close() {} } : TV.samsung({ host: t.host, token: null, clientName: `House Controls · TV ${t.host}` }, broadcast, (token) => saveTvToken(t.host, token));
    tv.host = t.host; identify.tvs.set(t.host, tv);
    if (!DEMO) tv.allow().then(broadcast).catch(() => broadcast());
  }
  identify.active = true;
  identify.timer = setTimeout(() => stopIdentify(), 10 * 60 * 1000);
  broadcast();
  return publicIdentify();
}
app.post('/api/identify', wrap(() => startIdentify()));
app.post('/api/identify/stop', wrap(async () => { stopIdentify(); return { ok: true }; }));
app.post('/api/identify/code', wrap(async (req) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) throw err('type the code on the TV');
  const asking = [...identify.boxes.values()].filter((L) => L.needsCode);
  if (!asking.length) throw err('no box is showing a code right now; tap "Show every TV its address" again', 409);
  if (DEMO) { const L = asking[0]; L.status = 'ready'; L.needsCode = false; identify.matched = L.host; stopIdentify({ keepTvs: true }); return { host: L.host }; }
  for (const L of asking) { try { L.sendCode(code); } catch {} }
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const hit = asking.find((L) => L.status === 'ready');
    if (hit) { identify.matched = hit.host; stopIdentify({ keepTvs: true }); return { host: hit.host }; }
    await sleep(250);
  }
  throw err('that code did not match any box. Read it again from the TV in front of you and tap "Show every TV its address" once more', 409);
}));

// Update the bridge in place: pull the newest code, install, exit (systemd restarts it).
app.post('/api/update', wrap(async () => {
  if (DEMO) throw err('demo mode has nothing to update');
  const { execFile } = require('child_process');
  const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { cwd: __dirname, timeout: 240000 }, (e, out, errOut) => (e ? reject(new Error((errOut || e.message).trim().split('\n').pop())) : resolve(out))));
  const before = (await run('git', ['rev-parse', '--short', 'HEAD'])).trim();
  await run('git', ['pull', '--ff-only']);
  const after = (await run('git', ['rev-parse', '--short', 'HEAD'])).trim();
  if (before === after) return { ok: true, message: 'Already on the newest version.' };
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error']);
  setTimeout(() => { log('[update] restarting after update', before, '→', after); process.exit(0); }, 500);
  return { ok: true, message: `Updated ${before} → ${after}. Restarting…` };
}));

// Rooms + channels + options.
app.post('/api/config', wrap(async (req) => {
  const body = req.body || {};
  if (Array.isArray(body.channels)) config.channels = body.channels;
  if (Array.isArray(body.boxes)) {
    config.boxes = body.boxes.filter((b) => b && (b.host || b.name)).map((b) => {
      const id = b.id || slug(b.name || b.host);
      const prev = config.boxes.find((c) => c.id === id) || {};
      const host = String(b.host || '').trim();
      const boxType = b.boxType || (prev.boxType && prev.host === host ? prev.boxType : (host ? 'androidtv' : 'none'));
      const out = { ...prev, id, name: b.name || host || prev.name, host, boxType: host ? boxType : 'none' };
      if (b.ir) out.ir = { ...(prev.ir || {}), ...b.ir };
      if (!host) { delete out.ir; }
      return out;
    });
  }
  if (body.channelEnter) config.channelEnter = body.channelEnter;
  saveConfig(config); syncRooms(); broadcast();
  return publicState();
}));

app.listen(PORT, () => log(`Optimum Remote bridge on http://0.0.0.0:${PORT}${DEMO ? '  (DEMO mode)' : ''}`));
