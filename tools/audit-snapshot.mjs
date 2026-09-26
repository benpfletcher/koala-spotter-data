// Checks data integrity, not the truth of the original wildlife reports.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const dir = process.argv[2];
if (!dir) throw Error('Usage: node tools/audit-snapshot.mjs snapshot-directory');
const json = async name => JSON.parse(await readFile(path.join(dir, name), 'utf8'));
const meta = await json('meta.json'), index = await json('tiles.json');
assert.equal(index.b, meta.built);
const ids = new Set(), coordinates = new Map(), totals = [0, 0, 0, 0];
let national = 0, ranges = 0, future = 0, unknownDates = 0, sourceDates = 0;
const cuts = [meta.cut.y1, meta.cut.y5, meta.cut.y10];
const today = Math.floor(Date.now() / 86400000);
const tiles = await readdir(path.join(dir, 'p'));
assert.deepEqual(tiles.map(f => f.replace(/\.json$/, '')).sort(), [...index.keys].sort());
for (const file of tiles) {
  const tile = await json('p/' + file); assert.equal(tile.b, meta.built);
  for (const r of tile.r) {
    const id = String(r[0]); assert(!ids.has(id), 'Repeated client ID ' + id); ids.add(id);
    assert(Number.isFinite(r[1]) && r[1] >= 112 && r[1] <= 155 && Number.isFinite(r[2]) && r[2] >= -45 && r[2] <= -9, 'Invalid coordinates ' + id);
    assert(meta.types[r[4]] !== undefined && meta.datasets[r[5]] !== undefined, 'Invalid lookup ' + id);
    assert.equal(file, `${Math.floor(r[1] / meta.pointCell)}_${Math.floor(r[2] / meta.pointCell)}.json`);
    assert(r[3] == null || Number.isInteger(r[3]), 'Invalid date ' + id);
    if (typeof r[0] === 'string') national++;
    if (r[3] == null) unknownDates++;
    if (r[3] > today) future++;
    if (r[19]) {
      sourceDates++;
      const parts = r[19].split('/');
      if (parts.length === 2 && parts[0].slice(0, 10) !== parts[1].slice(0, 10)) ranges++;
      if (r[3] != null) assert.equal(new Date(r[3] * 86400000).toISOString().slice(0, 10), r[19].slice(0, 10), 'Source date changed ' + id);
    }
    for (let i = 0; i < 3; i++) if (r[3] != null && r[3] >= cuts[i]) totals[i]++;
    totals[3]++;
    const key = r[1] + ',' + r[2]; coordinates.set(key, (coordinates.get(key) || 0) + 1);
  }
}
assert.equal(totals[3], meta.total);
assert.equal(national, meta.sources.national.kept);
assert.equal(meta.total - national, meta.sources.bionet);
for (let i = 0; i < meta.aggCells.length; i++) {
  const sum = [0, 0, 0, 0];
  for (const file of await readdir(path.join(dir, 'a', String(i)))) {
    const tile = await json(`a/${i}/${file}`); assert.equal(tile.b, meta.built);
    for (const row of tile.c) for (let k = 0; k < 4; k++) { assert(Number.isSafeInteger(row[k + 2]) && row[k + 2] >= 0); sum[k] += row[k + 2]; }
  }
  assert.deepEqual(sum, totals, 'Aggregate counts differ at resolution ' + i);
}
const latest = await json('latest.json'); assert.equal(latest.b, meta.built);
for (const r of latest.r) assert(ids.has(String(r[0])), 'Latest record missing from tiles');
console.log(JSON.stringify({ built: meta.built, records: meta.total, national, bionet: meta.total - national, uniqueCoordinates: coordinates.size, largestSameCoordinateGroup: [...coordinates.values()].reduce((max, n) => Math.max(max, n), 0), dateRangesPreserved: ranges, sourceDates, unknownDates, futureDatedRecords: future, totals, aggregateResolutionsChecked: meta.aggCells.length, valid: true }, null, 2));
