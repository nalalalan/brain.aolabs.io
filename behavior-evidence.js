'use strict';
const crypto=require('node:crypto');
const rubric=require('./evidence-rubric.json');
const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
const hash=s=>crypto.createHash('sha256').update(normalize(s)).digest('hex');
const dateOf=s=>Date.parse(s.sourceCreatedAt||s.createdAt||0);
const ordered=files=>files.filter(s=>s.sourceText?.trim()).sort((a,b)=>dateOf(a)-dateOf(b)||a.id.localeCompare(b.id));
const dayOf=d=>new Date(d).toLocaleDateString('en-CA',{timeZone:'America/New_York'});
const outcomes={demonstrated:1,mixed:0.5,difficulty:0};
const levels=Object.fromEntries(rubric.levels.map(l=>[l.key,l.points]));
const verifications=require('./benchmark-verifications.json');
const sourceAudits=require('./source-evidence-exclusions.json').records;
const pointsRound=n=>n<100?Math.min(99,Math.round(n)):100;
function verifiedScope(source,metric,component,level,register=verifications.records){
 return register.find(v=>v.sourceId===source.id&&v.sourceHash===hash(source.sourceText)&&v.metric===metric&&v.component===component&&v.level===level&&v.status==='verified'&&v.personalContribution&&v.observedOutcome&&v.references?.length>=1&&Date.parse(v.evidenceDate)<=dateOf(source)&&(level!=='director'||(v.references.length>=2&&v.projectCount>=2&&v.peopleCount>=2&&v.sustainedDays>=90&&v.researchDirection&&v.externalUse)));
}
const fail=message=>Object.assign(new Error(message),{status:502});

