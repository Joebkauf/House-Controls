// Direct TV control for the sets behind the Stream boxes, so volume and power
// do not depend on HDMI-CEC.
//   Sony Bravia  : JSON REST on http://<tv>/sony/{audio,system} with a
//                  Pre-Shared Key (TV: Settings → Network → Home Network →
//                  IP Control → Authentication = Normal and Pre-Shared Key).
//   Samsung Tizen (2016+, The Frame included): WebSocket remote on :8002.
//                  First connection pops "Allow" on the TV; the token it hands
//                  back is saved so it never asks again.
// Both get power-on through Wake-on-LAN when they are asleep.
'use strict';
const dgram = require('dgram');
const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wakeOnLan(mac) {
  if (!mac) return Promise.resolve(false);
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) return Promise.resolve(false);
  const m = Buffer.from(hex, 'hex');
  const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(m)]);
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => { try { s.close(); } catch {} resolve(false); });
    s.bind(() => {
      s.setBroadcast(true);
      s.send(pkt, 9, '255.255.255.255', () => { try { s.close(); } catch {} resolve(true); });
    });
  });
}

async function fetchJson(url, opts = {}, ms = 2500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json: j };
  } finally { clearTimeout(t); }
}

// ---------------- Sony Bravia --------------------------------------------
function sony(cfg, onChange) {
  const base = `http://${cfg.host}${cfg.port ? ':' + cfg.port : ''}/sony`;
  const headers = { 'Content-Type': 'application/json', 'X-Auth-PSK': cfg.psk || '' };
  const call = async (svc, method, params = [], version = '1.0') => {
    const r = await fetchJson(`${base}/${svc}`, { method: 'POST', headers, body: JSON.stringify({ method, id: 1, params, version }) });
    if (r.status === 403) throw new Error('Sony TV refused the Pre-Shared Key');
    if (!r.json) throw new Error(`Sony TV answered ${r.status}`);
    if (r.json.error) throw new Error(`Sony TV: ${r.json.error[1] || r.json.error[0]}`);
    return r.json.result;
  };
  const vol = (v, target = 'speaker') => call('audio', 'setAudioVolume', [{ target, volume: String(v) }]).then(() => poll());
  const t = {
    brand: 'sony', frame: false, status: 'unknown', powered: null, volume: null, headphone: null, mac: cfg.mac || null,
    // a second output the TV reports (Bluetooth or wired headphones), with its own level
    headphoneUp: () => vol('+1', 'headphone'), headphoneDown: () => vol('-1', 'headphone'), setHeadphone: (n) => vol(Math.round(n), 'headphone'),
    volumeUp: () => vol('+1'),
    volumeDown: () => vol('-1'),
    setVolume: (n) => vol(Math.round(n)),
    mute: async () => { await call('audio', 'setAudioMute', [{ status: !(t.volume && t.volume.muted) }]); return poll(); },
    powerOn: async () => {
      await wakeOnLan(t.mac);
      try { await call('system', 'setPowerStatus', [{ status: true }]); } catch {}
      return poll();
    },
    powerOff: async () => { await call('system', 'setPowerStatus', [{ status: false }]); return poll(); },
    powerToggle: () => (t.powered === false ? t.powerOn() : t.powerOff()),
    close: () => {},
  };
  async function poll() {
    try {
      const [p] = await call('system', 'getPowerStatus');
      t.powered = p.status === 'active';
      if (!t.mac) {
        try { const [info] = await call('system', 'getSystemInformation'); t.mac = info.macAddr || info.wirelessMacAddr || null; t.model = info.model || t.model; } catch {}
      }
      if (t.powered) {
        const [list] = await call('audio', 'getVolumeInformation');
        const sp = (list || []).find((x) => x.target === 'speaker') || list[0];
        if (sp) t.volume = { level: sp.volume, max: sp.maxVolume, muted: !!sp.mute };
        const hp = (list || []).find((x) => x.target === 'headphone');
        t.headphone = hp ? { level: hp.volume, max: hp.maxVolume, muted: !!hp.mute } : null;
      }
      t.status = 'ok'; t.error = null;
    } catch (e) {
      t.status = /Pre-Shared/.test(e.message) ? 'needs-psk' : 'offline';
      t.error = e.message; t.powered = t.status === 'offline' ? false : t.powered;
    }
    onChange && onChange();
    return t;
  }
  t.poll = poll;
  return t;
}

