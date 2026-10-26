'use strict';
// What's on each channel right now, from TVmaze's free schedule feed (show titles only,
// never the episode). The bridge pulls yesterday's and today's US schedule, keeps it in
// memory, and answers for any channel whose name matches a network. No key, no account.
const GUIDE_URL = process.env.GUIDE_URL || 'https://api.tvmaze.com/schedule';
const GUIDE_TZ = process.env.GUIDE_TZ || 'America/New_York';
const REFRESH_MS = 3 * 60 * 60 * 1000;

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: GUIDE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (d) => dayFmt.format(d);
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

// Channel-wall names → the name the listings use. Anything not here matches by normalized name.
const ALIASES = {
  foxnews: 'Fox News Channel', tcm: 'Turner Classic Movies', disney: 'Disney Channel', discovery: 'Discovery Channel', golf: 'Golf Channel',
  bloomberg: 'Bloomberg Television', natgeo: 'National Geographic', yes: 'YES Network', cw: 'The CW', foxbusiness: 'Fox Business Network',
  fs1: 'FOX Sports 1', fs2: 'FOX Sports 2', nick: 'Nickelodeon', ae: 'A&E', usa: 'USA Network', history: 'History', hln: 'HLN', id: 'Investigation Discovery',
  weatherchannel: 'The Weather Channel', weather: 'The Weather Channel', paramount: 'Paramount Network', pbsthirteen: 'PBS', njpbs: 'PBS', pbswliw: 'PBS',
  my9: 'MyNetworkTV', vicetv: 'Vice', mtvclassic: 'MTV Classic', lifetimemovies: 'Lifetime Movies', hallmark: 'Hallmark Channel', nickjr: 'Nick Jr.',
  cartoonnetwork: 'Cartoon Network', comedycentral: 'Comedy Central', foodnetwork: 'Food Network', travelchannel: 'Travel Channel', sciencechannel: 'Science Channel',
  smithsonianchannel: 'Smithsonian Channel', cookingchannel: 'Cooking Channel', hallmarkmystery: 'Hallmark Mystery', reelzchannel: 'Reelz', reelz: 'Reelz',
  bbcamerica: 'BBC America', news12: 'News 12', nfl: 'NFL Network', nflnetwork: 'NFL Network', nbatv: 'NBA TV', mlbnetwork: 'MLB Network', nhlnetwork: 'NHL Network',
  cbssportsnetwork: 'CBS Sports Network', tennischannel: 'Tennis Channel', amc: 'AMC', ifc: 'IFC', sundancetv: 'Sundance TV', sundance: 'Sundance TV',
};

const state = { days: new Map(), fetchedAt: 0, error: null, timer: null };

