'use strict';
// AprilAire 8800-series Wi-Fi thermostats over their local "automation" link: TCP port 8000 on
// the thermostat, a small binary protocol (framing + CRC-8), the thermostat pushes changes (COS).
// One automation connection per thermostat at a time; the AprilAire phone app is unaffected.
// Each thermostat must be switched to Connection Type: Automation in its Contractor Menu once.
const net = require('net');
const os = require('os');

const ACTION = { WRITE: 1, READ: 2, READ_RESPONSE: 3, COS: 5, NACK: 6 };
const DOMAIN = { SETUP: 1, CONTROL: 2, SCHEDULING: 3, SENSORS: 5, STATUS: 7, IDENT: 8 };
const MODES = { 1: 'Off', 2: 'Heat', 3: 'Cool', 4: 'Emergency heat', 5: 'Auto' };
const FANS = { 1: 'On', 2: 'Auto', 3: 'Circulate' };
const HOLDS = { 0: 'Following the schedule', 1: 'Holding', 2: 'Holding (permanent)', 3: 'Away', 4: 'Vacation' };
const NACKS = { 1: 'generic error', 3: 'thermostat busy', 4: 'unsupported protocol revision', 5: 'unknown action', 6: 'unknown functional domain', 7: 'unknown attribute', 8: 'value out of range', 9: 'attribute is read-only', 10: 'attribute is not readable' };
// Which change-of-state channels the thermostat should push (wire order; byte 21 is reserved).
const COS_MASK = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0];
const SEND_GAP_MS = 500;        // the thermostat wants a breath between frames
const RECONNECT_EVERY_MS = 3600000; // the socket goes quiet over time; a fresh one every hour is the known cure
const POLL_MS = 120000;         // belt and braces behind the COS pushes

// CRC-8, polynomial 0x31, init 0, no reflection, no final xor.
function crc8(bytes) {
  let crc = 0;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff; }
  return crc;
}
// Temperature byte: bits 0-5 whole degrees, bit 6 = +0.5, bit 7 = negative. Every temperature on the wire is
// CELSIUS (6 bits only reach 63); the thermostat's own F/C setting is just how its screen shows them, and so do we.
const c2f = (c) => c * 9 / 5 + 32, f2c = (f) => (f - 32) * 5 / 9;
const show = (c, scale) => (c == null ? null : scale === 'C' ? Math.round(c * 2) / 2 : Math.round(c2f(c)));
function decodeTemp(b) { const v = (b & 63) + ((b >> 6) & 1 ? 0.5 : 0); return b & 128 ? -v : v; }
function encodeTemp(t) { const neg = t < 0; const a = Math.abs(t); return Math.floor(a) + (a % 1 >= 0.5 ? 64 : 0) + (neg ? 128 : 0); }
function frame(seq, payload) { const out = [1, seq & 0xff, (payload.length >> 8) & 0xff, payload.length & 0xff, ...payload]; out.push(crc8(out)); return Buffer.from(out); }

// Split a byte stream into complete frames; returns [frames, leftover].
function splitFrames(buf) {
  const frames = []; let i = 0;
  while (buf.length - i >= 5) {
    const count = (buf[i + 2] << 8) | buf[i + 3]; const end = i + 4 + count + 1;
    if (end > buf.length) break;
    const f = buf.subarray(i, end);
    if (crc8(f.subarray(0, -1)) === f[f.length - 1]) frames.push(f);
    i = end;
  }
  return [frames, buf.subarray(i)];
}