// ---------------- Samsung Tizen ------------------------------------------
function samsung(cfg, onChange, saveToken) {
  const name = Buffer.from(cfg.clientName || 'House Controls').toString('base64');
  const port = cfg.port || 8002;
  const scheme = cfg.plainWs ? 'ws' : 'wss';
  let ws = null, ready = null, idle = null;
  const t = { brand: 'samsung', frame: !!cfg.frame, status: 'unknown', powered: null, volume: null, mac: cfg.mac || null, token: cfg.token || null, artMode: null, artAt: 0 };

  function connect() {
    if (ready) return ready;
    const url = `${scheme}://${cfg.host}:${port}/api/v2/channels/samsung.remote.control?name=${name}${t.token ? `&token=${t.token}` : ''}`;
    ready = new Promise((resolve, reject) => {
      const sock = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 4000 });
      const timer = setTimeout(() => { reject(new Error(t.token ? 'Samsung TV did not answer' : 'Waiting for Allow on the TV')); try { sock.terminate(); } catch {} }, t.token ? 6000 : 35000);
      if (!t.token) { t.status = 'needs-allow'; onChange && onChange(); }
      sock.on('message', (buf) => {
        let msg = null; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.event === 'ms.channel.connect') {
          clearTimeout(timer);
          const tok = msg.data && msg.data.token;
          if (tok && tok !== t.token) { t.token = String(tok); saveToken && saveToken(t.token); }
          ws = sock; t.status = 'ok'; t.error = null; onChange && onChange();
          resolve(sock);
        } else if (msg.event === 'ms.channel.unauthorized') {
          clearTimeout(timer); t.status = 'denied'; t.error = 'The TV denied the connection. Remove Optimum Remote under the TV\'s External Device Manager and allow it again.'; onChange && onChange();
          reject(new Error(t.error));
        }
      });
      sock.on('close', () => { if (ws === sock) ws = null; ready = null; });
      sock.on('error', (e) => { clearTimeout(timer); ready = null; reject(new Error(`Samsung TV: ${e.code || e.message}`)); });
    });
    ready.catch(() => { ready = null; });
    return ready;
  }
  // The Frame's Art mode has its own channel. "on" = the picture frame is showing (the TV reports PowerState on
  // all the same); set_artmode_status off puts the TV picture back without touching the power key.
  function artRequest(request, value, waitFor) {
    return new Promise((resolve, reject) => {
      const url = `${scheme}://${cfg.host}:${port}/api/v2/channels/com.samsung.art-app?name=${name}${t.token ? `&token=${t.token}` : ''}`;
      const sock = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 4000 });
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const done = (err, val) => { clearTimeout(timer); try { sock.close(); } catch {} err ? reject(err) : resolve(val); };
      const timer = setTimeout(() => done(new Error('art channel did not answer')), 6000);
      sock.on('message', (buf) => {
        let msg = null; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.event === 'ms.channel.connect' || msg.event === 'ms.channel.ready') {
          if (sock.__sent) return; sock.__sent = true;
          sock.send(JSON.stringify({ method: 'ms.channel.emit', params: { event: 'art_app_request', to: 'host', data: JSON.stringify({ request, ...(value !== undefined ? { value } : {}), id }) } }));
          if (!waitFor) setTimeout(() => done(null, true), 400);
        } else if (msg.event === 'd2d_service_message') {
          let d = null; try { d = JSON.parse(msg.data); } catch { return; }
          if (d && d.event === waitFor) done(null, d);
        } else if (msg.event === 'ms.channel.unauthorized') done(new Error('the TV denied the art channel'));
      });
      sock.on('error', (e) => done(new Error(`art channel: ${e.code || e.message}`)));
    });
  }
  async function artStatus() {
    if (!t.frame || !t.token) return t.artMode;
    try { const d = await artRequest('get_artmode_status', undefined, 'artmode_status'); t.artMode = d.value === 'on'; }
    catch (e) { t.artMode = null; }
    t.artAt = Date.now();
    return t.artMode;
  }
  async function setArtMode(on) {
    await artRequest('set_artmode_status', on ? 'on' : 'off');
    t.artMode = on; onChange && onChange();
  }
  function touchIdle() { clearTimeout(idle); idle = setTimeout(() => { try { ws && ws.close(); } catch {} ws = null; ready = null; }, 60000); }
  async function key(code, cmd = 'Click') {
    const sock = await connect();
    sock.send(JSON.stringify({ method: 'ms.remote.control', params: { Cmd: cmd, DataOfCmd: code, Option: 'false', TypeOfRemote: 'SendRemoteKey' } }));
    touchIdle();
  }
  async function poll() {
    try {
      const r = await fetchJson(`http://${cfg.host}:${cfg.infoPort || 8001}/api/v2/`, {}, 2000);
      const d = r.json && r.json.device;
      if (!d) throw new Error('no answer');
      t.powered = d.PowerState ? d.PowerState === 'on' : true;
      if (!t.mac && d.wifiMac) t.mac = d.wifiMac;
      if (d.FrameTVSupport === 'true') t.frame = true;
      t.model = d.modelName || d.name;
      if (t.status !== 'needs-allow' && t.status !== 'denied') t.status = t.token ? 'ok' : 'needs-allow';
      t.error = null;
      if (t.frame && t.powered && t.token && Date.now() - t.artAt > 20000) await artStatus(); else if (!t.powered) t.artMode = false;
    } catch (e) {
      t.status = 'offline'; t.powered = false; t.artMode = false; t.error = e.message;
    }
    onChange && onChange();
    return t;
  }
  Object.assign(t, {
    volumeUp: () => key('KEY_VOLUP'),
    volumeDown: () => key('KEY_VOLDOWN'),
    setVolume: null, // Samsung does not report its level over this channel
    mute: () => key('KEY_MUTE'),
    // On: wake it if it is off; a Frame then comes up in Art mode, so take it to the TV picture as well.
    powerOn: async () => {
      if (t.powered === false) { await wakeOnLan(t.mac); await sleep(1500); await poll(); }
      if (t.frame) {
        if (t.artMode !== false) {
          try { await setArtMode(false); }
          catch (e) { await key('KEY_POWER'); } // the art channel is not answering: a short power press also swaps Art mode → TV
          await sleep(1500); t.artAt = 0; await poll();
        }
      }
      return t;
    },
    setArtMode, artStatus,
    showingTv: () => t.powered !== false && !t.artMode,
    // A Frame's power key: a short press swaps TV ↔ Art mode, a HELD press turns it off.
    // We never want Art mode, so a Frame is always turned off with a held press, and
    // if it still reports "on" (= it slipped into Art mode) we hold again, longer.
    powerOff: async () => {
      if (!t.frame) { await key('KEY_POWER'); await sleep(1500); return poll(); }
      for (const holdMs of [3500, 5000]) {
        await key('KEY_POWER', 'Press'); await sleep(holdMs); await key('KEY_POWER', 'Release');
        await sleep(2500); await poll();
        if (t.powered === false) return t;
      }
      return t;
    },
    powerToggle: () => (t.powered === false || t.artMode ? t.powerOn() : t.powerOff()),
    sendKey: (code) => key(code),
    launchApp: async (appId) => {
      const r = await fetchJson(`http://${cfg.host}:${cfg.infoPort || 8001}/api/v2/applications/${appId}`, { method: 'POST' }, 4000);
      if (!r.ok) throw new Error(`Samsung TV would not open that app (${r.status})`);
    },
    allow: () => connect(),
    close: () => { clearTimeout(idle); try { ws && ws.close(); } catch {} },
    poll,
  });
  return t;
}

