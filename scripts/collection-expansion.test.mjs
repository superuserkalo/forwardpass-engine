import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SOURCE_STREAMS } from '../src/lib/source-streams.ts';
import { collectSourceStreams } from '../src/lib/source-collector.ts';
import { measureAttention, attachAttention, collectAttention } from '../src/lib/attention.ts';
import { candidateSchema } from '../src/lib/schemas.ts';
const now = new Date('2026-09-24T12:00:00Z');
const stream={id:'index',publisher:'Lab',publisherId:'lab',section:'research',category:'research',kind:'html-news',url:'https://example.test/research'};
test('every audited catalog route has exactly one registry entry, including access restrictions',async()=>{
 const c=JSON.parse(await readFile(new URL('../docs/source-catalog.json',import.meta.url),'utf8'));
 for(const source of c.sources)for(const page of source.pages){const u=new URL(page.fetchUrl||page.url);u.hash='';assert.equal(SOURCE_STREAMS.filter(s=>s.url===u.href).length,1,u.href);}
 for(const host of ['x.com','reddit.com','linkedin.com','alphaxiv.org'])assert.ok(SOURCE_STREAMS.filter(s=>s.host===host).every(s=>s.access==='permission-required'));
});
test('undated indexes baseline existing entries, detect new records, and never invent publication dates',async()=>{
 const first='<main><article><h2><a href="/old">An older research project</a></h2></article></main>';
 const second=first.replace('</main>','<article><h2><a href="/new">A newly listed research project</a></h2></article></main>');
 const a=await collectSourceStreams(undefined,{now,streams:[stream],fetcher:async()=>new Response(first)});
 assert.equal(a.items.length,0);assert.equal(a.health[0].baselineCount,1);
 const b=await collectSourceStreams(a.state,{now:new Date(now.getTime()+3600000),streams:[stream],fetcher:async()=>new Response(second)});
 assert.equal(b.items.length,1);assert.equal(b.items[0].url,'https://example.test/new');assert.equal(b.items[0].publishedAt,null);assert.equal(b.items[0].dateKind,'first-seen');
 const c=await collectSourceStreams(b.state,{now:new Date(now.getTime()+40*86400000),streams:[stream],fetcher:async()=>new Response(second)});
 assert.equal(c.items.length,0);
});
test('JSON-LD item dates and dated article cards work without inheriting page-level updated dates',async()=>{
 const body='<meta property="article:modified_time" content="2026-09-24"><main><script type="application/ld+json">{"@type":"NewsArticle","headline":"An actual dated result","url":"https://example.test/new","datePublished":"2026-09-24"}</script><article><h2><a href="/old">An undated older result</a></h2></article></main>';
 const r=await collectSourceStreams(undefined,{now,streams:[stream],fetcher:async()=>new Response(body)});
 assert.equal(r.items.length,1);assert.equal(r.items[0].title,'An actual dated result');assert.equal(r.health[0].baselineCount,1);
});
test('permission routes are visible and never fetched',async()=>{
 const r=await collectSourceStreams(undefined,{now,streams:[{...stream,access:'permission-required'}],fetcher:async()=>{throw new Error('should not fetch');}});
 assert.equal(r.health[0].status,'permission-required');
});
test('cold measurements have no velocity; later measurements retain negative deltas and actual time',()=>{
 const raw={platform:'github',id:'org/repo',url:'https://github.com/org/repo',measuredAt:now.toISOString(),score:100,secondaryCount:10};
 const first=measureAttention(raw);assert.equal(first.scorePerHour,null);
 const later=measureAttention({...raw,measuredAt:new Date(now.getTime()+7200000).toISOString(),score:96,secondaryCount:11},first);
 assert.equal(later.scoreDelta,-4);assert.equal(later.scorePerHour,-2);assert.equal(later.secondaryDelta,1);
 assert.equal(measureAttention(raw,{...first,id:'other'}).scoreDelta,null);
});
test('attention survives candidate validation and joins repo releases and original HN links',()=>{
 const metrics=[measureAttention({platform:'github',id:'org/repo',url:'https://github.com/org/repo',measuredAt:now.toISOString(),score:100,secondaryCount:10}),measureAttention({platform:'hacker-news',id:'1',url:'https://example.test/post?utm_source=hn',measuredAt:now.toISOString(),score:30,secondaryCount:7})];
 const base={title:'Story',summary:'Summary',source:'Source',category:'research',publishedAt:null};
 const rows=attachAttention([{...base,url:'https://github.com/org/repo/releases/tag/v1'},{...base,url:'https://example.test/post'}],metrics).map(c=>candidateSchema.parse(c));
 assert.equal(rows[0].attention[0].score,100);assert.equal(rows[1].attention[0].secondaryCount,7);
});

