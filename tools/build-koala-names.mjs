// Conservative, one-to-one linkage of public hospital incidents to their atlas mirror.
// This does not identify animals across incidents, add sightings or change coordinates.
import { readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const RESOURCE = 'e2abf1f6-edac-4d99-a2ca-8eb4dd91f1e8';
export const SOURCE = `https://www.data.qld.gov.au/dataset/koala-hospital-data/resource/${RESOURCE}`;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = 'Moggill Koala Hospital Database';
const normal = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function koalaName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  // Do not extract names from medical/status strings or assume multiple names identify one animal.
  if (!/^[A-Za-z][A-Za-z .’'\-]{1,39}$/.test(name)) return null;
  if (/^(?:no name|heat stress|drain tube|wilvo|eos|eeuthanased|reclocated|reocated|sighitng|sightng|uncaptuerd|re[- ]?unite[d]?|return|buried|treatment|survey)$/i.test(name)) return null;
  if (/\b(?:sightings?|dead|died|deceased|euth\w*|doa|eoa|ir|release\w*|relocat\w*|capture\w*|uncaptured|unable|unknown|unnamed|unidentified|withheld|none|null|not|orphan\w*|koala|male|female|adult|juvenile|joey|injured|sick|roadkill|and)\b/i.test(name)) return null;
  return name;
}
const distance = (a,b) => Math.hypot((a[0]-b[0])*111320*Math.cos(a[1]*Math.PI/180),(a[1]-b[1])*111320);
export function matchNames(rows, records) {
  const byDate = new Map(), names = {}, proposed = [], uses = new Map();
  for (const r of records) {
    const date = String(r['Date Time'] || '').slice(0,10), id = String(r['Record No'] || '').trim();
    const lon = Number(r.LNG), lat = Number(r.LAT);
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || r.LNG == null || r.LAT == null || !Number.isFinite(lon) || !Number.isFinite(lat) || lon<138 || lon>154 || lat< -30 || lat> -9) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ r, date, id, point:[lon,lat] });
  }
  const stats = { hospitalRows:records.length, candidates:0, linked:0, ambiguous:0, placeholders:0 };
  for (const n of rows) {
    const d=n[9];
    if (d?.datasetKey !== 'e4473544-f4cd-4429-b791-39d6e1fdb0a4' || d.project !== PROJECT || !d.locality || n[6]>1) continue;
    const date=n[8]; if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) continue;
    const point=[n[1],n[2]];
    // A 100m ambiguity guard includes unnamed nearby incidents, not only potential name matches.
    const nearby=(byDate.get(date)||[]).filter(h=>distance(point,h.point)<=100);
    const ids=new Set(nearby.map(h=>h.id));
    if (ids.size!==1) { if(ids.size)stats.ambiguous++;continue; }
    const candidates=nearby.filter(h=>distance(point,h.point)<=2);
    if(!candidates.length)continue;
    const variants=new Set(nearby.map(h=>JSON.stringify([h.r['Koala Name'],h.r['Koala Suburb'],h.r['Adult Gender'],h.point])));
    if(variants.size!==1){stats.ambiguous++;continue;}
    const h=candidates[0], suburb=normal(h.r['Koala Suburb']), locality=normal(d.locality);
    if(!suburb || !(locality===suburb || locality.endsWith(' '+suburb)))continue;
    const sex=normal(d.sex), hospitalSex=normal(h.r['Adult Gender']);
    if(['male','female'].includes(sex) && ['male','female'].includes(hospitalSex) && sex!==hospitalSex)continue;
    stats.candidates++;
    const key=h.id+'|'+date;
    uses.set(key,(uses.get(key)||0)+1);
    proposed.push({n,h,key});
  }
  for(const {n,h,key} of proposed) {
    if(uses.get(key)!==1){stats.ambiguous++;continue;}
    const name=koalaName(h.r['Koala Name']);if(!name){stats.placeholders++;continue;}
    // Client rechecks these fingerprints so names cannot attach to changed/reused IDs.
    names[String(n[0])]=[name,h.id,n[8],n[1],n[2],n[9].locality,PROJECT];stats.linked++;
  }
  return {version:1,source:SOURCE,licence:'CC BY 4.0',matchPolicy:'Unique incident: hospital source, exact day, published coordinates within 2m, matching suburb, no conflicting sex, no other hospital incident within 100m, one atlas record only.',names,stats};
}
export async function buildKoalaNames(rows, cacheFile=path.join(ROOT,'..','hospital-names-cache.json')) {
  let cache;try{cache=JSON.parse(await readFile(cacheFile,'utf8'));}catch{}
  if(cache?.version!==1 || !Number.isFinite(Date.parse(cache.fetched)) || Date.now()-Date.parse(cache.fetched)>7*86400000) {
    try {
      const records=[];let total=null;
      do {
        const q=new URLSearchParams({resource_id:RESOURCE,limit:'10000',offset:String(records.length),fields:'Record No,Koala Name,Date Time,LAT,LNG,Adult Gender,Koala Suburb',sort:'_id asc'});
        const response=await fetch('https://www.data.qld.gov.au/api/3/action/datastore_search?'+q,{signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw Error('Hospital source HTTP '+response.status);
        const j=await response.json();
        if(!j.success || !j.result?.records?.length || (total!==null && total!==j.result.total))throw Error('Incomplete hospital name response');
        total=j.result.total;records.push(...j.result.records);
      } while(records.length<total);
      if(records.length!==total || total<1000 || total>500000)throw Error('Unexpected hospital name coverage');
      cache={version:1,fetched:new Date().toISOString(),total,records};
      await writeFile(cacheFile+'.tmp',JSON.stringify(cache));await rename(cacheFile+'.tmp',cacheFile);
    }catch(e){
      if(cache?.version!==1 || !Number.isFinite(Date.parse(cache.fetched)) || Date.now()-Date.parse(cache.fetched)>30*86400000)throw e;
      console.warn('Hospital names: using previous complete cache:',e.message);
    }
  }
  if(cache.total!==cache.records?.length)throw Error('Incomplete hospital cache');
  return {...matchNames(rows,cache.records),fetched:cache.fetched};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [snapshot,out]=process.argv.slice(2);if(!snapshot||!out)throw Error('Usage: build-koala-names.mjs snapshot output.json');
  const meta=JSON.parse(await readFile(path.join(snapshot,'meta.json'),'utf8')),rows=[];
  for(const file of await readdir(path.join(snapshot,'p'))) {
    const tile=JSON.parse(await readFile(path.join(snapshot,'p',file),'utf8'));if(tile.b!==meta.built)throw Error('Mixed snapshot');
    for(const r of tile.r)if(typeof r[0]==='string')rows.push([r[0],r[1],r[2],r[3],meta.types[r[4]],meta.datasets[r[5]],r[6],r[7],r[19],r[20]]);
  }
  const result=await buildKoalaNames(rows);await writeFile(out,JSON.stringify(result));console.log(JSON.stringify(result.stats));
}
