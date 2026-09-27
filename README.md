# Koala Spotter 2000 — data snapshot

Static, CDN-served snapshot combining NSW BioNet records with national wildlife atlases and other publishers via GBIF.
GitHub Actions attempts a refresh daily and serves successful snapshots through GitHub Pages for https://koala-spotter-2000.vercel.app.
If a national import fails, or validation detects missing coverage or a loss of more than 10% of either source,
the previous published snapshot is retained. Concurrent workflow runs are serialized.

- `meta.json` — build time, range cut-offs, observation-type and dataset lookup tables
- `p/{x}_{y}.json` — 0.05° point tiles: `[OBJECTID, lon, lat, daysSinceEpoch, typeIdx, datasetIdx, count, accuracyM, catalogNumber]`
- `a/{i}/…` — exact per-cell counts for cell sizes 2°…0.01°: `[cx, cy, n1y, n5y, n10y, nAll, lonCentroid, latCentroid, latestDays]`
- `latest.json` — the 400 most recent records nationwide
- `national-cache.json` — transformed GBIF records, with cache version and per-dataset retrieval timestamps; unchanged counts only allow reuse for 24 hours

National records use the neutral observation type `Record` unless the retained source information establishes
a more specific condition. Explicit roadkill datasets use `Road kill`. No verification status is invented.
Source record IDs are strings for GBIF and numbers for BioNet. `nationalTransformVersion` identifies the transformation in metadata.

Before replacing published data, run `node tools/validate-snapshot.mjs out .` against the candidate and current snapshot.
Build timestamps describe snapshot generation; per-dataset `fetched` timestamps describe source retrieval.

Rebuild locally: `node tools/build-snapshot.mjs .`


Enrichment (transform v4): compact row index 20 contains `sourceDetail` (original identifiers,
project, method, notes, demographics and licensed photos where available). Exact WildNet IDs
are matched through ALA, then public Queensland sighting dates replace missing/broad GBIF dates;
the GBIF date and survey interval remain in the detail object. Coordinates remain GBIF WGS84.
`wildnet-detail-cache.json` persists the complete ID crosswalk, public date feed and bounded detail
responses. Each daily build fetches up to 500 missing detail responses, newest first, then refreshes
responses older than 30 days after the backlog. Unknown methods stay unknown; hospital records
never imply injury or death. The first release enriches existing snapshot IDs using
`tools/enrich-snapshot.mjs`; subsequent daily builds continue the normal source refresh.

`WILDNET_DETAIL_LIMIT=0` applies cached evidence without requesting more individual records.
Every build checks complete crosswalk paging; incomplete enrichment aborts publication.