test('relative feed URLs and mislabelled Atom feeds retain dates and resolve against the stream',async()=>{
 const body='<feed><entry><id>new</id><title>A dated technical release</title><link href="/release"/><published>2026-09-24T09:00:00Z</published></entry></feed>';
 const r=await collectSourceStreams(undefined,{now,streams:[{...stream,kind:'rss'}],fetcher:async()=>new Response(body)});
 assert.equal(r.items[0].url,'https://example.test/release');assert.equal(r.items[0].publishedAt,'2026-09-24T09:00:00.000Z');
});
test('GitHub backfill follows pages without sending page-one cache validators',async()=>{
 const s={...stream,kind:'github-releases',url:'https://api.github.com/repos/org/repo/releases?per_page=100'};
 let calls=0;
 const r=await collectSourceStreams({version:1,streams:{index:{seen:{},etag:'"first"'}}},{now,streams:[s],fetcher:async(url,init)=>{
 calls++;if(calls>1)assert.equal(init.headers['If-None-Match'],undefined);
 return new Response(JSON.stringify([{id:calls,name:`v${calls}`,html_url:`https://github.com/org/repo/releases/tag/v${calls}`,published_at:'2026-09-24T09:00:00Z',draft:false}]),{headers:calls===1?{Link:'<https://api.github.com/repos/org/repo/releases?page=2>; rel="next"'}:{}});
 }});
 assert.equal(calls,2);assert.equal(r.items.length,2);assert.equal(r.health[0].possiblyTruncated,false);
});
test('fresh candidates cross midnight, keep first-party attribution and attach the newest metrics',async()=>{
 const {memoryStore,useStore}=await import('../src/lib/private-store.ts');const {freshCandidates}=await import('../src/pipeline/candidates.ts');
 const base={title:'Primary release',summary:'Detailed original',source:'Original Lab',url:'https://example.test/release',category:'research',publishedAt:'2026-09-23T23:30:00Z'};
 const metric=measureAttention({platform:'hacker-news',id:'1',url:base.url,measuredAt:'2026-09-24T01:00:00Z',score:22,secondaryCount:4});
 const snapshot=(at,items,candidates,measurements)=>({collectedAt:at,items,health:[],attention:{measuredAt:at,measurements,candidates,health:[]}});
 useStore(memoryStore({
  'collection/runs/2026-09-23/23.json':{...snapshot('2026-09-23T23:50:00Z',[base],[],[]),state:{version:1,streams:{}}},
  'collection/runs/2026-09-24/01.json':snapshot('2026-09-24T01:00:00Z',[],[{...base,source:'Hacker News',summary:'Submission',publishedAt:null}],[metric]),
 }));
 const {candidates,snapshots}=await freshCandidates('2026-09-24',new Date('2026-09-24T01:05:00Z'));
 assert.equal(snapshots,2);assert.equal(candidates.length,1);assert.equal(candidates[0].source,'Original Lab');assert.equal(candidates[0].publishedAt,base.publishedAt);assert.equal(candidates[0].attention[0].score,22);
});

test('Hacker News attention comes from windowed Algolia queries with points and comments',async()=>{
 const requests=[];
 const fetcher=async(url)=>{requests.push(url);
  if(url.startsWith('https://hn.algolia.com/'))return Response.json({hits:requests.length===1?[{objectID:'42',title:'New open model',url:'https://example.test/model',points:120,num_comments:30,created_at_i:Math.floor(now.getTime()/1000)-3600}]:[]});
  throw new Error('unexpected '+url);};
 const report=await collectAttention([],undefined,{now,fetcher,streams:[],githubToken:undefined});
 assert.equal(requests.length,6);assert.match(decodeURIComponent(requests[0]),/points>=3/);
 assert.equal(report.candidates.length,1);assert.equal(report.candidates[0].attention[0].score,120);assert.equal(report.candidates[0].attention[0].secondaryCount,30);
 assert.equal(report.health.find(h=>h.platform==='github').status,'failed');
});

test('GitHub stars for many repositories come from one GraphQL request per 50',async()=>{
 const bodies=[];
 const fetcher=async(url,init)=>{
  if(url.startsWith('https://hn.algolia.com/'))return Response.json({hits:[]});
  bodies.push(JSON.parse(init.body).query);
  const data=Object.fromEntries([...JSON.parse(init.body).query.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)].map(([,alias,owner,name])=>[alias,{nameWithOwner:`${owner}/${name}`,url:`https://github.com/${owner}/${name}`,stargazerCount:7,forkCount:1}]));
  return Response.json({data});};
 const candidates=Array.from({length:60},(_,i)=>({title:`repo ${i}`,summary:'',url:`https://github.com/org/repo${i}`,publishedAt:null,source:'x',category:'x'}));
 const report=await collectAttention(candidates,undefined,{now,fetcher,streams:[],githubToken:'token'});
 assert.equal(bodies.length,2);assert.equal(report.measurements.filter(m=>m.platform==='github').length,60);
});