async function fetchDay(day) {
  const res = await fetch(`${GUIDE_URL}?country=US&date=${day}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`listings ${res.status}`);
  const rows = await res.json();
  // keep only what the tiles need: network, title, start, end
  return rows.map((e) => {
    const net = (e.show && (e.show.network || e.show.webChannel)) || null;
    const start = Date.parse(e.airstamp || `${e.airdate}T${e.airtime || '00:00'}:00`);
    if (!net || !net.name || !Number.isFinite(start) || !e.show.name) return null;
    return { net: net.name, netKey: norm(net.name), title: e.show.name, start, end: start + Math.max(15, e.runtime || e.show.runtime || 30) * 60000 };
  }).filter(Boolean);
}

async function refresh(log) {
  const now = new Date();
  const want = [dayKey(new Date(now - 86400000)), dayKey(now), dayKey(new Date(+now + 86400000))];
  for (const day of want) {
    if (state.days.has(day) && Date.now() - state.days.get(day).at < REFRESH_MS) continue;
    try { state.days.set(day, { at: Date.now(), rows: await fetchDay(day) }); state.error = null; }
    catch (e) { state.error = e.message; if (log) log('[guide]', day, e.message); }
  }
  for (const day of [...state.days.keys()]) if (!want.includes(day)) state.days.delete(day);
  state.fetchedAt = Date.now();
}

function start(log, onChange) {
  if (state.timer) return;
  const tick = () => refresh(log).then(() => onChange && onChange()).catch(() => {});
  tick();
  state.timer = setInterval(tick, 30 * 60 * 1000);
  state.timer.unref && state.timer.unref();
}

// { 'abc': 'Good Morning America', ... } keyed by the channel's normalized name, for channels on the wall.
function nowOn(channels, at = Date.now()) {
  const rows = [...state.days.values()].flatMap((d) => d.rows);
  if (!rows.length) return {};
  const byNet = new Map();
  for (const r of rows) {
    if (r.start > at || r.end <= at) continue;
    const prev = byNet.get(r.netKey);
    if (!prev || r.start > prev.start) byNet.set(r.netKey, r);
  }
  const out = {};
  for (const c of channels || []) {
    const key = norm(c.name); if (!key) continue;
    const wanted = norm(c.guide || ALIASES[key] || c.name);
    let hit = byNet.get(wanted);
    if (!hit && !c.guide && !ALIASES[key]) {
      // "HBO2" vs "HBO 2", "Nick Jr" vs "Nick Jr." — exact after normalizing; never a loose prefix match (ESPN would steal ESPN2)
      for (const [k, r] of byNet) if (k === key || k === key + 'channel' || k === key + 'network' || key === k + 'channel' || key === k + 'network') { hit = r; break; }
    }
    if (hit) out[key] = hit.title;
  }
  return out;
}

// One lookup shared by the show finder and the guide: listings network -> channel on the wall.
function netMap(channels) {
  const byNet = new Map();
  for (const c of channels || []) {
    if (!c.number) continue;
    const key = norm(c.name); const k = norm(c.guide || ALIASES[key] || c.name);
    for (const v of [k, key, key + 'channel', key + 'network', key.replace(/(channel|network)$/, '')]) if (v && !byNet.has(v)) byNet.set(v, c);
  }
  return byNet;
}
// The guide: for every channel on the wall with listings, its programs between from and to (titles only).
function schedule(channels, from, to) {
  const byNet = netMap(channels);
  const out = new Map();
  for (const d of state.days.values()) for (const r of d.rows) {
    if (r.end <= from || r.start >= to) continue;
    const c = byNet.get(r.netKey); if (!c) continue;
    const key = norm(c.name);
    if (!out.has(key)) out.set(key, { name: c.name, number: c.number, programs: [] });
    const list = out.get(key).programs;
    if (list.some((x) => x.start === r.start)) continue; // listings repeat an episode row per episode; one block per start
    list.push({ title: r.title, start: r.start, end: r.end });
  }
  for (const ch of out.values()) ch.programs.sort((a, b) => a.start - b.start);
  return { from, to, channels: [...out.values()] };
}
// Where a show is on: every airing of it (today, yesterday, tomorrow) on a channel that is on the wall.
// { now: [...airing right now], next: [...coming up] }, each { title, channel, number, start, end }.
function findShow(channels, q, at = Date.now()) {
  const want = norm(q); if (!want) return { now: [], next: [] };
  const byNet = netMap(channels);
  const hits = [];
  for (const d of state.days.values()) for (const r of d.rows) {
    const t = norm(r.title); if (!(t === want || t.includes(want) || (want.length > 5 && want.includes(t) && t.length > 3))) continue;
    const c = byNet.get(r.netKey); if (!c) continue;
    hits.push({ title: r.title, channel: c.name, number: c.number, net: r.net, start: r.start, end: r.end });
  }
  hits.sort((a, b) => a.start - b.start);
  return { now: hits.filter((h) => h.start <= at && h.end > at), next: hits.filter((h) => h.start > at).slice(0, 6) };
}

module.exports = { start, refresh, nowOn, findShow, schedule, norm, status: () => ({ loaded: [...state.days.values()].reduce((n, d) => n + d.rows.length, 0), fetchedAt: state.fetchedAt, error: state.error }) };
