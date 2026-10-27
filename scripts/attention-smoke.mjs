import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { collectAttention } from '../src/lib/attention.ts';
const collected=JSON.parse(await readFile('.delivery/catalog-audit/latest.json','utf8'));
let token=process.env.GITHUB_TOKEN;
if(!token){try{token=execFileSync('gh',['auth','token'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}}
let previous;try{previous=JSON.parse(await readFile('.delivery/catalog-audit/attention.json','utf8'));}catch{}
const result=await collectAttention(collected.items,previous,{githubToken:token});
await mkdir('.delivery/catalog-audit',{recursive:true});
await writeFile('.delivery/catalog-audit/attention.json',JSON.stringify(result));
const report={at:result.measuredAt,health:result.health,measurements:result.measurements.length,withHistory:result.measurements.filter(x=>x.previousMeasuredAt).length,discovered:result.candidates.length};
await writeFile('docs/attention-smoke.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