function create({ log = () => {}, onChange = () => {} } = {}) {
  const stats = new Map();

  function makeStat(cfg) {
    const s = {
      cfg, sock: null, buf: Buffer.alloc(0), seq: 0, queue: [], sendTimer: null, retry: 0, reconnectTimer: null, hourly: null, poll: null,
      status: 'connecting', error: null, lastSeen: 0, synced: false,
      data: { temp: null, humidity: null, outdoorTemp: null, heat: null, cool: null, mode: null, fan: null, heating: 0, cooling: 0, fanOn: 0, hold: 0, holdEnd: null, scale: 'F', mac: null, unitName: null, modes: null },
    };
    connect(s);
    return s;
  }

  function connect(s) {
    clearTimeout(s.reconnectTimer); s.reconnectTimer = null;
    if (s.sock) { try { s.sock.destroy(); } catch {} }
    s.status = 'connecting'; s.synced = false; s.buf = Buffer.alloc(0); s.queue = [];
    const sock = net.createConnection({ host: s.cfg.host, port: s.cfg.port || 8000 });
    s.sock = sock;
    sock.setTimeout(30000);
    sock.setKeepAlive(true, 15000);
    sock.on('connect', () => {
      s.retry = 0; s.error = null; s.status = 'ok'; s.lastSeen = Date.now();
      log(`[aprilaire] ${s.cfg.name || s.cfg.host} connected`);
      onChange();
      // The thermostat likes a 2 s pause after connecting before the first request.
      setTimeout(() => { if (s.sock === sock) firstReads(s); }, 2000);
      clearInterval(s.hourly); s.hourly = setInterval(() => { log(`[aprilaire] ${s.cfg.name || s.cfg.host} hourly reconnect`); connect(s); }, RECONNECT_EVERY_MS);
      clearInterval(s.poll); s.poll = setInterval(() => { if (s.status === 'ok') { read(s, DOMAIN.SENSORS, 2); read(s, DOMAIN.STATUS, 6); read(s, DOMAIN.CONTROL, 1); } }, POLL_MS);
    });
    sock.on('data', (chunk) => {
      s.buf = Buffer.concat([s.buf, chunk]);
      const [frames, rest] = splitFrames(s.buf); s.buf = rest;
      for (const f of frames) handleFrame(s, f);
    });
    sock.on('timeout', () => { /* idle is normal; the keepalive + hourly reconnect cover a dead peer */ });
    const down = (why) => {
      if (s.sock !== sock) return;
      s.sock = null; s.status = 'offline'; s.error = why; clearInterval(s.hourly); clearInterval(s.poll); clearTimeout(s.sendTimer); s.sendTimer = null;
      log(`[aprilaire] ${s.cfg.name || s.cfg.host} ${why}`);
      onChange();
      const wait = Math.min(60000, 5000 * 2 ** Math.min(s.retry++, 4));
      s.reconnectTimer = setTimeout(() => { if (stats.get(s.cfg.id) === s) connect(s); }, wait);
    };
    sock.on('error', (e) => down(e.code === 'ECONNREFUSED' ? 'refused the connection (is Connection Type set to Automation?)' : e.code === 'EHOSTUNREACH' || e.code === 'ETIMEDOUT' ? 'not reachable' : e.message));
    sock.on('close', () => down(s.error || 'connection closed'));
  }

  function firstReads(s) {
    read(s, DOMAIN.IDENT, 2); read(s, DOMAIN.STATUS, 6); read(s, DOMAIN.CONTROL, 1); read(s, DOMAIN.CONTROL, 7); read(s, DOMAIN.SENSORS, 2);
    read(s, DOMAIN.IDENT, 5); read(s, DOMAIN.SCHEDULING, 4); read(s, DOMAIN.SETUP, 1);
    send(s, [ACTION.WRITE, DOMAIN.STATUS, 1, ...COS_MASK]); // subscribe to the pushes we show
    send(s, [ACTION.WRITE, DOMAIN.STATUS, 2, 1]);           // sync: the thermostat answers with everything subscribed
  }

  function send(s, payload) { s.queue.push(payload); pump(s); }
  function read(s, domain, attr) { send(s, [ACTION.READ, domain, attr]); }
  function pump(s) {
    if (s.sendTimer || !s.sock || !s.queue.length) return;
    const payload = s.queue.shift();
    s.seq = (s.seq + 1) & 0x7f;
    try { s.sock.write(frame(s.seq, payload)); } catch (e) { log(`[aprilaire] write failed: ${e.message}`); }
    s.sendTimer = setTimeout(() => { s.sendTimer = null; pump(s); }, SEND_GAP_MS);
  }

  function handleFrame(s, f) {
    s.lastSeen = Date.now();
    const body = f.subarray(4, -1);
    const action = body[0];
    if (action === ACTION.NACK) { const code = body[1]; log(`[aprilaire] ${s.cfg.name || s.cfg.host} NACK ${code} (${NACKS[code] || 'unknown'})`); return; }
    if (action !== ACTION.READ_RESPONSE && action !== ACTION.COS) return;
    const domain = body[1], attr = body[2], d = body.subarray(3), D = s.data;
    const temp = (i) => (d.length > i && d[i] !== 0 ? decodeTemp(d[i]) : undefined);
    const before = JSON.stringify(D) + s.synced;
    let changed = true;
    if (domain === DOMAIN.CONTROL && attr === 1) {
      if (d[0]) D.mode = d[0]; if (d[1]) D.fan = d[1];
      if (temp(2) !== undefined) D.heat = temp(2); if (temp(3) !== undefined) D.cool = temp(3);
    } else if (domain === DOMAIN.CONTROL && attr === 7) { D.modes = d[0];
    } else if (domain === DOMAIN.SENSORS && attr === 2) {
      // [indoor temp status, indoor temp, outdoor temp status, outdoor temp, indoor rh status, indoor rh, ...]
      if (d[0] === 0 && d.length > 1) D.temp = decodeTemp(d[1]);
      if (d.length > 3) D.outdoorTemp = d[2] === 0 ? decodeTemp(d[3]) : null;
      if (d.length > 5) D.humidity = d[4] === 0 && d[5] <= 100 ? d[5] : null;
    } else if (domain === DOMAIN.STATUS && attr === 6) { D.heating = d[0]; D.cooling = d[1]; D.fanOn = d[3];
    } else if (domain === DOMAIN.STATUS && attr === 2) { s.synced = d[0] === 1;
    } else if (domain === DOMAIN.SCHEDULING && attr === 4) {
      D.hold = d[0];
      // hold end: minute, hour, date, month, year (+2000); only meaningful for a temporary hold
      D.holdEnd = d[0] === 1 && d.length > 9 && d[8] ? new Date(2000 + d[9], d[8] - 1, d[7], d[6], d[5]).getTime() : null;
    } else if (domain === DOMAIN.IDENT && attr === 2) { D.mac = [...d.subarray(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join(':');
    } else if (domain === DOMAIN.IDENT && attr === 5) {
      const txt = (from, len) => [...d.subarray(from, from + len)].map((b) => (b ? String.fromCharCode(b) : ' ')).join('').trim();
      D.unitName = [txt(0, 7), txt(8, 15)].filter(Boolean).join(' ');
    } else if (domain === DOMAIN.SETUP && attr === 1) { D.scale = d[2] === 1 ? 'C' : 'F';
    } else changed = false;
    // Only a real change wakes the screens: a poll that reads the same numbers back is not news.
    if (changed && JSON.stringify(D) + s.synced !== before) onChange();
  }

  // ---- what the app sees ----
  function pub(s) {
    const D = s.data, deg = D.scale === 'C' ? '°C' : '°';
    const running = D.heating > 1 ? 'Heating' : D.cooling > 1 ? 'Cooling' : D.heating === 1 || D.cooling === 1 ? 'Starting' : D.fanOn ? 'Fan running' : D.mode === 1 ? 'Off' : 'Idle';
    return {
      id: s.cfg.id, name: s.cfg.name || D.unitName || s.cfg.host, host: s.cfg.host, port: s.cfg.port || 8000, unitName: D.unitName,
      status: s.status, error: s.error, lastSeen: s.lastSeen, synced: s.synced,
      temp: show(D.temp, D.scale), humidity: D.humidity, outdoorTemp: show(D.outdoorTemp, D.scale), heat: show(D.heat, D.scale), cool: show(D.cool, D.scale), scale: D.scale, deg,
      tempC: D.temp, heatC: D.heat, coolC: D.cool,
      mode: D.mode, modeName: MODES[D.mode] || null, fan: D.fan, fanName: FANS[D.fan] || null,
      running, heating: D.heating, cooling: D.cooling, fanOn: !!D.fanOn,
      hold: D.hold, holdName: HOLDS[D.hold] || null, holdEnd: D.holdEnd, modes: D.modes, mac: D.mac,
    };
  }
  const list = () => [...stats.values()].map(pub);
  const get = (id) => { const s = stats.get(id); if (!s) throw new Error('unknown thermostat'); if (s.status !== 'ok') throw new Error(`${s.cfg.name || s.cfg.host} is ${s.status === 'connecting' ? 'still connecting' : 'not reachable'}`); return s; };

  // ---- writes: CONTROL/1 carries mode, fan, heat, cool; a 0 leaves that field alone ----
  // A setpoint arrives in the thermostat's display units and goes out in half-degrees Celsius.
  const toWire = (t, scale) => { const v = Math.round((scale === 'C' ? t : f2c(t)) * 2) / 2; if (!(v >= 7 && v <= 35)) throw new Error(`${t}° is outside ${scale === 'C' ? '7–35' : '45–95'}°`); return v; };
  function setMode(id, mode) { const s = get(id); if (!MODES[mode]) throw new Error('unknown mode'); send(s, [ACTION.WRITE, DOMAIN.CONTROL, 1, mode, 0, 0, 0]); s.data.mode = mode; onChange(); setTimeout(() => read(s, DOMAIN.CONTROL, 1), 1500); return pub(s); }
  function setFan(id, fan) { const s = get(id); if (!FANS[fan]) throw new Error('unknown fan setting'); send(s, [ACTION.WRITE, DOMAIN.CONTROL, 1, 0, fan, 0, 0]); s.data.fan = fan; onChange(); setTimeout(() => read(s, DOMAIN.CONTROL, 1), 1500); return pub(s); }
  function setPoints(id, { heat, cool }) {
    const s = get(id), D = s.data;
    const h = heat == null ? 0 : toWire(heat, D.scale), c = cool == null ? 0 : toWire(cool, D.scale);
    if (!h && !c) throw new Error('nothing to set');
    send(s, [ACTION.WRITE, DOMAIN.CONTROL, 1, 0, 0, h ? encodeTemp(h) : 0, c ? encodeTemp(c) : 0]);
    if (h) D.heat = h; if (c) D.cool = c; onChange();
    setTimeout(() => { read(s, DOMAIN.CONTROL, 1); read(s, DOMAIN.SCHEDULING, 4); }, 1500);
    return pub(s);
  }
  function setHold(id, hold) { const s = get(id); if (!HOLDS[hold]) throw new Error('unknown hold'); send(s, [ACTION.WRITE, DOMAIN.SCHEDULING, 4, hold, 0, 0, 0, 0, 0, 0, 0, 0, 0]); s.data.hold = hold; if (!hold) s.data.holdEnd = null; onChange(); setTimeout(() => { read(s, DOMAIN.SCHEDULING, 4); read(s, DOMAIN.CONTROL, 1); }, 1500); return pub(s); }
  // One step on the screen: a whole degree in F, half a degree in C, from what the screen shows now.
  function bump(id, which, delta) {
    const s = get(id), D = s.data, cur = which === 'cool' ? D.cool : D.heat;
    if (cur == null) throw new Error('no setpoint yet');
    const next = show(cur, D.scale) + (D.scale === 'C' ? 0.5 : 1) * Math.sign(delta || 1);
    return setPoints(id, which === 'cool' ? { cool: next } : { heat: next });
  }
  function refresh(id) { const s = get(id); read(s, DOMAIN.SENSORS, 2); read(s, DOMAIN.CONTROL, 1); read(s, DOMAIN.STATUS, 6); read(s, DOMAIN.SCHEDULING, 4); return pub(s); }

  // ---- the configured list: add, keep, drop ----
  function stop(s) { clearTimeout(s.reconnectTimer); clearInterval(s.hourly); clearInterval(s.poll); clearTimeout(s.sendTimer); s.sendTimer = null; const sock = s.sock; s.sock = null; if (sock) { try { sock.destroy(); } catch {} } }
  function setList(cfgs) {
    const keep = new Set();
    for (const c of cfgs || []) {
      if (!c || !c.host || !c.id) continue;
      keep.add(c.id);
      const cur = stats.get(c.id);
      if (cur && cur.cfg.host === c.host && (cur.cfg.port || 8000) === (c.port || 8000)) { cur.cfg = { ...cur.cfg, name: c.name }; continue; }
      if (cur) stop(cur);
      stats.set(c.id, makeStat({ id: c.id, name: c.name, host: c.host, port: c.port || 8000 }));
    }
    for (const [id, s] of stats) if (!keep.has(id)) { stop(s); stats.delete(id); }
    onChange();
  }
  function stopAll() { for (const s of stats.values()) stop(s); stats.clear(); }

  // ---- find thermostats: anything on the Pi's own /24 networks answering on port 8000, then asked for its name ----
  function probe(host, port = 8000) {
    return new Promise((resolve) => {
      const sock = net.createConnection({ host, port }); let buf = Buffer.alloc(0); let seq = 0; const out = { host, port, name: null, mac: null, open: false };
      const done = () => { clearTimeout(t); try { sock.destroy(); } catch {} resolve(out); };
      const t = setTimeout(done, 5500);
      sock.setTimeout(1500, () => { if (!out.open) done(); });
      sock.on('connect', () => { out.open = true; setTimeout(() => { try { sock.write(frame(++seq, [ACTION.READ, DOMAIN.IDENT, 5])); } catch {} }, 1000); setTimeout(() => { try { sock.write(frame(++seq, [ACTION.READ, DOMAIN.IDENT, 2])); } catch {} }, 1600); });
      sock.on('data', (c) => {
        buf = Buffer.concat([buf, c]); const [frames, rest] = splitFrames(buf); buf = rest;
        for (const f of frames) {
          const b = f.subarray(4, -1); if (b[0] !== ACTION.READ_RESPONSE || b[1] !== DOMAIN.IDENT) continue;
          const d = b.subarray(3);
          if (b[2] === 5) { const txt = (from, len) => [...d.subarray(from, from + len)].map((x) => (x ? String.fromCharCode(x) : ' ')).join('').trim(); out.name = [txt(0, 7), txt(8, 15)].filter(Boolean).join(' ') || 'Thermostat'; }
          if (b[2] === 2) out.mac = [...d.subarray(0, 6)].map((x) => x.toString(16).padStart(2, '0')).join(':');
          if (out.name && out.mac) done();
        }
      });
      sock.on('error', done); sock.on('close', () => { if (!out.open) done(); });
    });
  }
  async function scan() {
    const nets = []; for (const list of Object.values(os.networkInterfaces())) for (const n of list) if (n.family === 'IPv4' && !n.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(n.address)) nets.push(n.address.split('.').slice(0, 3).join('.'));
    const hosts = [...new Set(nets)].flatMap((p) => Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`));
    const known = new Set([...stats.values()].map((s) => s.cfg.host));
    const open = [];
    for (let i = 0; i < hosts.length; i += 64) {
      await Promise.all(hosts.slice(i, i + 64).map((h) => new Promise((resolve) => {
        if (known.has(h)) return resolve();
        const sock = net.createConnection({ host: h, port: 8000 }); const t = setTimeout(() => { sock.destroy(); resolve(); }, 1200);
        sock.on('connect', () => { clearTimeout(t); sock.destroy(); open.push(h); resolve(); }); sock.on('error', () => { clearTimeout(t); resolve(); });
      })));
    }
    const found = (await Promise.all(open.map((h) => probe(h)))).filter((r) => r.name || r.mac).map((r) => ({ host: r.host, name: r.name, mac: r.mac }));
    const already = [...stats.values()].map((s) => ({ host: s.cfg.host, name: s.cfg.name || s.data.unitName, mac: s.data.mac, known: true }));
    return { found, already, networks: [...new Set(nets)].map((p) => `${p}.x`) };
  }

  return { setList, list, setMode, setFan, setPoints, setHold, bump, refresh, scan, probe, stopAll, MODES, FANS, HOLDS };
}

module.exports = { create, crc8, decodeTemp, encodeTemp, frame, splitFrames, c2f, f2c };
