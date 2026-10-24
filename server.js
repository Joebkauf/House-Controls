// Optimum Remote bridge — runs on a PC / Raspberry Pi on the same Wi-Fi as the
// Optimum Stream boxes. Speaks the Android TV Remote v2 protocol to each box
// (the same thing the Google TV phone app does; no developer mode needed) and
// serves the iPad page from /public.
//
//   DEMO=1 node server.js   → fake boxes, so the page can be tried anywhere
//   PORT=4680 node server.js
//   DATA_DIR=./data         → config.json + one cert file per paired box
'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const TV = require('./tv');

const PORT = Number(process.env.PORT || 4680);
const DEMO = process.env.DEMO === '1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const CERT_DIR = path.join(DATA_DIR, 'certs');
fs.mkdirSync(CERT_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toLocaleTimeString('en-US'), ...a);

// ---------- config -------------------------------------------------------
function loadConfig() {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  if (!cfg) {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.example.json'), 'utf8'));
    if (DEMO) cfg.boxes = [
      { id: 'living', name: 'Living Room', host: '192.168.1.50', tv: { brand: 'sony', host: '192.168.1.60', psk: 'demo', route: 'tv' } },
      { id: 'bedroom', name: 'Bedroom', host: '192.168.1.51', tv: { brand: 'samsung', host: '192.168.1.61', frame: true, route: 'tv' } },
    ];
    saveConfig(cfg);
  }
  cfg.boxes = cfg.boxes || [];
  cfg.channels = cfg.channels || [];
  cfg.channelEnter = cfg.channelEnter || 'none'; // 'none' | 'enter' | 'center'
  return cfg;
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}
let config = loadConfig();

// ---------- box state ----------------------------------------------------
// status: needs-pairing | pairing | connecting | ready | offline
const boxes = new Map(); // id -> { cfg, status, powered, volume, app, remote, lastError }
const listeners = new Set(); // SSE clients
function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of listeners) res.write(payload);
}
const tvRouted = (b) => !!(b.tv && (b.cfg.tv.route || 'tv') === 'tv');
function publicBox(b) {
  const tv = b.tv;
  return {
    id: b.cfg.id, name: b.cfg.name, host: b.cfg.host,
    status: b.status, needsCode: !!b.needsCode, lastChannel: b.lastChannel || null,
    powered: b.powered, volume: tvRouted(b) ? tv.volume : b.volume, app: b.app,
    volumeFrom: tvRouted(b) ? 'tv' : 'box',
    tv: b.cfg.tv && b.cfg.tv.brand ? {
      brand: b.cfg.tv.brand, host: b.cfg.tv.host, route: b.cfg.tv.route || 'tv', hasPsk: !!b.cfg.tv.psk,
      status: tv ? tv.status : 'unknown', powered: tv ? tv.powered : null, frame: !!(tv && tv.frame),
      model: tv && tv.model || null, error: tv && tv.error || null, paired: !!(tv && (tv.brand === 'sony' || tv.token)),
    } : null,
    lastError: b.lastError || null,
  };
}
function publicState() {
  return {
    demo: DEMO,
    boxes: [...boxes.values()].map(publicBox),
    channels: config.channels,
    channelEnter: config.channelEnter,
  };
}

const certPath = (id) => path.join(CERT_DIR, `${id}.json`);
function readCert(id) {
  try { return JSON.parse(fs.readFileSync(certPath(id), 'utf8')); } catch { return null; }
}

// Real protocol ------------------------------------------------------------
let AndroidRemote, RemoteKeyCode, RemoteDirection;
if (!DEMO) ({ AndroidRemote, RemoteKeyCode, RemoteDirection } = require('androidtv-remote'));

function keyCode(name) {
  if (DEMO) return name;
  const k = RemoteKeyCode[`KEYCODE_${name}`];
  if (k === undefined) throw new Error(`unknown key ${name}`);
  return k;
}

