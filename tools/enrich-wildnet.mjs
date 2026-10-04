// Match Queensland's public records by their original WildNet IDs through ALA.
// Never match on coordinates, infer an observation method from a project name,
// or replace GBIF's published WGS84 position with GDA2020 coordinates.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { clean, observationType } from './observation-detail.mjs';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const WILDNET_KEY = 'e4473544-f4cd-4429-b791-39d6e1fdb0a4';
const API = 'https://wildnet-pub.science-data.qld.gov.au/api/v1';
const DAY = 86400000;
// ALA rate-limits anonymous bursts with 403/429: identify the client and wait properly before retrying.
const HEADERS = {'User-Agent':'koala-spotter-data/1.0 (+https://github.com/benpfletcher/koala-spotter-data; benpfletcher@gmail.com)',Accept:'application/json'};
const pause = ms => new Promise(r=>setTimeout(r,ms));
async function json(url) {
  for(let i=0;;i++) {
    let limited=false;
    try { const r=await fetch(url,{headers:HEADERS,signal:AbortSignal.timeout(45000)}); limited=r.status===403||r.status===429; if(!r.ok)throw Error(`HTTP ${r.status}: ${url}`); return await r.json(); }
    catch(e) { if(i===(limited?5:3))throw e; await pause(limited?30000*(i+1):1000*(i+1)); }
  }
}
const BULK_FIELDS = ['sighting_id','taxon_id','restricted_record','sighting_date','project_name','src_name','site_visit_start_date','site_visit_end_date'];
function compactBulk(r) { return Object.fromEntries(BULK_FIELDS.filter(k=>r[k]!=null).map(k=>[k,r[k]])); }
async function save(file,data) {
  if(data.records && !Array.isArray(data.records))data.records=Object.fromEntries(Object.entries(data.records).map(([k,r])=>[k,compactBulk(r)])); await writeFile(file+'.tmp',JSON.stringify(data)); await rename(file+'.tmp',file); }
