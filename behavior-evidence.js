'use strict';
const crypto=require('node:crypto');
const rubric=require('./evidence-rubric.json');
const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
const hash=s=>crypto.createHash('sha256').update(normalize(s)).digest('hex');
const dateOf=s=>Date.parse(s.sourceCreatedAt||s.createdAt||0);
const ordered=files=>files.filter(s=>s.sourceText?.trim()).sort((a,b)=>dateOf(a)-dateOf(b)||a.id.localeCompare(b.id));
const dayOf=d=>new Date(d).toLocaleDateString('en-CA',{timeZone:'America/New_York'});
const outcomes={demonstrated:1,mixed:0.5,difficulty:0};
const fail=message=>Object.assign(new Error(message),{status:502});

// This computation never consumes an earlier generated score or explanation.
function componentEstimate(observations){
 if(!observations.length)return {score:50,raw:50,days:0,weight:0,demonstrated:0,quote:'',sourceId:null,date:null,observations:[]};
 const last=observations.at(-1),cutoff=last.time-56*86400000,days=new Map(),seen=new Set();
 for(const o of observations){
  if(o.time<cutoff)continue;
  const fingerprint=normalize(o.quote).toLowerCase().replace(/[^a-z0-9 ]/g,'');
  if(seen.has(fingerprint))continue;seen.add(fingerprint);
  const day=dayOf(o.time),bucket=days.get(day)||[];bucket.push(o);days.set(day,bucket);
 }
 let weight=0,demonstrated=0;
 for(const bucket of days.values()){
  const dayTime=Math.max(...bucket.map(o=>o.time)),w=2**(-(last.time-dayTime)/(28*86400000));
  weight+=w;demonstrated+=w*bucket.reduce((s,o)=>s+outcomes[o.outcome],0)/bucket.length;
 }
 const raw=100*(1+demonstrated)/(2+weight);
 return {score:Math.round(raw),raw,days:days.size,weight:+weight.toFixed(4),demonstrated:+demonstrated.toFixed(4),quote:last.quote,fact:last.fact,limit:last.limit,sourceId:last.sourceId,date:last.date,observations:[...days.values()].flat().map(o=>({sourceId:o.sourceId,date:o.date,outcome:o.outcome}))};
}
function buildSeries(files,records){
 const entries={},streams=Object.fromEntries(rubric.metrics.map(m=>[m.key,Object.fromEntries(m.components.map(c=>[c.key,[]]))])),seenSources=new Set();
 const prefix=[];
 for(const source of ordered(files)){
  const sourceHash=hash(source.sourceText),record=records[source.id],historyHash=hash(JSON.stringify(prefix));prefix.push([source.id,sourceHash]);
  if(!record||record.sourceHash!==sourceHash||record.version!==rubric.version||record.reviewed!==true)continue;
  const duplicate=seenSources.has(sourceHash);seenSources.add(sourceHash);const values={};
  for(const metric of rubric.metrics){
   const evidence=record.values[metric.key],accepted=duplicate?[]:evidence.observations.filter(o=>o.timeframe==='current'&&!streams[metric.key][o.component].some(old=>normalize(old.quote).toLowerCase()===normalize(o.quote).toLowerCase()));
   for(const o of accepted){streams[metric.key][o.component].push({...o,sourceId:source.id,date:source.sourceCreatedAt||source.createdAt,time:dateOf(source)});}
   const components=Object.fromEntries(metric.components.map(c=>[c.key,componentEstimate(streams[metric.key][c.key])]));
   const populated=Object.values(components).filter(c=>c.days>0),days=new Set(Object.values(components).flatMap(c=>c.observations.map(o=>dayOf(Date.parse(o.date))))).size;
   const coverage=populated.length,minDays=Math.min(...Object.values(components).map(c=>c.days));
   const confidence=coverage<4||minDays<3?'limited':minDays<7?'developing':'broader';
   values[metric.key]={score:Math.round(Object.values(components).reduce((s,c)=>s+c.raw,0)/4),components,coverage,observed:accepted.length>0,confidence,evidenceDays:days,quote:evidence.quote,explanation:evidence.explanation,comparisonSourceId:null,observations:evidence.observations,change:'assessment'};
  }
  entries[source.id]={sourceId:source.id,sourceHash,historyHash,version:rubric.version,rubricHash:hash(JSON.stringify(rubric)),createdAt:record.createdAt,sourceChars:source.sourceText.length,analyzedChars:source.sourceText.length,model:record.model,reviewed:true,values};
 }
 return {version:rubric.version,metrics:rubric.metrics,rubric,entries};
}
function validateResult(item,source){
 if(item.sourceId!==source.id)throw fail('Evidence source mismatch.');
 const text=normalize(source.sourceText),values={};
 for(const m of rubric.metrics){
  const v=item.values?.[m.key];if(!v||!Array.isArray(v.observations))throw fail('Missing behavior evidence.');
  const quote=normalize(v.quote),explanation=normalize(v.explanation);
  if(!quote||!text.includes(quote)||quote.length>180)throw fail('Highlight must be an exact short source quotation.');
  const words=explanation.split(/\s+/).length;
  if(words<22||words>55||explanation.length>460||!/\byou(?:r)?\b/i.test(explanation))throw fail('Analysis must address you in 22-55 concise words.');
  if(/\b(?:mastery|near[- ]top|exceptional|world[- ]class|professional[- ]level|high[- ]grade|extremely strong|your latest .* remains|no new evidence)\b/i.test(explanation))throw fail('Analysis must describe behavior without unsupported ability claims.');
  const used=new Set(),observations=[];
  for(const o of v.observations){
   if(!m.components.some(c=>c.key===o.component)||used.has(o.component)||!(o.outcome in outcomes)||!['current','historical'].includes(o.timeframe))throw fail('Invalid or repeated observation.');used.add(o.component);
   o.quote=normalize(o.quote);o.fact=normalize(o.fact);o.limit=normalize(o.limit);
   if(!o.quote||!text.includes(o.quote)||o.quote.length>900||!o.fact||!o.limit)throw fail('A behavior needs an exact passage, bounded fact and limitation.');
   if(text.split(/\s+/).length>20&&o.quote.split(/\s+/).length<6)throw fail('Use at least six exact words of context for each observation, not an ambiguous fragment.');
   // These are necessary exclusion checks, not a substitute for the separate source review.
   const onlyWish=/^(?:i|we)\s+(?:would like|want|hope|wish|could|should|might|am going to|will)\b/i.test(o.quote)&&!/[.!?]\s+(?:i|we)\s+(?:did|made|built|tried|tested|finished|told|said|asked|used|changed)\b/i.test(o.quote);
   if(o.outcome==='demonstrated'&&((m.key==='followthrough'&&o.component!=='selection')||(m.key==='insight'&&o.component==='application'))&&onlyWish)throw fail('A wish or intended action cannot establish a completed behavior.');
   if(m.key==='insight'&&o.component==='application'&&/remembering.*helps.*anxiety|these thoughts make me feel/i.test(o.quote))throw fail('Reported relief alone is not tested application.');
   if(m.key==='followthrough'&&o.component==='accumulation'&&/i hope.*(?:move|guide|help).*project/i.test(o.quote))throw fail('Hoping feedback helps is not a completed result.');
   if(m.key==='followthrough'&&o.component==='recovery'&&/\b(?:i|we)\s+(?:will|would|am going to|are going to)\b|\bi['’]ll\b/i.test(o.quote)&&!/\b(?:i|we)\s+(?:(?:have|had|already|actually|then|just)\s+)*(?:stopped|changed|tried|tested|adjusted|restarted|retried|revised)\b/i.test(o.quote))throw fail('A stated future adjustment is not a reported recovery action; omit this observation unless the note supplies an actual subsequent adjustment.');
   observations.push(o);
  }
  values[m.key]={quote,explanation,observations};
 }
 return values;
}
module.exports={rubric,normalize,hash,dateOf,ordered,buildSeries,componentEstimate,validateResult};
