// Cable boxes that are not Android TV.
//   DirecTV Genie : the box's own HTTP control port (:8080, "SHEF"). Turn on
//                   Settings → Whole-Home → External Device → Allow on the Genie.
//   Anything else : an infrared blaster on the Wi-Fi (Broadlink RM4 mini) that
//                   learns each key from the box's own remote, then plays it back.
'use strict';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, ms = 2500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json: j };
  } finally { clearTimeout(t); }
}

// ---------------- DirecTV Genie ------------------------------------------
const DIRECTV_KEYS = {
  POWER: 'power', TV_POWER: 'power', CHANNEL_UP: 'chanup', CHANNEL_DOWN: 'chandown', LAST_CHANNEL: 'prev', GUIDE: 'guide', INFO: 'info',
  BACK: 'back', EXIT: 'exit', HOME: 'menu', MENU: 'menu', DVR: 'list', DPAD_UP: 'up', DPAD_DOWN: 'down', DPAD_LEFT: 'left', DPAD_RIGHT: 'right',
  DPAD_CENTER: 'select', ENTER: 'enter', MEDIA_REWIND: 'rew', MEDIA_FAST_FORWARD: 'ffwd', MEDIA_STOP: 'stop', MEDIA_RECORD: 'record',
  0: '0', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
};
function directv(cfg, onChange) {
  const base = `http://${cfg.host}:${cfg.port || 8080}`;
  const t = { type: 'directv', status: 'unknown', powered: null, channel: null, title: null, callsign: null, error: null, paused: false };
  const get = async (path) => {
    const r = await fetchJson(`${base}${path}`);
    if (r.status === 403) throw new Error('the Genie refused: turn on External Device access in its settings');
    if (!r.json) throw new Error(`Genie answered ${r.status}`);
    if (r.json.status && r.json.status.code && r.json.status.code !== 200) throw new Error(`Genie: ${r.json.status.msg || r.json.status.code}`);
    return r.json;
  };
  const press = async (key) => { await get(`/remote/processKey?key=${key}&hold=keyPress`); };
  Object.assign(t, {
    sendKey: async (name) => {
      if (name === 'MEDIA_PLAY_PAUSE') { await press(t.paused ? 'play' : 'pause'); t.paused = !t.paused; return; }
      const k = DIRECTV_KEYS[name];
      if (!k) throw new Error(`a Genie has no ${name} key`);
      await press(k);
      if (/^\d$/.test(name) || k === 'chanup' || k === 'chandown' || k === 'prev') setTimeout(() => t.poll().catch(() => {}), 2500);
    },
    tune: async (number) => { await get(`/tv/tune?major=${encodeURIComponent(number)}`); t.channel = String(number); setTimeout(() => t.poll().catch(() => {}), 2000); },
    canTune: true, hasApps: false,
    poll: async () => {
      try {
        const mode = await get('/info/mode');
        t.powered = mode.mode === 0;
        if (t.powered) {
          const tuned = await get('/tv/getTuned');
          t.channel = tuned.major != null ? String(tuned.major) : t.channel;
          t.title = tuned.title || null; t.callsign = tuned.callsign || null; t.episode = tuned.episodeTitle || null;
        }
        t.status = 'ok'; t.error = null;
      } catch (e) { t.status = 'offline'; t.error = e.message; }
      onChange && onChange();
      return t;
    },
    close: () => {},
  });
  return t;
}

