// Fetches every koala sighting outside NSW from GBIF (which mirrors the Queensland, Victorian and
// South Australian atlases plus council and community programs) into a compact cache file.
//
// Why GBIF: the Atlas of Living Australia caps search paging at a few thousand rows and its bulk
// download needs an API key. GBIF pages to 100,000 rows per query without a key, so each dataset is
// fetched separately, split into latitude bands small enough to keep offsets shallow (deep offsets are slow).
//
// Duplicate avoidance happens in two places:
//   1. Here: the NSW BioNet Atlas and iNaturalist datasets are never requested (the app has both directly),
//      and records GBIF places inside New South Wales are dropped, since NSW programs also flow into BioNet.
//   2. In build-snapshot.mjs: a fuzzy match (same date, position within ~10 m, same count) against BioNet
//      and within this set collapses the same sighting published by two programs.
//
// Usage: node tools/fetch-national.mjs [cacheFile]        (default: ../national-cache.json next to tools/)
//   Reuses unchanged datasets for at most 24 hours; refreshes older or differently transformed data.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { observationType, nationalDetail } from './observation-detail.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE = path.join(ROOT, '..', 'national-cache.json');
export const CACHE_VERSION = 4;
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const API = 'https://api.gbif.org/v1';
const TAXON = 2440012;                                   // Phascolarctos cinereus (Goldfuss, 1817)
const SKIP_DATASETS = new Set([
  '0645ccdb-e001-4ab0-9729-51f1755e007e',                // NSW BioNet Atlas — fetched directly by the builder
  '50c9509d-22c7-4a22-a47d-8c48425ef4a7',                // iNaturalist research-grade — shown live by the app, with photos
]);
const SIGHTING_BASIS = new Set(['HUMAN_OBSERVATION', 'OBSERVATION', 'OCCURRENCE', 'MACHINE_OBSERVATION']);
const AU = { w: 112.5, e: 154.5, s: -44.5, n: -9.5 };
const NSW_ROUGH = r => r.lat <= -28.1 && r.lat >= -37.6 && r.lon >= 140.9 && r.lon <= 153.7;   // only used when GBIF gives no state
const BAND_MAX = 2500, PAGE = 300, CONCURRENCY = 4, DAY = 86400000;
const BASE = `taxonKey=${TAXON}&country=AU&hasCoordinate=true&hasGeospatialIssue=false&occurrenceStatus=PRESENT`;

async function getJSON(url, tries = 5) {
  for (let i = 0; ; i++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 180000);
    try { const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'koala-spotter-snapshot (benpfletcher@gmail.com)' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    catch (e) { if (i >= tries - 1) throw e; await new Promise(res => setTimeout(res, 3000 * (i + 1))); }
    finally { clearTimeout(t); }
  }
}
const count = q => getJSON(`${API}/occurrence/search?${BASE}&${q}&limit=0`).then(j => j.count);

export async function listDatasets() {
  const j = await getJSON(`${API}/occurrence/search?${BASE}&limit=0&facet=datasetKey&facetLimit=200`);
  const out = [];
  for (const c of j.facets[0].counts) {
    if (SKIP_DATASETS.has(c.name)) continue;
    const d = await getJSON(`${API}/dataset/${c.name}`).catch(() => ({}));
    out.push({ key: c.name, title: (d.title || c.name).replace(/\s+/g, ' ').trim(), count: c.count });
  }
  return out;
}

// Split [s, n] latitude range into bands of at most BAND_MAX records so page offsets stay shallow.
async function bands(dsKey, s, n, total) {
  if (total <= BAND_MAX || n - s < 0.02) return [[s, n, total]];
  const mid = +((s + n) / 2).toFixed(4);
  const lower = await count(`datasetKey=${dsKey}&decimalLatitude=${s},${mid}`);
  const upper = Math.max(0, total - lower);
  const out = [];
  if (lower) out.push(...await bands(dsKey, s, mid, lower));
  if (upper) out.push(...await bands(dsKey, mid, n, upper));
  return out;
}

// basisOfRecord does not establish whether an animal was alive, heard, or photographed.
// Classify from explicit methods/condition evidence; retain provenance and licensed media.
export function nationalObservationType(title, record = {}) { return observationType(record, title); }
export function reusableDataset(prev, ds, version, now = Date.now()) {
  const age = now - Date.parse(prev?.fetched);
  return version === CACHE_VERSION && prev?.count === ds.count && prev.title === ds.title &&
    Array.isArray(prev.records) && Number.isFinite(age) && age >= 0 && age < CACHE_MAX_AGE_MS;
}

