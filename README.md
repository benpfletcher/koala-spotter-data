# Koala Spotter 2000 — data snapshot

Static, CDN-served snapshot of every koala record in the NSW BioNet Atlas (CC BY 4.0, © NSW DCCEEW), rebuilt daily by
GitHub Actions and served via GitHub Pages for https://koala-spotter-2000.vercel.app.

- `meta.json` — build time, range cut-offs, observation-type and dataset lookup tables
- `p/{x}_{y}.json` — 0.05° point tiles: `[OBJECTID, lon, lat, daysSinceEpoch, typeIdx, datasetIdx, count, accuracyM, catalogNumber]`
- `a/{i}/…` — exact per-cell counts for cell sizes 2°…0.01°: `[cx, cy, n1y, n5y, n10y, nAll, lonCentroid, latCentroid, latestDays]`
- `latest.json` — the 400 most recent records state-wide

Rebuild locally: `node tools/build-snapshot.mjs .`