async function read(file,fallback) { try{return JSON.parse(await readFile(file,'utf8'));}catch{return fallback;} }
export function applyWildnet(row, record, full = null) {
  if(record.taxon_id !== 860 || record.restricted_record || !record.sighting_id) return false;
  const detail = row[9]; if(!detail) return false;
  if(!('gbifDate' in detail)) {detail.gbifDate=row[8];detail.gbifDays=row[3];}
  const date=record.sighting_date;
  // Only complete source dates become filterable dates; retain all original date ranges.
  if(typeof date==='string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date+'T00:00:00Z')) && new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date) {
    row[8]=date; row[3]=Math.floor(Date.parse(date+'T00:00:00Z')/DAY);
  }
  detail.wildnetId=record.sighting_id;
  detail.wildnetUri=`${API}/sightings/${record.sighting_id}`;
  detail.project=clean(record.project_name) || detail.project;
  detail.provider=clean(record.src_name);
  const start=record.site_visit_start_date,end=record.site_visit_end_date;
  if(start && end) detail.visitDate=start===end?start:`${start}/${end}`;
  const source=full && full.sighting_id===record.sighting_id && full.taxon_id===860 && !full.restricted_record && !full.taxon_confidentiality && !full.sighting_confidentiality && !full.source_release_restriction && !full.project_release_restriction ? full : record;
  const type=observationType(source,row[5]); if(type!=='Record')row[4]=type;
  if(source===full) {
    detail.method=clean(full.identification_method) || detail.method;
    detail.surveyMethod=clean(full.survey_method);
    detail.sex=clean(full.sex)||detail.sex;
    detail.lifeStage=clean(full.age)||detail.lifeStage;
    detail.recordStatus=clean(full.vetting_stage)||detail.recordStatus;
    detail.locality=clean(full.locality)||detail.locality;
    detail.notes=clean(full.sighting_notes)||detail.notes;
  }
  return true;
}
export async function enrichWildnet(rows, cacheFile=path.join(ROOT,'..','wildnet-detail-cache.json'), log=console.log) {
  if(!rows.length)return {matched:0};
  const cache=await read(cacheFile,{version:1,crosswalk:{},records:{},details:{}});
  if(cache.version!==1)throw Error('Unsupported WildNet cache');
  const fresh=cache.fetched && Date.now()-Date.parse(cache.fetched)<DAY;
  if(!fresh) {
    // UUID prefix partitions stay below ALA's deep paging limit. ALA accepts 100 rows/page.
    let crosswalk={}; let next=0;
    try { await Promise.all(Array.from({length:3},async()=>{
      while(next<256) {
        const prefix=(next++).toString(16).padStart(2,'0');let total=Infinity;const found=new Set();
        for(let start=0;start<total;start+=100) {
          const q=new URLSearchParams({q:'taxon_name:"Phascolarctos cinereus"',pageSize:'100',startIndex:String(start),fl:'id,occurrenceID',sort:'id',dir:'asc'});
          q.append('fq','data_resource_uid:dr1132');q.append('fq',`id:${prefix}*`);
          const j=await json('https://biocache-ws.ala.org.au/ws/occurrences/search?'+q);total=j.totalRecords;await pause(120);
          if(!Number.isInteger(total)||total>1000||!j.occurrences?.length)throw Error(`Incomplete ALA crosswalk: ${prefix} offset ${start}, total ${total}, page ${j.occurrences?.length}`);
          for(const o of j.occurrences) {const m=/^urn:catalog:QGov:DES:WildNet:(\d+)$/.exec(o.occurrenceID||'');if(!m||!o.uuid?.startsWith(prefix))throw Error('Unexpected WildNet identifier');crosswalk[o.uuid]=+m[1];found.add(o.uuid);}
        }
        if(found.size!==total)throw Error(`ALA paging mismatch for ${prefix}: ${found.size}/${total}`);
        if(parseInt(prefix,16)%16===0)log(`WildNet identifiers: prefix ${prefix}, ${Object.keys(crosswalk).length} exact matches`);
      }
    })); }
    catch(e) {
      // WildNet identifiers never change, so the last complete crosswalk stays valid when ALA refuses the crawl.
      // New records it lacks are caught by the 98% exact-match check below.
      next=256; if(!Object.keys(cache.crosswalk||{}).length)throw e;
      log(`ALA crosswalk unavailable (${e.message.slice(0,80)}); reusing ${Object.keys(cache.crosswalk).length} saved identifiers`); crosswalk=cache.crosswalk;
    }
    const records={};let after=0;
    for(;;) {
      const list=await json(`${API}/sightings?taxon_id=860&page_size=5000&after_sighting_id=${after}`);
      if(!Array.isArray(list))throw Error('Invalid WildNet list');if(!list.length)break;
      for(const r of list) {if(r.taxon_id!==860||r.sighting_id<=after)throw Error('Invalid WildNet page');records[r.sighting_id]=r;}
      const last=list.at(-1).sighting_id;if(last<=after)throw Error('WildNet pagination stalled');after=last;
      log(`WildNet public dates: ${Object.keys(records).length} records`);
    }
    if(Object.keys(records).length < rows.length*.8)throw Error('Incomplete WildNet public list');
    cache.crosswalk=crosswalk;cache.records=records;cache.fetched=new Date().toISOString();
    await save(cacheFile,cache);
  }
  // Bounded, persistent enrichment: never make tens of thousands of detail requests per build.
  // Newest records first. Existing detail responses are retained, then refreshed after the backlog.
  const mapped=rows.map(r=>({row:r,id:cache.crosswalk[r[9]?.occurrenceId]})).filter(x=>x.id&&cache.records[x.id]);
  if(rows.some(r=>r[9]?.occurrenceId) && mapped.length < rows.length*.98)throw Error('Incomplete WildNet exact-ID match; previous snapshot retained');
  const limit=Number(process.env.WILDNET_DETAIL_LIMIT||500);
  const todo=mapped.filter(x=>!cache.details[x.id] || Date.now()-Date.parse(cache.details[x.id].fetched)>30*DAY).sort((a,b)=>Number(!!cache.details[a.id])-Number(!!cache.details[b.id]) || (cache.records[b.id].sighting_date||'').localeCompare(cache.records[a.id].sighting_date||'')).slice(0,limit);
  let n=0;
  await Promise.all(Array.from({length:3},async()=>{while(n<todo.length){const {id}=todo[n++];try {cache.details[id]={fetched:new Date().toISOString(),record:await json(`${API}/sightings/${id}`)};}catch(e){log(`WildNet detail ${id} deferred: ${e.message}`);}}}));
  await save(cacheFile,cache);
  const summary={matched:0,datesRecovered:0,datesRefined:0,methodSupplied:0,hospital:0,detailsCached:Object.keys(cache.details).length,fetched:cache.fetched};
  for(const {row,id} of mapped) {
    const before=row[8];if(!applyWildnet(row,cache.records[id],cache.details[id]?.record))continue;
    summary.matched++;if(!before&&row[8])summary.datesRecovered++;else if(before!==row[8])summary.datesRefined++;
    if(row[9].method)summary.methodSupplied++;if(row[4]==='Wildlife hospital record')summary.hospital++;
  }
  log('WildNet enrichment: '+JSON.stringify(summary));return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const file=process.argv[2];const data=await read(file,null);if(!data)throw Error('Supply a national cache file');
  const rows=data.datasets[WILDNET_KEY]?.records||[];
  data.wildnet=await enrichWildnet(rows,process.argv[3]);await save(file,data);
}