export function compact(o, title) {
  const lat = o.decimalLatitude, lon = o.decimalLongitude;
  if (typeof lat !== 'number' || typeof lon !== 'number' || lon < AU.w || lon > AU.e || lat < AU.s || lat > AU.n) return { drop: 'coords' };
  if (!SIGHTING_BASIS.has(o.basisOfRecord)) return { drop: 'basis' };
  const state = (o.gadm && o.gadm.level1 && o.gadm.level1.name) || o.stateProvince || null;
  if (state ? /new south wales/i.test(state) : NSW_ROUGH({ lat, lon })) return { drop: 'nsw' };
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(o.eventDate || '');
  const days = m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : null;
  const cnt = Number.isInteger(o.individualCount) && o.individualCount > 0 ? o.individualCount : null;
  const acc = typeof o.coordinateUncertaintyInMeters === 'number' ? Math.round(o.coordinateUncertaintyInMeters) : null;
  const type = nationalObservationType(title, o);
  return { rec: [o.key, +lon.toFixed(5), +lat.toFixed(5), days, type, title, cnt, acc, o.eventDate || null, nationalDetail(o, title)] };
}

async function fetchDataset(ds, log) {
  const recs = new Map(); const dropped = { coords: 0, basis: 0, nsw: 0 }; let fetched = 0;
  const plan = await bands(ds.key, AU.s, AU.n, ds.count);
  const pages = [];
  for (const [s, n, c] of plan) for (let off = 0; off < c; off += PAGE) pages.push(`datasetKey=${ds.key}&decimalLatitude=${s},${n}&limit=${PAGE}&offset=${off}`);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < pages.length) {
      const q = pages[next++];
      const j = await getJSON(`${API}/occurrence/search?${BASE}&${q}`);
      for (const o of j.results || []) { fetched++; const r = compact(o, ds.title); if (r.rec) recs.set(r.rec[0], r.rec); else dropped[r.drop]++; }
      done++; if (done % 20 === 0 || done === pages.length) log(`    ${ds.title.slice(0, 40)}: ${done}/${pages.length} pages, ${recs.size} kept`);
    }
  }));
  return { records: [...recs.values()], fetched, dropped };
}

export async function fetchNational(cacheFile = DEFAULT_CACHE, log = console.log) {
  let cache = null;
  try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch { cache = null; }
  const datasets = await listDatasets();
  if (!datasets.length) throw new Error('National dataset list is empty; retaining the previous snapshot.');
  log(`GBIF: ${datasets.length} datasets outside the skipped ones, ${datasets.reduce((a, d) => a + d.count, 0)} records before filtering`);
  const out = { version: CACHE_VERSION, source: 'GBIF', taxonKey: TAXON, fetched: new Date().toISOString(), datasets: {}, records: [] };
  let reused = 0, refetched = 0;
  for (const ds of datasets) {
    const prev = cache && cache.datasets && cache.datasets[ds.key];
    if (reusableDataset(prev, ds, cache?.version)) { out.datasets[ds.key] = prev; reused++; continue; }
    log(`  fetching ${ds.title} (${ds.count} records)`);
    const r = await fetchDataset(ds, log);
    out.datasets[ds.key] = { title: ds.title, count: ds.count, fetched: out.fetched, kept: r.records.length, seen: r.fetched, dropped: r.dropped, records: r.records };
    refetched++;
    // Checkpoint completed datasets; a later upstream failure must not discard a long download.
    await writeFile(cacheFile + '.tmp', JSON.stringify({ ...out, records: undefined }));
    await rename(cacheFile + '.tmp', cacheFile);
  }
  for (const d of Object.values(out.datasets)) out.records.push(...d.records);
  if (!out.records.length) throw new Error('National import returned no records; retaining the previous snapshot.');
  const bytesSafe = { ...out, records: undefined };
  const temp = `${cacheFile}.tmp`;
  await writeFile(temp, JSON.stringify(bytesSafe));
  await rename(temp, cacheFile);
  log(`national cache: ${out.records.length} records (${reused} datasets reused, ${refetched} refetched) → ${cacheFile}`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const r = await fetchNational(process.argv[2] || DEFAULT_CACHE);
  const byTitle = {}; for (const d of Object.values(r.datasets)) byTitle[d.title] = d.kept;
  console.log(Object.entries(byTitle).sort((a, b) => b[1] - a[1]).slice(0, 15));
  console.log('done in', ((Date.now() - t0) / 1000) | 0, 's');
}
