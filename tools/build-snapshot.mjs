// Builds a static snapshot of every NSW BioNet koala record into CDN-friendly tiles.
// Usage: node tools/build-snapshot.mjs [outDir]   (default ../koala-spotter-2000/data)
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(ROOT, '..', 'koala-spotter-2000', 'data');
const URL_Q = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/EDP/KoalaSpeciesSightings/MapServer/0/query';
const FIELDS = 'OBJECTID,eventDate,observationType,datasetName,catalogNumber,individualCount,coordinateUncertaintyInMeters,recordStatus';
const WHERE = "recordStatus <> 'Invalid, in quarantine'";
const PAGE = 1000, CONCURRENCY = 5;
const POINT_CELL = 0.05;                                  // point tiles (~5 km)
const AGG_CELLS = [2, 1, 0.5, 0.25, 0.1, 0.05, 0.025, 0.01];
const AGG_SINGLE_MAX_IDX = 4;                             // cells >= 0.1° fit in one file each
const DAY = 86400000;

async function getJSON(url, tries = 4) {
  for (let i = 0; ; i++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 25000);
    try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j; }
    catch (e) { if (i >= tries - 1) throw e; await new Promise(res => setTimeout(res, 1500 * (i + 1))); }
    finally { clearTimeout(t); }
  }
}
const qs = o => new URLSearchParams(o).toString();

const t0 = Date.now();
const count = (await getJSON(`${URL_Q}?${qs({ where: WHERE, returnCountOnly: 'true', f: 'json' })}`)).count;
console.log('records:', count);
const pages = Math.ceil(count / PAGE);
const records = []; let done = 0;
const types = new Map(), datasets = new Map();
const idx = (m, v) => { v = v || ''; if (!m.has(v)) m.set(v, m.size); return m.get(v); };
async function fetchPage(p) {
  const j = await getJSON(`${URL_Q}?${qs({ where: WHERE, outFields: FIELDS, orderByFields: 'OBJECTID', resultOffset: String(p * PAGE), resultRecordCount: String(PAGE), outSR: '4326', geometryPrecision: '5', returnGeometry: 'true', f: 'geojson' })}`);
  for (const f of j.features || []) {
    if (!f.geometry || !Array.isArray(f.geometry.coordinates)) continue;
    const a = f.properties; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(a.eventDate || '');
    const days = m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : null;
    const [lon, lat] = f.geometry.coordinates;
    records.push([a.OBJECTID, +lon.toFixed(5), +lat.toFixed(5), days, idx(types, a.observationType), idx(datasets, a.datasetName), a.individualCount ?? null, a.coordinateUncertaintyInMeters != null ? Math.round(a.coordinateUncertaintyInMeters) : null, a.catalogNumber || '']);
  }
  done++; if (done % 25 === 0) process.stdout.write(`  pages ${done}/${pages} (${records.length} recs, ${((Date.now() - t0) / 1000) | 0}s)\n`);
}
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (next < pages) { const p = next++; await fetchPage(p); } }));
console.log('fetched', records.length, 'records in', ((Date.now() - t0) / 1000) | 0, 's');
// Deterministic lookup tables (sorted) so indices are stable across builds when the value sets are unchanged.
function remap(m, records, col) { const sorted = [...m.keys()].sort(); const to = new Map(sorted.map((k, i) => [k, i])); const from = new Map([...m.entries()].map(([k, i]) => [i, to.get(k)])); for (const r of records) if (r[col] != null) r[col] = from.get(r[col]); m.clear(); sorted.forEach((k, i) => m.set(k, i)); }
remap(types, records, 4); remap(datasets, records, 5);

// ---- extras from the BioNet OData feed (sex, breeding, time, habitat, method, reserve, council area, notes) ----
const ODATA = 'https://data.bionet.nsw.gov.au/biosvcapp/odata/SpeciesSightings_CoreData';
const extras = new Map();
const sexes = new Map(), repros = new Map(), habitats = new Map(), protocols = new Map(), reserves = new Map(), counties = new Map();
const clean = v => (v == null || v === '' || v === 'N/A' || v === 'Not supplied') ? null : String(v).trim();
const toMin = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
try {
  let url = `${ODATA}?$filter=scientificName eq 'Phascolarctos cinereus'&$select=catalogNumber,sex,reproductiveCondition,eventTime,habitat,samplingProtocol,reserve,county,eventRemarks`;
  let page = 0;
  while (url) {
    const j = await getJSON(url, 3); page++;
    for (const r of j.value || []) {
      const sex = clean(r.sex), rep = clean(r.reproductiveCondition), hab = clean(r.habitat), pro = clean(r.samplingProtocol), res = clean(r.reserve), cty = clean(r.county), rem = clean(r.eventRemarks), tm = toMin(r.eventTime);
      if (!(sex || rep || hab || pro || res || cty || rem || tm != null)) continue;
      extras.set(r.catalogNumber, [sex ? idx(sexes, sex) : null, rep ? idx(repros, rep) : null, tm, hab ? idx(habitats, hab) : null, pro ? idx(protocols, pro) : null, res ? idx(reserves, res) : null, cty ? idx(counties, cty) : null, rem ? rem.slice(0, 160) : null]);
    }
    url = j['@odata.nextLink'] || null;
    console.log('  odata page', page, 'extras so far', extras.size);
  }
} catch (e) { console.log('OData extras unavailable this run:', e.message); }
let withExtras = 0;
for (const r of records) { const x = extras.get(r[8]); if (x) { while (x.length && x[x.length - 1] == null) x.pop(); r.push(...x); withExtras++; } }
[[sexes, 9], [repros, 10], [habitats, 12], [protocols, 13], [reserves, 14], [counties, 15]].forEach(([m, col]) => remap(m, records, col));
console.log('records with extras:', withExtras, '| lookups:', sexes.size, 'sex,', repros.size, 'breeding,', habitats.size, 'habitat,', protocols.size, 'methods,', reserves.size, 'reserves,', counties.size, 'council areas');