async function connectBox(b, { pair = false } = {}) {
  if (DEMO) return demoConnect(b);
  if (b.remote) { try { b.remote.stop(); } catch { /* ignore */ } b.remote = null; }
  const cert = pair ? null : readCert(b.cfg.id);
  if (!cert && !pair) { b.status = 'needs-pairing'; broadcast(); return; }
  b.status = pair ? 'pairing' : 'connecting';
  b.lastError = null;
  broadcast();
  const remote = new AndroidRemote(b.cfg.host, {
    pairing_port: 6467, remote_port: 6466, service_name: 'Optimum Remote', cert: cert || {},
  });
  b.remote = remote;
  remote.on('secret', () => { b.status = 'pairing'; b.needsCode = true; broadcast(); });
  remote.on('powered', (p) => { b.powered = p; broadcast(); });
  remote.on('volume', (v) => { b.volume = { level: v.level, max: v.maximum, muted: v.muted }; broadcast(); });
  remote.on('current_app', (a) => { b.app = a; broadcast(); });
  remote.on('error', (e) => { b.lastError = String(e && e.error ? JSON.stringify(e.error) : e); log(`[${b.cfg.id}] error`, b.lastError); broadcast(); });
  remote.on('unpaired', () => {
    log(`[${b.cfg.id}] box says we are not paired`);
    try { fs.unlinkSync(certPath(b.cfg.id)); } catch { /* none */ }
    b.status = 'needs-pairing'; b.remote = null; broadcast();
  });
  remote.on('ready', () => {
    b.status = 'ready'; b.needsCode = false;
    fs.writeFileSync(certPath(b.cfg.id), JSON.stringify(remote.getCertificate()));
    log(`[${b.cfg.id}] ready`);
    broadcast();
  });
  try {
    const started = await remote.start();
    if (!started && b.status !== 'ready') {
      b.status = cert ? 'offline' : 'needs-pairing';
      b.lastError = b.lastError || 'could not connect';
      broadcast();
    }
  } catch (e) {
    b.status = cert ? 'offline' : 'needs-pairing';
    b.lastError = e.code || e.message || String(e);
    log(`[${b.cfg.id}] connect failed`, b.lastError);
    broadcast();
  }
}

