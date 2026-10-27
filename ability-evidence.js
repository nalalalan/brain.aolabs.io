'use strict';
const {normalize,hash,dateOf,ordered,verifiedScope}=require('./behavior-evidence');
const {version:estimationVersion,estimateDays,pointsRound}=require('./ability-estimate');
const rubric=require('./ability-rubric.json');
const audits=require('./ability-evidence-exclusions.json').records;
const levels=Object.fromEntries(rubric.levels.map(l=>[l.key,l.points]));
const dayFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}),dayCache=new Map();
function dayOf(t){if(dayCache.has(t))return dayCache.get(t);const value=dayFormatter.format(new Date(t));if(dayCache.size>=4096)dayCache.clear();dayCache.set(t,value);return value;}
const fail=message=>Object.assign(new Error(message),{status:502});
function unsupportedLowReason(o){
 if(o.level!=='developing')return false;
 const absence=/\b(?:tentativ\w*|unsettled|uncertain|unresolved|underspecified|underexplained|unsure|hypothetical|unverified|hedging|uncommitted|sparse|too unclear|not yet|cannot yet|stops short|lacks?|without enough|without a committed|no resolution|no concrete|no specific|no actual|does not show|do not show|not show)\b|\bno\b[^.]{0,65}\b(?:appears?|shown)\b/i.test(o.reason);
 const difficulty=/\b(?:breakdown|failed|fails|failure|escalat\w*|contradict\w*|bias|refusal|pushes back|harmful|ineffective|unsafe|unworkable|violat\w*|dismiss\w*|ignores?\b[^.]*\bboundar\w*)\b/i.test(o.reason);
 return absence&&!difficulty;
}
function componentEstimate(observations){
 if(!observations.length)return {score:null,raw:null,days:0,weight:0,weightedPoints:0,observations:[],sourceId:null};
 const last=observations.at(-1),recent=observations.filter(o=>o.time>=last.time-56*86400000),seen=new Set(),days=new Map();
 for(const o of recent){const fingerprint=normalize(o.quote).toLowerCase();if(seen.has(fingerprint))continue;seen.add(fingerprint);const day=dayOf(o.time),bucket=days.get(day)||[];bucket.push(o);days.set(day,bucket);}
 let weight=0,weightedPoints=0;const dailyEvidence=[];
 for(const bucket of days.values()){
  const time=Math.max(...bucket.map(o=>o.time)),w=2**(-(last.time-time)/(28*86400000));
  const quality=o=>o.certainty==='clear'?1:0.5,q=bucket.reduce((s,o)=>s+quality(o),0);
  const daily=bucket.reduce((s,o)=>s+levels[o.level]*quality(o),0)/q;
  const evidenceWeight=w*Math.max(...bucket.map(quality));weight+=evidenceWeight;weightedPoints+=daily*evidenceWeight;
  dailyEvidence.push({points:daily,weight:evidenceWeight,contraryPattern:bucket.some(o=>levels[o.level]<=25)});
 }
 const overall=estimateDays(dailyEvidence),raw=overall.raw;
 const representative=[...recent].sort((a,b)=>Math.abs(levels[a.level]-raw)-Math.abs(levels[b.level]-raw)||b.time-a.time)[0];
 return {score:pointsRound(raw),raw,days:days.size,weight:+weight.toFixed(4),weightedPoints:+weightedPoints.toFixed(4),estimateMethod:overall.method,retainedWeight:overall.retainedWeight,retainedPoints:overall.retainedPoints,quote:representative.quote,fact:representative.fact,limit:representative.limit,sourceId:representative.sourceId,date:representative.date,observations:[...days.values()].flat().map(o=>({sourceId:o.sourceId,date:o.date,outcome:o.evidenceType,level:o.level,points:levels[o.level],certainty:o.certainty,scopeReason:o.reason}))};
}
function buildSeries(files,records){
 const entries={},streams=Object.fromEntries(rubric.metrics.map(m=>[m.key,Object.fromEntries(m.components.map(c=>[c.key,[]]))])),seenSources=new Set(),prefix=[];
 for(const source of ordered(files)){
  const sourceHash=hash(source.sourceText),record=records[source.id],historyHash=hash(JSON.stringify(prefix));prefix.push([source.id,sourceHash]);
  if(!record||record.sourceHash!==sourceHash||record.version!==rubric.version||record.reviewed!==true)continue;
  const duplicate=seenSources.has(sourceHash);seenSources.add(sourceHash);const values={};
  for(const metric of rubric.metrics){
   const evidence=record.values[metric.key],accepted=duplicate?[]:evidence.observations.filter(o=>o.timeframe==='current'&&!streams[metric.key][o.component].some(old=>normalize(old.quote).toLowerCase()===normalize(o.quote).toLowerCase()));
   for(const o of accepted)streams[metric.key][o.component].push({...o,sourceId:source.id,date:source.sourceCreatedAt||source.createdAt,time:dateOf(source)});
   const components=Object.fromEntries(metric.components.map(c=>[c.key,componentEstimate(streams[metric.key][c.key])]));
   const known=Object.values(components).filter(c=>Number.isFinite(c.raw)),coverage=known.length,minDays=known.length?Math.min(...known.map(c=>c.days)):0;
   const days=new Set(known.flatMap(c=>c.observations.map(o=>dayOf(Date.parse(o.date))))).size;
   const raw=coverage?known.reduce((s,c)=>s+c.raw,0)/coverage:null;
   const score=raw===null?null:coverage<4?Math.min(99,pointsRound(raw)):pointsRound(raw);
   values[metric.key]={score,components,coverage,observed:accepted.length>0,confidence:coverage<4||minDays<3?'limited':minDays<7?'developing':'broader',evidenceDays:days,quote:evidence.quote,explanation:evidence.explanation,comparisonSourceId:null,observations:evidence.observations,change:'assessment'};
  }
  entries[source.id]={sourceId:source.id,sourceHash,historyHash,version:rubric.version,estimationVersion,rubricHash:hash(JSON.stringify(rubric)),createdAt:record.createdAt,sourceChars:source.sourceText.length,analyzedChars:source.sourceText.length,model:record.model,reviewed:true,values};
 }
 return {version:rubric.version,estimationVersion,metrics:rubric.metrics,rubric,entries};
}
function validateResult(item,source,register){
 if(item.sourceId!==source.id)throw fail('Evidence source mismatch.');
 const text=normalize(source.sourceText),audit=audits.find(a=>a.sourceId===source.id&&a.sourceHash===hash(source.sourceText)),values={};
 for(const m of rubric.metrics){
  const v=item.values?.[m.key];if(!v||!Array.isArray(v.observations))throw fail('Missing ability evidence.');
  const quote=normalize(v.quote),explanation=normalize(v.explanation),words=explanation.split(/\s+/).length;
  if(!quote||!text.includes(quote)||quote.length>180)throw fail('Highlight must be an exact short source quotation.');
  if(words<22||words>55||explanation.length>460||! /\byou(?:r)?\b/i.test(explanation))throw fail('Analysis must address you in 22-55 concise words.');
  const prohibited=explanation.match(/\b(?:homeless|IQ|percent(?:age)? of|world[- ]class|your latest .* remains|no new evidence)\b/i);
  const clinicalDiagnosis=/\bdiagnos\w*\b[^.!?]{0,60}\b(?:autis\w*|ADHD|psychiatric|mental|disorder|clinical)\b|\b(?:autis\w*|ADHD|psychiatric|mental|disorder|clinical)\b[^.!?]{0,60}\bdiagnos\w*\b/i.test(explanation);
  if(prohibited||clinicalDiagnosis)throw fail('Explain the specific ability evidence without social ranking, clinical diagnosis or boilerplate'+(prohibited?' (rejected wording: '+prohibited[0]+')':'')+'. Technical diagnosis of a mechanism or figure problem is allowed.');
  const used=new Set(),observations=[];
  for(const original of v.observations){const o={...original};try{
   if(!m.components.some(c=>c.key===o.component))throw fail('Invalid component '+m.key+'.'+o.component+'.');
   if(used.has(o.component))throw Object.assign(fail('Repeated component '+m.key+'.'+o.component+'. Keep at most one best-supported observation for this component.'),{preserveComponent:true});used.add(o.component);
   if(!(o.level in levels)||!['current','historical'].includes(o.timeframe)||!['direct_writing','reported_action','reported_difficulty'].includes(o.evidenceType)||!['clear','limited'].includes(o.certainty))throw fail('Invalid ability evidence fields.');
   for(const k of ['quote','fact','limit','reason'])o[k]=normalize(o[k]);
   if(!o.quote||!text.includes(o.quote)||o.quote.length>1200||!o.fact||!o.limit||o.reason.split(/\s+/).length<6)throw fail('Evidence requires an exact passage, bounded fact, limitation and rating reason.');
   if(text.split(/\s+/).length>20&&o.quote.split(/\s+/).length<6)throw fail('Use at least six exact source words of context.');
   if(audit?.removedComponents?.[m.key]?.includes(o.component))throw fail(audit.reason);
   if(o.level==='benchmark'&&!verifiedScope(source,m.key,o.component,'director',register))throw fail('100 requires independently corroborated sustained research leadership for this exact component.');
   if(m.key==='followthrough'&&o.component!=='selection'&&o.evidenceType==='direct_writing')throw fail('Writing a request or plan cannot establish completed execution, recovery or results.');
   if(o.level==='struggling'&&(!/\b(?:knowingly|knowing|deliberat\w*|fabricat\w*|deceiv\w*|decept\w*|conceal\w*)\b/i.test(o.reason+' '+o.fact)||!['reported_difficulty','reported_action'].includes(o.evidenceType)))throw Object.assign(fail('The Holmes zero requires explicit knowing deception, fabricated success or deliberate disregard of known contrary evidence. An honest failure or missing evidence is not zero. Re-read the source without inferring intent.'),{preserveComponent:true});
   if(unsupportedLowReason(o))throw Object.assign(fail('A low rating needs a demonstrated weakness, not merely a tentative or unfinished choice, missing detail or absent resolution. Identify the actual difficulty from the source, or omit the unknown component; do not automatically raise the rating.'),{preserveComponent:true});
   const future=/^(?:i|we)\s+(?:would like|want|hope|wish|could|should|might|am going to|will)\b/i.test(o.quote);
   const actual=/[.!?]\s+(?:i|we)\s+(?:did|made|built|tried|tested|finished|told|said|asked|used|changed)\b/i.test(o.quote);
   if(m.key==='followthrough'&&o.component!=='selection'&&future&&!actual)throw fail('An intended action cannot establish completed follow-through.');
   const reportedDone=/\bi\s+(?:(?:have|had|already|actually|then|just)\s+)*(?:sent|texted|messaged|did|completed|maintained|kept|carried out)\b|\bi\s+(?:send|text|message)\b[^.!?]*\bevery day\b/i.test(o.quote);
   if(m.key==='followthrough'&&o.component!=='selection'&&o.evidenceType==='reported_action'&&/\b(?:guarantee|promise|swear)\b/i.test(o.quote)&&!reportedDone)throw fail('A promise or guarantee does not establish that a routine was actually carried out. Select explicit performed action or omit it.');
   observations.push(o);
  }catch(e){e.metric=m.key;e.component=o.component;throw e;}}
  for(const component of audit?.requiredComponents?.[m.key]||[])if(!observations.some(o=>o.component===component))throw fail('Original-source review confirms '+m.key+'.'+component+' is explicitly demonstrated or reported in this note. Re-read the complete original for that omitted component, quote the actual evidence and assess its limitations. Do not invent a successful outcome.');
  values[m.key]={quote,explanation,observations};
 }
 return values;
}
module.exports={rubric,normalize,hash,dateOf,ordered,buildSeries,componentEstimate,validateResult,pointsRound};
