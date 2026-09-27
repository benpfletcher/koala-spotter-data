// Enrich an existing snapshot without replacing IDs, coordinates or original BioNet details.
// Every aggregate is rebuilt from the resulting point records, including restored dates.
// Usage: node tools/enrich-snapshot.mjs oldSnapshot nationalCache outputDirectory
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import {validateSnapshot} from './validate-snapshot.mjs';
const [oldDir,cacheFile,out]=process.argv.slice(2);
if(!oldDir||!cacheFile||!out||path.resolve(oldDir)===path.resolve(out))throw Error('Use a separate staging output directory');
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const old=await read(path.join(oldDir,'meta.json')),cache=await read(cacheFile);
const national=new Map(Object.values(cache.datasets).flatMap(d=>d.records).map(r=>[String(r[0]),r]));
const meta=structuredClone(old),records=[],summary={matched:0,missing:0,datesRecovered:0,datesRefined:0,typed:0,withPhotos:0,photos:0,hospital:0};
for(const file of await readdir(path.join(oldDir,'p'))) {
  const tile=await read(path.join(oldDir,'p',file));if(tile.b!==old.built)throw Error('Mixed source generations');
  for(const row of tile.r) {
    if(typeof row[0]==='string') {
      const n=national.get(row[0]);
      if(n) {
        summary.matched++;if(row[3]==null&&n[3]!=null)summary.datesRecovered++;else if(row[19]!==n[8])summary.datesRefined++;
        if(!meta.types.includes(n[4]))meta.types.push(n[4]);
        row[3]=n[3];row[4]=meta.types.indexOf(n[4]);row[19]=n[8];row[20]=n[9];
        if(n[4]!=='Record')summary.typed++;if(n[4]==='Wildlife hospital record')summary.hospital++;
        if(n[9]?.photos?.length){summary.withPhotos++;summary.photos+=n[9].photos.length;}
      } else summary.missing++;
    }
    records.push(row);
  }
}
if(summary.missing>meta.sources.national.kept*.01)throw Error('Too many existing records absent from refreshed source; inspect before publication');
const now=new Date(),DAY=86400000,cut=y=>{const d=new Date(now);d.setUTCFullYear(d.getUTCFullYear()-y);return Math.floor(d.getTime()/DAY);};
meta.built=now.toISOString();meta.correctedFrom=old.built;meta.nationalTransformVersion=cache.version;
meta.snapshotDate=meta.built.slice(0,10);meta.todayDays=Math.floor(now/DAY);meta.cut={y1:cut(1),y5:cut(5),y10:cut(10)};
meta.enrichment={...summary,fetched:cache.fetched,wildnet:cache.wildnet,positionPolicy:'Existing published coordinates and IDs retained'};
meta.record[20]='sourceDetail';
validateSnapshot(meta,old);if(records.length!==old.total)throw Error('Record loss');
const put=async(file,obj)=>{await mkdir(path.dirname(path.join(out,file)),{recursive:true});await writeFile(path.join(out,file),JSON.stringify(obj));};
const tiles=new Map();for(const r of records){const k=`${Math.floor(r[1]/meta.pointCell)}_${Math.floor(r[2]/meta.pointCell)}`;if(!tiles.has(k))tiles.set(k,[]);tiles.get(k).push(r);}
for(const[k,r]of tiles)await put(`p/${k}.json`,{b:meta.built,r});
for(let i=0;i<meta.aggCells.length;i++) {
  const size=meta.aggCells[i],cells=new Map();
  for(const r of records){const x=Math.floor(r[1]/size),y=Math.floor(r[2]/size),k=x+'_'+y;if(!cells.has(k))cells.set(k,[x,y,0,0,0,0,0,0,-1]);const c=cells.get(k);c[5]++;c[6]+=r[1];c[7]+=r[2];if(r[3]!=null){if(r[3]>=meta.cut.y1)c[2]++;if(r[3]>=meta.cut.y5)c[3]++;if(r[3]>=meta.cut.y10)c[4]++;c[8]=Math.max(c[8],r[3]);}}
  for(const c of cells.values()){c[6]=+(c[6]/c[5]).toFixed(5);c[7]=+(c[7]/c[5]).toFixed(5);}
  if(i<=meta.aggSingleMaxIdx)await put(`a/${i}/all.json`,{b:meta.built,c:[...cells.values()]});
  else{const groups=new Map();for(const c of cells.values()){const k=`${Math.floor(c[0]*size)}_${Math.floor(c[1]*size)}`;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(c);}for(const[k,c]of groups)await put(`a/${i}/${k}.json`,{b:meta.built,c});}
}
await put('latest.json',{b:meta.built,r:records.filter(r=>r[3]!=null).sort((a,b)=>b[3]-a[3]).slice(0,400)});
await put('tiles.json',{b:meta.built,cell:meta.pointCell,keys:[...tiles.keys()]});await put('meta.json',meta);
console.log(JSON.stringify({total:records.length,...summary,built:meta.built},null,2));