// ---------------- SSDP discovery (Sony + Samsung + anything else) ----------
function ssdpSearch(ms = 2500) {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map();
    const msg = Buffer.from(['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 2', 'ST: ssdp:all', '', ''].join('\r\n'));
    s.on('message', (buf, rinfo) => {
      const h = {}; buf.toString().split('\r\n').slice(1).forEach((l) => { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
      const e = found.get(rinfo.address) || { host: rinfo.address, server: h.server || '', st: new Set(), location: h.location || '' };
      if (h.st) e.st.add(h.st); if (h.server) e.server = h.server;
      found.set(rinfo.address, e);
    });
    s.on('error', () => { try { s.close(); } catch {} resolve([]); });
    s.bind(() => { try { s.setBroadcast(true); s.send(msg, 1900, '239.255.255.250'); } catch {} });
    setTimeout(() => {
      try { s.close(); } catch {}
      resolve([...found.values()].map((e) => {
        const st = [...e.st].join(' ');
        const brand = /sony/i.test(e.server + st) ? 'sony' : /samsung/i.test(e.server + st + e.location) || /:7676\/|:9197\//.test(e.location) ? 'samsung' : null;
        return { host: e.host, brand, server: e.server, location: e.location };
      }).filter((e) => e.brand));
    }, ms);
  });
}

// Android-style key names → Samsung remote key codes, for a room with a TV and no box.
const SAMSUNG_KEYS = {
  DPAD_UP: 'KEY_UP', DPAD_DOWN: 'KEY_DOWN', DPAD_LEFT: 'KEY_LEFT', DPAD_RIGHT: 'KEY_RIGHT', DPAD_CENTER: 'KEY_ENTER', ENTER: 'KEY_ENTER',
  BACK: 'KEY_RETURN', HOME: 'KEY_HOME', MENU: 'KEY_MENU', INFO: 'KEY_INFO', GUIDE: 'KEY_GUIDE', CAPTIONS: 'KEY_SUB_TITLE', TV_INPUT: 'KEY_SOURCE',
  CHANNEL_UP: 'KEY_CHUP', CHANNEL_DOWN: 'KEY_CHDOWN', LAST_CHANNEL: 'KEY_PRECH', MEDIA_PLAY_PAUSE: 'KEY_PLAY', MEDIA_REWIND: 'KEY_REWIND', MEDIA_FAST_FORWARD: 'KEY_FF',
  VOLUME_UP: 'KEY_VOLUP', VOLUME_DOWN: 'KEY_VOLDOWN', MUTE: 'KEY_MUTE', VOLUME_MUTE: 'KEY_MUTE',
  0: 'KEY_0', 1: 'KEY_1', 2: 'KEY_2', 3: 'KEY_3', 4: 'KEY_4', 5: 'KEY_5', 6: 'KEY_6', 7: 'KEY_7', 8: 'KEY_8', 9: 'KEY_9',
};

module.exports = { sony, samsung, wakeOnLan, ssdpSearch, SAMSUNG_KEYS };