// This computation never consumes an earlier generated score or explanation.
function componentEstimate(observations){
 if(!observations.length)return {score:0,raw:0,days:0,weight:0,demonstrated:0,weightedPoints:0,quote:'',sourceId:null,date:null,observations:[]};
 const last=observations.at(-1),cutoff=last.time-56*86400000,days=new Map(),seen=new Set();
 const recent=observations.filter(o=>o.time>=cutoff),supported=recent.filter(o=>o.outcome!=='difficulty');
 const scope=Math.max(...(supported.length?supported:recent).map(o=>levels[o.level]));
 for(const o of recent){
  // Easier successes do not erase a harder demonstrated capability or count as repetition of it.
  if(o.outcome==='demonstrated'&&levels[o.level]<scope)continue;
  const fingerprint=normalize(o.quote).toLowerCase().replace(/[^a-z0-9 ]/g,'');
  if(seen.has(fingerprint))continue;seen.add(fingerprint);
  const day=dayOf(o.time),bucket=days.get(day)||[];bucket.push(o);days.set(day,bucket);
 }
 let weight=0,demonstrated=0,weightedPoints=0;
 for(const bucket of days.values()){
  const dayTime=Math.max(...bucket.map(o=>o.time)),w=2**(-(last.time-dayTime)/(28*86400000));
  weight+=w;demonstrated+=w*bucket.reduce((s,o)=>s+outcomes[o.outcome],0)/bucket.length;
  weightedPoints+=w*bucket.reduce((sum,o)=>sum+levels[o.level]*outcomes[o.outcome],0)/bucket.length;
 }
 const allTop=[...days.values()].flat().every(o=>o.level==='director'&&o.outcome==='demonstrated');
 const raw=allTop?100:Math.min(99.999999,weightedPoints/weight);
 const representative=[...recent].reverse().find(o=>levels[o.level]===scope&&o.outcome!=='difficulty')||last;
 return {score:pointsRound(raw),raw,scope,weightedPoints:+weightedPoints.toFixed(4),days:days.size,weight:+weight.toFixed(4),demonstrated:+demonstrated.toFixed(4),quote:representative.quote,fact:representative.fact,limit:representative.limit,sourceId:representative.sourceId,date:representative.date,observations:[...days.values()].flat().map(o=>({sourceId:o.sourceId,date:o.date,outcome:o.outcome,level:o.level,scopeReason:o.scopeReason,points:levels[o.level]*outcomes[o.outcome]}))};
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
   values[metric.key]={score:pointsRound(Object.values(components).reduce((s,c)=>s+c.raw,0)/4),components,coverage,observed:accepted.length>0,confidence,evidenceDays:days,quote:evidence.quote,explanation:evidence.explanation,comparisonSourceId:null,observations:evidence.observations,change:'assessment'};
  }
  entries[source.id]={sourceId:source.id,sourceHash,historyHash,version:rubric.version,rubricHash:hash(JSON.stringify(rubric)),createdAt:record.createdAt,sourceChars:source.sourceText.length,analyzedChars:source.sourceText.length,model:record.model,reviewed:true,values};
 }
 return {version:rubric.version,metrics:rubric.metrics,rubric,entries};
}
function validateResult(item,source,register=verifications.records){
 if(item.sourceId!==source.id)throw fail('Evidence source mismatch.');
 const text=normalize(source.sourceText),values={},sourceAudit=sourceAudits.find(a=>a.sourceId===source.id&&a.sourceHash===hash(source.sourceText));
 for(const m of rubric.metrics){
  const v=item.values?.[m.key];if(!v||!Array.isArray(v.observations))throw fail('Missing behavior evidence.');
  const quote=normalize(v.quote),explanation=normalize(v.explanation);
  if(!quote||!text.includes(quote)||quote.length>180)throw fail('Highlight must be an exact short source quotation.');
  const words=explanation.split(/\s+/).length;
  if(words<22||words>55||explanation.length>460||!/\byou(?:r)?\b/i.test(explanation))throw fail('Analysis must address you in 22-55 concise words.');
  if(/\b(?:mastery|near[- ]top|exceptional|world[- ]class|professional[- ]level|high[- ]grade|extremely strong|your latest .* remains|no new evidence)\b/i.test(explanation))throw fail('Analysis must describe behavior without unsupported ability claims.');
  const used=new Set(),observations=[];
  for(const o of v.observations){
   try{
   if(!m.components.some(c=>c.key===o.component)||used.has(o.component)||!(o.outcome in outcomes)||!['current','historical'].includes(o.timeframe))throw fail('Invalid or repeated observation.');used.add(o.component);
   o.quote=normalize(o.quote);o.fact=normalize(o.fact);o.limit=normalize(o.limit);o.scopeReason=normalize(o.scopeReason);
   if(sourceAudit?.removedComponents[m.key]?.includes(o.component))throw fail(sourceAudit.reason);
   if(sourceAudit?.maxLevel&&levels[o.level]>levels[sourceAudit.maxLevel])throw fail('This exact source has been checked and does not establish a higher scope.');
   if(!(o.level in levels)||o.scopeReason.split(/\s+/).length<6)throw fail('Each observation needs a supported scope level and concrete scope reason.');
   if(levels[o.level]>=80&&!verifiedScope(source,m.key,o.component,o.level,register))throw fail('Professional and director levels require an independently inspected verification record for this exact source and component. Use a lower supported level.');
   if(!o.quote||!text.includes(o.quote)||o.quote.length>1200||!o.fact||!o.limit)throw fail('A behavior needs an exact passage, bounded fact and limitation.');
   if(text.split(/\s+/).length>20&&o.quote.split(/\s+/).length<6)throw fail('Use at least six exact words of context for each observation, not an ambiguous fragment.');
   // These are necessary exclusion checks, not a substitute for the separate source review.
   const onlyWish=/^(?:i|we)\s+(?:would like|want|hope|wish|could|should|might|am going to|will)\b/i.test(o.quote)&&!/[.!?]\s+(?:i|we)\s+(?:did|made|built|tried|tested|finished|told|said|asked|used|changed)\b/i.test(o.quote);
   if(o.outcome==='demonstrated'&&((m.key==='followthrough'&&o.component!=='selection')||(m.key==='insight'&&o.component==='application'))&&onlyWish)throw fail('A wish or intended action cannot establish a completed behavior.');
   if(m.key==='insight'&&o.component==='application'&&/remembering.*helps.*anxiety|these thoughts make me feel/i.test(o.quote))throw fail('Reported relief alone is not tested application.');
   if(m.key==='followthrough'&&o.component==='accumulation'&&/i hope.*(?:feedback|thoughts).*help|i hope.*(?:move|guide|help).*project/i.test(o.quote))throw fail('Hoping feedback helps is not a completed result.');
   if(o.outcome==='demonstrated'&&((m.key==='followthrough'&&o.component==='execution')||(m.key==='voice'&&o.component==='agency'))&&/\b(?:guarantee|promise|swear)\b/i.test(o.quote)&&!/\bi\s+(?:(?:have|had|already|actually)\s+)*(?:sent|texted|messaged|did|completed|maintained|kept|carried out)\b|\bi\s+(?:send|text|message)\b[^.!?]*\bevery day\b/i.test(o.quote))throw fail('A promise or guarantee does not establish that a routine has actually been carried out.');
   if(m.key==='followthrough'&&o.component==='recovery'&&/^keep (?:searching|trying)[.!]?$/i.test(o.quote))throw fail('An instruction to continue is not your own recovery action.');
   if(m.key==='followthrough'&&o.component==='recovery'&&/\b(?:i|we)\s+(?:(?:probably|likely)\s+)?(?:will|won['’]?t|would|wouldn['’]?t|am going to|are going to)\b|\bi['’]ll\b/i.test(o.quote)&&!/\b(?:i|we)\s+(?:(?:have|had|already|actually|then|just)\s+)*(?:stopped|changed|tried|tested|adjusted|restarted|retried|revised)\b/i.test(o.quote))throw fail('A stated future adjustment is not a reported recovery action; omit this observation unless the note supplies an actual subsequent adjustment.');
   observations.push(o);
   }catch(error){error.metric=m.key;error.component=o.component;throw error;}
  }
  values[m.key]={quote,explanation,observations};
 }
 return values;
}
module.exports={rubric,normalize,hash,dateOf,ordered,buildSeries,componentEstimate,validateResult,verifiedScope,pointsRound};