const TV_KEYS = { VOLUME_UP: 'volumeUp', VOLUME_DOWN: 'volumeDown', MUTE: 'mute', VOLUME_MUTE: 'mute', POWER: 'powerToggle', TV_POWER: 'powerToggle', ART_MODE: 'artMode' };
function sendKey(b, name) {
  const tvAct = TV_KEYS[name];
  if (tvAct && b.tv && (tvRouted(b) || name === 'TV_POWER' || name === 'ART_MODE')) {
    if (!b.tv[tvAct]) throw Object.assign(new Error(`${b.tv.brand} TV cannot do ${name}`), { status: 400 });
    return b.tv[tvAct]().then(broadcast).catch((e) => { b.tv.error = e.message; broadcast(); throw Object.assign(e, { status: 502 }); });
  }
  if (name === 'ART_MODE') throw Object.assign(new Error('Art mode needs a Samsung Frame set up under ⚙'), { status: 400 });
  if (b.status !== 'ready') throw Object.assign(new Error(`${b.cfg.name} is ${b.status}`), { status: 409 });
  if (DEMO) return demoKey(b, name);
  b.remote.sendKey(keyCode(name), RemoteDirection.SHORT);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tuneChannel(b, number) {
  const digits = String(number).replace(/\D/g, '');
  if (!digits) throw Object.assign(new Error('no channel number'), { status: 400 });
  for (const d of digits) { sendKey(b, d); await sleep(220); }
  if (config.channelEnter === 'enter') sendKey(b, 'ENTER');
  if (config.channelEnter === 'center') sendKey(b, 'DPAD_CENTER');
  b.lastChannel = digits; broadcast();
}

async function setVolume(b, target) {
  if (tvRouted(b) && b.tv.setVolume) { await b.tv.setVolume(target); broadcast(); return; }
  const v = tvRouted(b) ? b.tv.volume : b.volume;
  if (!v) throw Object.assign(new Error('volume level unknown yet; use + / −'), { status: 409 });
  target = Math.max(0, Math.min(v.max, Math.round(target)));
  const steps = target - v.level;
  const key = steps > 0 ? 'VOLUME_UP' : 'VOLUME_DOWN';
  for (let i = 0; i < Math.abs(steps); i++) { await sendKey(b, key); await sleep(120); }
}

// ---------- the TV behind each box -------------------------------------------
function attachTv(b) {
  const cfg = b.cfg.tv;
  const sig = cfg && cfg.brand ? JSON.stringify([cfg.brand, cfg.host, cfg.psk, cfg.port, cfg.plainWs, cfg.infoPort]) : '';
  if (b.tvSig === sig) { if (b.tv) b.tv.frame = b.tv.frame || !!(cfg && cfg.frame); return; }
  if (b.tv) { try { b.tv.close(); } catch {} clearInterval(b.tvPoll); b.tv = null; }
  b.tvSig = sig;
  if (!sig) return;
  if (DEMO) { b.tv = demoTv(cfg); return; }
  const onChange = () => broadcast();
  if (cfg.brand === 'sony') b.tv = TV.sony(cfg, onChange);
  else if (cfg.brand === 'samsung') b.tv = TV.samsung(cfg, onChange, (token) => { cfg.token = token; saveConfig(config); });
  else return;
  b.tv.poll().catch(() => {});
  b.tvPoll = setInterval(() => b.tv && b.tv.poll().catch(() => {}), 15000);
}
function demoTv(cfg) {
  const t = { brand: cfg.brand, frame: cfg.brand === 'samsung' && cfg.frame !== false, status: 'ok', powered: true, model: cfg.brand === 'sony' ? 'XR-65A80L (demo)' : 'QN55LS03B (demo)',
    volume: cfg.brand === 'sony' ? { level: 18, max: 100, muted: false } : null };
  const step = (d) => async () => { if (t.volume) t.volume.level = Math.max(0, Math.min(t.volume.max, t.volume.level + d)); };
  Object.assign(t, {
    volumeUp: step(2), volumeDown: step(-2),
    setVolume: cfg.brand === 'sony' ? async (n) => { t.volume.level = Math.max(0, Math.min(100, Math.round(n))); } : null,
    mute: async () => { if (t.volume) t.volume.muted = !t.volume.muted; },
    powerToggle: async () => { t.powered = !t.powered; }, powerOn: async () => { t.powered = true; }, powerOff: async () => { t.powered = false; },
    artMode: cfg.brand === 'samsung' ? async () => { t.art = !t.art; } : null,
    allow: async () => { t.token = 'demo'; }, poll: async () => t, close: () => {},
  });
  return t;
}

// Demo stand-ins -----------------------------------------------------------
function demoConnect(b) {
  b.status = 'ready'; b.powered = true;
  b.volume = b.volume || { level: 12, max: 40, muted: false };
  b.app = b.app || 'com.altice.optimum.tv';
  broadcast();
}
function demoKey(b, name) {
  const v = b.volume;
  if (name === 'VOLUME_UP') v.level = Math.min(v.max, v.level + 1);
  else if (name === 'VOLUME_DOWN') v.level = Math.max(0, v.level - 1);
  else if (name === 'MUTE' || name === 'VOLUME_MUTE') v.muted = !v.muted;
  else if (name === 'POWER') b.powered = !b.powered;
  else if (name === 'HOME') b.app = 'com.google.android.tvlauncher';
  else if (/^\d$/.test(name) || name === 'CHANNEL_UP' || name === 'CHANNEL_DOWN') b.app = 'com.altice.optimum.tv';
  broadcast();
}

// ---------- boot every configured box --------------------------------------
function syncBoxes() {
  for (const cfg of config.boxes) {
    if (!boxes.has(cfg.id)) {
      const b = { cfg, status: 'needs-pairing', powered: null, volume: null, app: null, remote: null };
      boxes.set(cfg.id, b);
      connectBox(b);
    } else boxes.get(cfg.id).cfg = cfg;
    attachTv(boxes.get(cfg.id));
  }
  for (const [id, b] of boxes) {
    if (!config.boxes.find((c) => c.id === id)) { try { b.remote && b.remote.stop(); b.tv && b.tv.close(); } catch { /* ignore */ } clearInterval(b.tvPoll); boxes.delete(id); }
  }
}
syncBoxes();

// ---------- web ----------------------------------------------------------
const app = express();
app.use(express.json());

const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'remote.html'), 'utf8');
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="TV">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
</head><body>${PAGE}</body></html>`);
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

const getBox = (req, res) => {
  const b = boxes.get(req.params.id);
  if (!b) res.status(404).json({ error: 'no such box' });
  return b;
};
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

app.post('/api/box/:id/key', wrap(async (req, res) => {
  const b = getBox(req, res); if (!b) return;
  const name = String(req.body.key || '').toUpperCase().replace(/^KEYCODE_/, '');
  await sendKey(b, name);
  return { ok: true };
}));
app.post('/api/box/:id/channel', wrap(async (req, res) => {
  const b = getBox(req, res); if (!b) return;
  await tuneChannel(b, req.body.number);
  return { ok: true };
}));
app.post('/api/box/:id/volume', wrap(async (req, res) => {
  const b = getBox(req, res); if (!b) return;
  await setVolume(b, Number(req.body.level));
  return { ok: true, volume: publicBox(b).volume };
}));
app.post('/api/box/:id/applink', wrap(async (req, res) => {
  const b = getBox(req, res); if (!b) return;
  if (b.status !== 'ready') throw Object.assign(new Error(`${b.cfg.name} is ${b.status}`), { status: 409 });
  if (!DEMO) b.remote.sendAppLink(String(req.body.url));
  return { ok: true };
}));
app.post('/api/box/:id/pair', wrap(async (req, res) => {
  const b = getBox(req, res); if (!b) return;
  if (DEMO) { b.status = 'pairing'; b.needsCode = true; broadcast(); return { ok: true }; }
  connectBox(b, { pair: true }); // the TV shows a 6-character code
  return { ok: true };
}));
app.post('/api/box/:id/code', wrap(async (req, res) => {
  const b = getBox(req, res); if (!b) return;
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) throw Object.assign(new Error('enter the code the TV shows'), { status: 400 });
  if (DEMO) { b.needsCode = false; demoConnect(b); return { ok: true }; }
  if (!b.remote || !b.needsCode) throw Object.assign(new Error('the box is not asking for a code right now'), { status: 409 });
  b.remote.sendCode(code);
  return { ok: true };
}));
app.post('/api/box/:id/reconnect', wrap(async (req, res) => {
  const b = getBox(req, res); if (!b) return;
  connectBox(b);
  return { ok: true };
}));

// TV behind a box: save its settings, or (Samsung) ask the TV to Allow us.
app.post('/api/box/:id/tv', wrap(async (req, res) => {
  const b = getBox(req, res); if (!b) return;
  const t = req.body || {};
  const cfg = config.boxes.find((c) => c.id === b.cfg.id);
  if (!t.brand) { delete cfg.tv; }
  else {
    const prev = cfg.tv || {};
    cfg.tv = { brand: t.brand, host: String(t.host || prev.host || '').trim(), route: t.route || prev.route || 'tv',
      psk: t.brand === 'sony' ? (t.psk !== undefined ? String(t.psk) : prev.psk) : undefined,
      token: t.brand === 'samsung' && t.host === prev.host ? prev.token : undefined,
      mac: t.mac || prev.mac, frame: t.frame !== undefined ? !!t.frame : prev.frame };
    if (!cfg.tv.host) throw Object.assign(new Error('type the TV IP address'), { status: 400 });
  }
  saveConfig(config); b.cfg = cfg; attachTv(b); broadcast();
  return publicState();
}));
app.post('/api/box/:id/tv/allow', wrap(async (req, res) => {
  const b = getBox(req, res); if (!b) return;
  if (!b.tv || !b.tv.allow) throw Object.assign(new Error('only a Samsung TV needs Allow'), { status: 400 });
  b.tv.allow().then(broadcast).catch(() => broadcast()); // the TV pops its prompt; the token arrives later
  return { ok: true };
}));

// Find boxes (mDNS: Android TV remote service) and TVs (SSDP) on the LAN.
app.get('/api/discover', wrap(async () => {
  if (DEMO) return { found: [{ name: 'Optimum Stream (demo)', host: '192.168.1.52' }], tvs: [{ brand: 'sony', host: '192.168.1.60' }, { brand: 'samsung', host: '192.168.1.61' }] };
  const { Bonjour } = require('bonjour-service');
  const bonjour = new Bonjour();
  const found = new Map();
  const browser = bonjour.find({ type: 'androidtvremote2' }, (s) => {
    const host = (s.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || s.host;
    found.set(host, { name: s.name, host });
  });
  const tvs = TV.ssdpSearch(3000);
  await sleep(3000);
  browser.stop(); bonjour.destroy();
  return { found: [...found.values()], tvs: await tvs };
}));

app.post('/api/config', wrap(async (req) => {
  const body = req.body || {};
  if (Array.isArray(body.channels)) config.channels = body.channels;
  if (Array.isArray(body.boxes)) {
    config.boxes = body.boxes
      .filter((b) => b && b.host)
      .map((b) => {
        const id = b.id || slug(b.name || b.host);
        const prev = config.boxes.find((c) => c.id === id);
        return { id, name: b.name || b.host, host: String(b.host).trim(), ...(prev && prev.tv ? { tv: prev.tv } : {}) };
      });
  }
  if (body.channelEnter) config.channelEnter = body.channelEnter;
  saveConfig(config);
  syncBoxes();
  broadcast();
  return publicState();
}));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'box';

app.listen(PORT, () => log(`Optimum Remote bridge on http://0.0.0.0:${PORT}${DEMO ? '  (DEMO mode)' : ''}`));
