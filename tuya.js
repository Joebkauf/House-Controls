'use strict';
// Tuya Smart / Smart Life plugs, switches and lights, through Tuya's cloud API.
// One-time setup on iot.tuya.com gives an Access ID + Secret and links the phone app's account;
// those live in data/tuya.json on the Pi, never in the repo.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REGIONS = { us: 'https://openapi.tuyaus.com', 'us-e': 'https://openapi-ueaz.tuyaus.com', eu: 'https://openapi.tuyaeu.com', 'eu-w': 'https://openapi-weaz.tuyaeu.com', in: 'https://openapi.tuyain.com', cn: 'https://openapi.tuyacn.com' };
const SWITCH_CODES = ['switch_1', 'switch', 'switch_led', 'switch_2', 'switch_3'];

function create({ dataDir, log, onChange, baseUrlOverride }) {
  const file = path.join(dataDir, 'tuya.json');
  let cfg = null; try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const st = { token: null, tokenUntil: 0, uid: null, devices: [], rooms: new Map(), lastOk: 0, error: null, timer: null };
  const base = () => baseUrlOverride || REGIONS[(cfg && cfg.region) || 'us'] || REGIONS.us;

  async function call(method, p, { body, query, auth = true } = {}) {
    if (!cfg || !cfg.accessId || !cfg.secret) throw new Error('Tuya is not set up');
    const t = String(Date.now());
    const bodyStr = body ? JSON.stringify(body) : '';
    const q = query ? '?' + Object.entries(query).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
    const stringToSign = [method, crypto.createHash('sha256').update(bodyStr).digest('hex'), '', p + q].join('\n');
    const token = auth ? await getToken() : '';
    const sign = crypto.createHmac('sha256', cfg.secret).update(cfg.accessId + token + t + stringToSign).digest('hex').toUpperCase();
    const res = await fetch(base() + p + q, { method, headers: { client_id: cfg.accessId, sign, t, sign_method: 'HMAC-SHA256', ...(token ? { access_token: token } : {}), 'Content-Type': 'application/json' }, body: body ? bodyStr : undefined, signal: AbortSignal.timeout(15000) });
    const j = await res.json().catch(() => ({}));
    if (!j.success) { const msg = `${j.msg || res.status}${j.code ? ` (${j.code})` : ''}`; if (/token/i.test(msg) && auth) { st.token = null; } throw new Error(msg); }
    return j.result;
  }
  async function getToken() {
    if (st.token && Date.now() < st.tokenUntil) return st.token;
    const r = await call('GET', '/v1.0/token', { query: { grant_type: '1' }, auth: false });
    st.token = r.access_token; st.tokenUntil = Date.now() + (r.expire_time - 60) * 1000; st.uid = r.uid || st.uid;
    return st.token;
  }
  const switchOf = (d) => (d.status || []).find((s) => SWITCH_CODES.includes(s.code) && typeof s.value === 'boolean') || (d.status || []).find((s) => /^switch/.test(s.code) && typeof s.value === 'boolean') || null;

  async function refresh() {
    if (!cfg || !cfg.accessId) return;
    try {
      const all = []; let lastRowKey = '';
      for (let page = 0; page < 10; page++) {
        const r = await call('GET', '/v1.0/iot-01/associated-users/devices', { query: { size: '100', ...(lastRowKey ? { last_row_key: lastRowKey } : {}) } });
        all.push(...(r.devices || [])); if (!r.has_more) break; lastRowKey = r.last_row_key;
      }
      if (!st.rooms.size && all[0] && all[0].uid) await loadRooms(all[0].uid).catch((e) => log && log('[tuya] rooms:', e.message));
      st.devices = all.filter((d) => switchOf(d)).map((d) => ({ id: d.id, name: d.name, category: d.category, online: !!d.online, on: switchOf(d).value, code: switchOf(d).code, room: st.rooms.get(d.id) || '' }));
      st.lastOk = Date.now(); st.error = null;
    } catch (e) { st.error = e.message; log && log('[tuya]', e.message); }
    onChange && onChange();
  }
  async function loadRooms(uid) {
    const homes = await call('GET', `/v1.0/users/${uid}/homes`);
    for (const h of homes || []) {
      const rooms = await call('GET', `/v1.0/homes/${h.home_id}/rooms`);
      for (const r of (rooms && rooms.rooms) || rooms || []) {
        const devs = await call('GET', `/v1.0/homes/${h.home_id}/rooms/${r.room_id}/devices`).catch(() => []);
        for (const d of devs || []) st.rooms.set(d.id, r.name);
      }
    }
  }
  async function set(id, on) {
    const d = st.devices.find((x) => x.id === id); if (!d) throw new Error('unknown plug');
    await call('POST', `/v1.0/iot-03/devices/${id}/commands`, { body: { commands: [{ code: d.code, value: !!on }] } });
    d.on = !!on; onChange && onChange();
    setTimeout(() => refresh().catch(() => {}), 2500);
    return d;
  }
  function save(next) {
    cfg = { accessId: String(next.accessId || '').trim(), secret: String(next.secret || '').trim(), region: next.region || 'us' };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    st.token = null; st.rooms.clear(); st.devices = []; st.error = null;
    return refresh();
  }
  function start() { if (st.timer || !cfg) return; refresh().catch(() => {}); st.timer = setInterval(() => refresh().catch(() => {}), 30000); st.timer.unref && st.timer.unref(); }
  const status = () => ({ configured: !!(cfg && cfg.accessId), accessId: cfg ? cfg.accessId : '', region: cfg ? cfg.region : 'us', count: st.devices.length, lastOk: st.lastOk, error: st.error });
  return { start, refresh, set, save, status, devices: () => st.devices, REGIONS: Object.keys(REGIONS) };
}
module.exports = { create };