// ---------------- Infrared blaster (Broadlink RM4 mini) ------------------
// The keys a cable box remote has; the page offers these to learn.
const IR_KEYS = [
  ['POWER', 'Power'], ['CHANNEL_UP', 'Channel up'], ['CHANNEL_DOWN', 'Channel down'], ['LAST_CHANNEL', 'Last / Previous'],
  ['GUIDE', 'Guide'], ['INFO', 'Info'], ['MENU', 'Menu'], ['EXIT', 'Exit'], ['BACK', 'Back'], ['HOME', 'Home'],
  ['DPAD_UP', 'Up'], ['DPAD_DOWN', 'Down'], ['DPAD_LEFT', 'Left'], ['DPAD_RIGHT', 'Right'], ['DPAD_CENTER', 'OK / Select'],
  ['MEDIA_PLAY_PAUSE', 'Play / Pause'], ['MEDIA_REWIND', 'Rewind'], ['MEDIA_FAST_FORWARD', 'Fast forward'], ['DVR', 'DVR / List'], ['CAPTIONS', 'CC'],
  ['ENTER', 'Enter'], ['0', '0'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6'], ['7', '7'], ['8', '8'], ['9', '9'],
];
function ir(cfg, onChange, saveCodes, lib) {
  const broadlink = lib || require('node-broadlink');
  const t = { type: 'ir', status: 'unknown', powered: null, channel: null, error: null, learning: null, codes: cfg.codes || {}, canTune: true, hasApps: false };
  let dev = null, authed = false;
  async function device() {
    if (dev && authed) return dev;
    if (!cfg.host) throw new Error('no blaster address');
    if (cfg.devType && cfg.mac) {
      dev = broadlink.genDevice(Number(cfg.devType), { address: cfg.host, port: 80, family: 'IPv4', size: 0 }, cfg.mac.split(':').map((h) => parseInt(h, 16)));
    } else {
      const found = await broadlink.discover(3000);
      dev = found.find((d) => d.host.address === cfg.host);
      if (!dev) throw new Error(`no Broadlink blaster answered at ${cfg.host}`);
      cfg.devType = dev.deviceType; cfg.mac = dev.mac.map((n) => n.toString(16).padStart(2, '0')).join(':');
      saveCodes && saveCodes(t.codes, { devType: cfg.devType, mac: cfg.mac, model: dev.model });
    }
    await dev.auth(); authed = true;
    return dev;
  }
  Object.assign(t, {
    sendKey: async (name) => {
      const code = t.codes[name];
      if (!code) throw Object.assign(new Error(`${name.replace(/_/g, ' ').toLowerCase()} is not learned yet (⚙ → Learn keys)`), { status: 409 });
      const d = await device();
      try { await d.sendData(code); } catch (e) { authed = false; throw new Error(`blaster: ${e.message}`); }
      if (name === 'POWER') t.powered = t.powered === null ? null : !t.powered;
    },
    tune: async (number) => {
      for (const d of String(number).replace(/\D/g, '')) { await t.sendKey(d); await sleep(300); }
      if (t.codes.ENTER && cfg.enterAfterDigits) await t.sendKey('ENTER');
      t.channel = String(number);
    },
    // Put the blaster in learning mode and wait up to 15 s for a press on the real remote.
    learn: async (name) => {
      const d = await device();
      t.learning = name; t.error = null; onChange && onChange();
      try {
        await d.enterLearning();
        const until = Date.now() + 15000;
        while (Date.now() < until) {
          await sleep(600);
          try {
            const data = await d.checkData();
            const hex = Buffer.isBuffer(data) ? data.toString('hex') : (Array.isArray(data) ? Buffer.from(data).toString('hex') : String(data));
            if (hex && hex.length > 8) { t.codes[name] = hex; saveCodes && saveCodes(t.codes); return hex; }
          } catch { /* nothing yet */ }
        }
        throw new Error('no key seen; point the remote at the blaster and press the key within 15 seconds');
      } finally { t.learning = null; onChange && onChange(); }
    },
    forget: (name) => { delete t.codes[name]; saveCodes && saveCodes(t.codes); },
    poll: async () => {
      try { await device(); t.status = 'ok'; t.error = null; }
      catch (e) { t.status = 'offline'; t.error = e.message; authed = false; }
      onChange && onChange();
      return t;
    },
    close: () => {},
  });
  return t;
}

async function discoverBlasters(lib) {
  const broadlink = lib || require('node-broadlink');
  const found = await broadlink.discover(3000).catch(() => []);
  return found.map((d) => ({ host: d.host.address, mac: d.mac.map((n) => n.toString(16).padStart(2, '0')).join(':'), devType: d.deviceType, model: d.model || 'Broadlink' }));
}

module.exports = { directv, ir, discoverBlasters, IR_KEYS, DIRECTV_KEYS };
