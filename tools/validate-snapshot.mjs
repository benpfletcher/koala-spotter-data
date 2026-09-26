// Run before replacing a published snapshot. Large drops need investigation, not automatic publication.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function validateSnapshot(next, previous) {
  if (next.coverage !== 'Australia' || !Number.isFinite(Date.parse(next.built))) throw new Error('Missing Australia-wide coverage or build date.');
  const totals = m => [m.total, m.sources?.bionet, m.sources?.national?.kept];
  const values = totals(next);
  if (values.some(n => !Number.isSafeInteger(n) || n <= 0) || values[0] !== values[1] + values[2]) throw new Error('Incomplete or inconsistent nationwide totals.');
  if (previous?.coverage === 'Australia' && values.some((n, i) => n < totals(previous)[i] * 0.9)) {
    throw new Error('More than 10% of a source disappeared; retain the previous snapshot and investigate.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = JSON.parse(await readFile(path.join(process.argv[2], 'meta.json'), 'utf8'));
  const previous = JSON.parse(await readFile(path.join(process.argv[3], 'meta.json'), 'utf8'));
  validateSnapshot(next, previous);
  console.log(`Validated Australia-wide snapshot: ${next.total.toLocaleString()} records.`);
}
