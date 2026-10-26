'use strict';
// TV listings from Schedules Direct (the full grid the cable box shows: every channel, reruns, movies,
// two weeks ahead). A paid account; the sign-in lives in data/sd.json on the Pi — the username, the
// SHA-1 of the password (all Schedules Direct ever wants) and the chosen lineup — never in the repo.
// Falls back to nothing: server.js keeps the free TVmaze feed for when this is not set up.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = process.env.SD_URL || 'https://json.schedulesdirect.org/20141201';
const UA = 'HouseControls/1.0 (+https://github.com/Joebkauf/House-Controls)';
const TZ = process.env.GUIDE_TZ || 'America/New_York';
const REFRESH_MS = 6 * 60 * 60 * 1000;   // schedules twice a shop day is plenty; the account has daily limits
const DAYS = 3;                          // today and the two days after; yesterday too, for shows across midnight
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (d) => dayFmt.format(d);

function create({ dataDir, log = () => {}, onChange = () => {} }) {
  const cfgFile = path.join(dataDir, 'sd.json'), cacheFile = path.join(dataDir, 'sd-cache.json');
  let cfg = null; try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch {}
  // cache: the lineup (stations + numbers), the schedule rows and the program titles, so a restart costs no calls
  let cache = { lineup: null, lineupAt: 0, stations: [], rows: [], programs: {}, rowsAt: 0, through: null };
  try { Object.assign(cache, JSON.parse(fs.readFileSync(cacheFile, 'utf8'))); } catch {}
  const st = { error: null, busy: false, timer: null, lastOk: cache.rowsAt || 0 };
  const saveCfg = () => fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const saveCache = () => { try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (e) { log('[listings] cache write:', e.message); } };

  async function call(method, p, { body, auth = true, query } = {}) {
    const headers = { 'User-Agent': UA, 'Content-Type': 'application/json' };
    if (auth) headers.token = await token();
    const q = query ? '?' + new URLSearchParams(query).toString() : '';
    const res = await fetch(BASE + p + q, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
    const text = await res.text(); let j; try { j = JSON.parse(text); } catch { j = null; }
    if (!res.ok || (j && !Array.isArray(j) && j.code && j.code !== 0 && j.response)) {
      const msg = (j && (j.message || j.response)) || `HTTP ${res.status}`;
      if (j && (j.code === 4003 || j.code === 4004 || j.code === 4009)) throw Object.assign(new Error(msg), { auth: true, code: j.code });
      if (res.status === 403 && auth) { cfg.token = null; saveCfg(); } // a stale token: sign in again next call
      throw new Error(msg);
    }
    return j;
  }
  async function token() {
    if (!cfg || !cfg.username || !cfg.hash) throw new Error('Schedules Direct is not set up');
    if (cfg.token && cfg.tokenExpires && Date.now() < cfg.tokenExpires - 10 * 60000) return cfg.token;
    const j = await call('POST', '/token', { body: { username: cfg.username, password: cfg.hash }, auth: false });
    if (!j || !j.token) throw new Error((j && j.message) || 'no token');
    cfg.token = j.token; cfg.tokenExpires = j.tokenExpires ? j.tokenExpires * 1000 : Date.now() + 23 * 3600000; saveCfg();
    return cfg.token;
  }

  // ---- account ----
  async function signIn({ username, password }) {
    const hash = crypto.createHash('sha1').update(String(password)).digest('hex');
    cfg = { ...(cfg || {}), username: String(username || '').trim(), hash, token: null, tokenExpires: 0 };
    saveCfg();
    await token();
    const acct = await call('GET', '/status').catch(() => null);
    const lineups = ((acct && acct.lineups) || []).map((l) => ({ id: l.lineup, name: l.name || l.lineup }));
    if (!cfg.lineup && lineups.length === 1) { cfg.lineup = lineups[0].id; cfg.lineupName = lineups[0].name; saveCfg(); }
    st.error = null;
    return { ok: true, lineups, lineup: cfg.lineup || null };
  }
  // the lineups Schedules Direct offers for a zip, cable ones first
  async function headends(zip) {
    const list = await call('GET', '/headends', { query: { country: 'USA', postalcode: String(zip || '').replace(/\D/g, '').slice(0, 5) } });
    const out = [];
    for (const h of list || []) for (const l of h.lineups || []) out.push({ id: l.lineup, name: `${l.name}${h.location ? ` · ${h.location}` : ''}`, transport: h.transport, headend: h.headend });
    out.sort((a, b) => (/optimum|cablevision|altice/i.test(b.name) - /optimum|cablevision|altice/i.test(a.name)) || (a.transport === 'Cable' ? -1 : 1) - (b.transport === 'Cable' ? -1 : 1) || a.name.localeCompare(b.name));
    return out;
  }
  async function useLineup(id, name) {
    if (!/^[A-Z]{3}-[A-Z0-9]+-[A-Z0-9]+$/i.test(id || '')) throw new Error('that is not a lineup id');
    const acct = await call('GET', '/status').catch(() => null);
    const have = ((acct && acct.lineups) || []).some((l) => l.lineup === id);
    if (!have) {
      const r = await call('PUT', `/lineups/${id}`);
      if (r && r.code && r.code !== 0) throw new Error(r.message || 'could not add the lineup');
    }
    cfg.lineup = id; cfg.lineupName = name || id; saveCfg();
    cache.lineup = null; cache.lineupAt = 0; cache.rows = []; cache.rowsAt = 0; cache.through = null; saveCache();
    await refresh(true);
    return status();
  }

  // ---- listings ----
  async function loadLineup() {
    const j = await call('GET', `/lineups/${cfg.lineup}`);
    const stations = new Map((j.stations || []).map((s) => [s.stationID, s]));
    const list = [];
    for (const m of j.map || []) {
      const s = stations.get(m.stationID); if (!s) continue;
      const number = Number(String(m.channel || '').replace(/^0+/, '')) || null;
      list.push({ stationID: m.stationID, number, callsign: s.callsign || '', name: s.name || s.callsign || '', affiliate: s.affiliate || '' });
    }
    cache.stations = list; cache.lineup = cfg.lineup; cache.lineupAt = Date.now();
    cache.lineupName = (j.metadata && j.metadata.lineup) || cfg.lineup;
  }
  async function refresh(force) {
    if (!cfg || !cfg.username || !cfg.lineup || st.busy) return;
    if (!force && cache.rowsAt && Date.now() - cache.rowsAt < REFRESH_MS && cache.lineup === cfg.lineup) return;
    st.busy = true;
    try {
      if (!cache.lineupAt || Date.now() - cache.lineupAt > 24 * 3600000 || cache.lineup !== cfg.lineup) await loadLineup();
      const now = new Date();
      const dates = []; for (let i = -1; i < DAYS; i++) dates.push(dayKey(new Date(+now + i * 86400000)));
      const ids = cache.stations.map((s) => s.stationID);
      const rows = [], need = new Set();
      for (let i = 0; i < ids.length; i += 5000) {
        const sched = await call('POST', '/schedules', { body: ids.slice(i, i + 5000).map((stationID) => ({ stationID, date: dates })) });
        for (const s of sched || []) for (const p of s.programs || []) {
          const start = Date.parse(p.airDateTime); if (!Number.isFinite(start)) continue;
          rows.push({ stationID: s.stationID, programID: p.programID, start, end: start + (p.duration || 1800) * 1000, new: !!p.new });
          if (!cache.programs[p.programID]) need.add(p.programID);
        }
      }
      const want = [...need];
      for (let i = 0; i < want.length; i += 5000) {
        const progs = await call('POST', '/programs', { body: want.slice(i, i + 5000) });
        for (const p of progs || []) {
          if (!p || !p.programID || p.code) continue;
          const title = (p.titles && p.titles[0] && p.titles[0].title120) || '';
          if (title) cache.programs[p.programID] = [title, p.episodeTitle150 || ''];
        }
      }
      // forget titles nothing on the schedule uses any more
      const used = new Set(rows.map((r) => r.programID));
      for (const id of Object.keys(cache.programs)) if (!used.has(id)) delete cache.programs[id];
      cache.rows = rows.filter((r) => cache.programs[r.programID]); cache.rowsAt = Date.now(); st.lastOk = cache.rowsAt;
      cache.through = rows.length ? new Date(Math.max(...rows.map((r) => r.end))).toISOString() : null;
      saveCache(); st.error = null;
      log(`[listings] ${cache.stations.length} channels, ${cache.rows.length} airings through ${cache.through ? dayKey(new Date(cache.through)) : '—'}`);
      onChange();
    } catch (e) { st.error = e.message; log('[listings]', e.message); }
    finally { st.busy = false; }
  }
  function start() { if (st.timer) return; refresh().catch(() => {}); st.timer = setInterval(() => refresh().catch(() => {}), 30 * 60000); st.timer.unref && st.timer.unref(); }

  // ---- the wall's channels ↔ the lineup's stations: by channel number first, then by callsign / name ----
  function stationFor(channels) {
    const byNum = new Map(), byName = new Map();
    for (const s of cache.stations) {
      if (s.number && !byNum.has(s.number)) byNum.set(s.number, s);
      for (const k of [norm(s.callsign), norm(s.name), norm(s.affiliate)]) if (k && !byName.has(k)) byName.set(k, s);
    }
    const out = new Map(); // channel key -> station
    for (const c of channels || []) {
      const key = norm(c.name); if (!key) continue;
      let s = c.number ? byNum.get(Number(c.number)) : null;
      if (!s) for (const k of [norm(c.guide), key, key + 'hd', key.replace(/(channel|network|tv)$/, '')]) if (k && byName.has(k)) { s = byName.get(k); break; }
      if (s) out.set(key, s);
    }
    return out;
  }
  const ready = () => !!(cfg && cfg.lineup && cache.rows.length);
  const title = (r) => (cache.programs[r.programID] || [''])[0];

  function nowOn(channels, at = Date.now()) {
    if (!ready()) return {};
    const cur = new Map();
    for (const r of cache.rows) if (r.start <= at && r.end > at) { const p = cur.get(r.stationID); if (!p || r.start > p.start) cur.set(r.stationID, r); }
    const out = {};
    for (const [key, s] of stationFor(channels)) { const r = cur.get(s.stationID); if (r) out[key] = title(r); }
    return out;
  }
  function schedule(channels, from, to) {
    const out = [];
    if (!ready()) return { from, to, channels: out };
    const byStation = new Map();
    for (const r of cache.rows) { if (r.end <= from || r.start >= to) continue; if (!byStation.has(r.stationID)) byStation.set(r.stationID, []); byStation.get(r.stationID).push(r); }
    const seen = new Set();
    for (const c of channels || []) {
      const key = norm(c.name); if (seen.has(key)) continue; seen.add(key);
      const s = stationFor([c]).get(key); if (!s) continue;
      const rows = (byStation.get(s.stationID) || []).sort((a, b) => a.start - b.start);
      if (rows.length) out.push({ name: c.name, number: c.number, programs: rows.map((r) => ({ title: title(r), start: r.start, end: r.end, new: r.new })) });
    }
    return { from, to, channels: out };
  }
  function findShow(channels, q, at = Date.now()) {
    const want = norm(q); if (!want || !ready()) return { now: [], next: [] };
    const oneWord = !/\s/.test(String(q).trim());
    const byStation = new Map(); for (const [key, s] of stationFor(channels)) if (!byStation.has(s.stationID)) byStation.set(s.stationID, (channels || []).find((c) => norm(c.name) === key));
    const tiers = [[], [], []];
    for (const r of cache.rows) {
      const c = byStation.get(r.stationID); if (!c) continue;
      const t = norm(title(r));
      const tier = t === want ? 0 : t.startsWith(want) ? 1 : (!oneWord && t.includes(want)) ? 2 : -1;
      if (tier < 0) continue;
      tiers[tier].push({ title: title(r), channel: c.name, number: c.number, start: r.start, end: r.end, new: r.new });
    }
    const hits = tiers.find((l) => l.length) || [];
    hits.sort((a, b) => a.start - b.start);
    return { now: hits.filter((h) => h.start <= at && h.end > at), next: hits.filter((h) => h.start > at).slice(0, 6) };
  }
  // The wall's numbers came from a 2015 printout; the lineup is today's. Match each wall channel to a station by
  // NAME only and report where the number differs (or no station has that name). The caller decides what to change.
  function checkNumbers(channels, aliases = {}) {
    const byName = new Map();
    for (const s of cache.stations) for (const k of [norm(s.callsign), norm(s.name), norm(s.affiliate), norm(s.name).replace(/(hd|channel|network|tv)$/, '')]) if (k && !byName.has(k)) byName.set(k, s);
    const out = [];
    for (const c of channels || []) {
      const key = norm(c.name); if (!key) continue;
      let s = null;
      for (const k of [norm(c.guide), norm(aliases[key]), key, key + 'hd', key.replace(/(channel|network|tv)$/, '')]) if (k && byName.has(k)) { s = byName.get(k); break; }
      if (!s) { out.push({ name: c.name, number: c.number || null, found: false }); continue; }
      out.push({ name: c.name, number: c.number || null, found: true, station: s.name, callsign: s.callsign, lineupNumber: s.number, same: Number(c.number) === s.number });
    }
    return out;
  }
  // the lineup as Schedules Direct has it, for checking the wall's numbers
  const lineupChannels = () => cache.stations.filter((s) => s.number).map((s) => ({ number: s.number, callsign: s.callsign, name: s.name, affiliate: s.affiliate })).sort((a, b) => a.number - b.number);

  function status() {
    return { configured: !!(cfg && cfg.username && cfg.hash), username: cfg ? cfg.username || '' : '', lineup: cfg ? cfg.lineup || null : null, lineupName: (cfg && cfg.lineupName) || cache.lineupName || null,
      stations: cache.stations.length, airings: cache.rows.length, through: cache.through, lastOk: st.lastOk, error: st.error, busy: st.busy, ready: ready() };
  }
  function forgetLineup() { if (!cfg) return; cfg.lineup = null; cfg.lineupName = null; saveCfg(); cache.lineup = null; cache.lineupAt = 0; cache.stations = []; cache.rows = []; cache.rowsAt = 0; cache.through = null; cache.lineupName = null; saveCache(); onChange(); }
  function forget() { cfg = null; try { fs.unlinkSync(cfgFile); } catch {} cache = { lineup: null, lineupAt: 0, stations: [], rows: [], programs: {}, rowsAt: 0, through: null }; saveCache(); st.error = null; onChange(); }

  return { signIn, headends, useLineup, refresh, start, nowOn, schedule, findShow, lineupChannels, checkNumbers, status, ready, forget, forgetLineup, norm };
}

module.exports = { create };
