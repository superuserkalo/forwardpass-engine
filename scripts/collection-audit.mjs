import { writeFile, mkdir } from 'node:fs/promises';
import { collectSourceStreams } from '../src/lib/source-collector.ts';
import { SOURCE_STREAMS } from '../src/lib/source-streams.ts';
const started = Date.now();
const result = await collectSourceStreams();
await mkdir('.delivery/catalog-audit', {recursive:true});
await writeFile('.delivery/catalog-audit/latest.json',JSON.stringify(result));
const report = {checkedAt:result.collectedAt, durationSeconds:(Date.now()-started)/1000, registered:SOURCE_STREAMS.length,
  counts:Object.fromEntries([...new Set(result.health.map(h=>h.status))].map(s=>[s,result.health.filter(h=>h.status===s).length])),
  freshItems:result.items.length, baselineItems:result.health.reduce((n,h)=>n+(h.baselineCount||0),0),
  pageMonitors:result.health.filter(h=>h.monitorCount>0).length,
  routes:result.health.map(h=>({...h,url:SOURCE_STREAMS.find(s=>s.id===h.streamId).url}))};
await writeFile('docs/source-catalog-collection-audit.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,routes:undefined}));