// ---- write ----
// Never delete the output directory itself (it may be the repo checkout): clear only the files we publish.
for (const f of ['p', 'a', 'meta.json', 'latest.json', 'tiles.json']) await rm(path.join(OUT, f), { recursive: true, force: true });
await mkdir(path.join(OUT, 'p'), { recursive: true });
const now = new Date(); const BUILT = now.toISOString(); const todayDays = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / DAY);
const cut = y => { const d = new Date(now); d.setUTCFullYear(d.getUTCFullYear() - y); return Math.floor(d.getTime() / DAY); };
const CUT = { y1: cut(1), y5: cut(5), y10: cut(10) };

// point tiles (0.1°)
const ptiles = new Map();
for (const r of records) { const k = `${Math.floor(r[1] / POINT_CELL)}_${Math.floor(r[2] / POINT_CELL)}`; (ptiles.get(k) || ptiles.set(k, []).get(k)).push(r); }
let pbytes = 0, pmax = 0;
for (const [k, rs] of ptiles) { const s = JSON.stringify({ b: BUILT, r: rs }); pbytes += s.length; pmax = Math.max(pmax, s.length); await writeFile(path.join(OUT, 'p', k + '.json'), s); }
console.log('point tiles:', ptiles.size, 'total', (pbytes / 1e6).toFixed(1), 'MB, largest', (pmax / 1e3) | 0, 'KB');

// aggregates per cell size: [cx, cy, n1, n5, n10, nAll, lonCentroid, latCentroid, latestDays]
let abytes = 0, afiles = 0;
for (let ci = 0; ci < AGG_CELLS.length; ci++) {
  const cell = AGG_CELLS[ci]; const cells = new Map();
  for (const r of records) {
    const cx = Math.floor(r[1] / cell), cy = Math.floor(r[2] / cell), k = cx + '_' + cy;
    let c = cells.get(k); if (!c) { c = { cx, cy, n1: 0, n5: 0, n10: 0, n: 0, sx: 0, sy: 0, latest: -1 }; cells.set(k, c); }
    c.n++; c.sx += r[1]; c.sy += r[2]; if (r[3] != null) { if (r[3] > c.latest) c.latest = r[3]; if (r[3] >= CUT.y1) c.n1++; if (r[3] >= CUT.y5) c.n5++; if (r[3] >= CUT.y10) c.n10++; }
  }
  const row = c => [c.cx, c.cy, c.n1, c.n5, c.n10, c.n, +(c.sx / c.n).toFixed(5), +(c.sy / c.n).toFixed(5), c.latest];
  const dir = path.join(OUT, 'a', String(ci)); await mkdir(dir, { recursive: true });
  if (ci <= AGG_SINGLE_MAX_IDX) { const s = JSON.stringify({ b: BUILT, c: [...cells.values()].map(row) }); abytes += s.length; afiles++; await writeFile(path.join(dir, 'all.json'), s); }
  else {
    const tiles = new Map();
    for (const c of cells.values()) { const k = `${Math.floor(c.cx * cell)}_${Math.floor(c.cy * cell)}`; (tiles.get(k) || tiles.set(k, []).get(k)).push(row(c)); }
    for (const [k, rows] of tiles) { const s = JSON.stringify({ b: BUILT, c: rows }); abytes += s.length; afiles++; await writeFile(path.join(dir, k + '.json'), s); }
  }
  console.log(`agg cell ${cell}°: ${cells.size} cells`);
}
console.log('aggregate files:', afiles, 'total', (abytes / 1e6).toFixed(1), 'MB');
// statewide latest (for regional/statewide list views)
const latest = records.filter(r => r[3] != null).sort((a, b) => b[3] - a[3]).slice(0, 400);
await writeFile(path.join(OUT, 'latest.json'), JSON.stringify({ b: BUILT, r: latest }));
await writeFile(path.join(OUT, 'tiles.json'), JSON.stringify({ b: BUILT, cell: POINT_CELL, keys: [...ptiles.keys()] }));
const meta = { built: BUILT, occupiedTiles: ptiles.size, snapshotDate: now.toISOString().slice(0, 10), todayDays, total: records.length, cut: CUT, pointCell: POINT_CELL, aggCells: AGG_CELLS, aggSingleMaxIdx: AGG_SINGLE_MAX_IDX, aggTile: 1,
  types: [...types.keys()], datasets: [...datasets.keys()], sexes: [...sexes.keys()], repros: [...repros.keys()], habitats: [...habitats.keys()], protocols: [...protocols.keys()], reserves: [...reserves.keys()], counties: [...counties.keys()],
  record: ['OBJECTID', 'lon', 'lat', 'days', 'typeIdx', 'datasetIdx', 'count', 'accuracyM', 'catalogNumber', 'sexIdx', 'reproIdx', 'timeMinutes', 'habitatIdx', 'protocolIdx', 'reserveIdx', 'countyIdx', 'remarks'] };
await writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta));
console.log('done in', ((Date.now() - t0) / 1000) | 0, 's →', OUT);
