const test=require('node:test'),assert=require('node:assert/strict');
const {componentEstimate,buildSeries,validateResult,rubric,hash}=require('../ability-evidence');
const {schemaFor}=require('../ability-score-store');
const source={id:'a',createdAt:'2026-10-01T00:00:00Z',sourceText:'I chose the simpler design because it removes the coupled adjustment while preserving the intended motion.'};
const observation={component:'direction',evidenceType:'direct_writing',timeframe:'current',level:'strong',certainty:'clear',reason:'You identify a concrete competing constraint and justify the independent design choice.',quote:source.sourceText,fact:'You choose the simpler design for a specific functional reason.',limit:'This choice does not establish the finished system or its performance.'};
const makeRecord=(s,obs={})=>({sourceId:s.id,sourceHash:hash(s.sourceText),version:rubric.version,createdAt:s.createdAt,reviewed:true,values:Object.fromEntries(rubric.metrics.map(m=>[m.key,{quote:s.sourceText.slice(0,140),explanation:'You make a concrete design choice by separating the coupled adjustment from the motion you want to preserve. This reasoning identifies a useful tradeoff, while implementation and performance remain untested.',observations:obs[m.key]||[]}]))});
test('unknown components stay unknown and never become fabricated low ability',()=>{
 assert.equal(componentEstimate([]).score,null);
 const series=buildSeries([source],{a:makeRecord(source,{voice:[observation]})});
 assert.equal(series.entries.a.values.voice.score,75);
 assert.equal(series.entries.a.values.voice.coverage,1);
 assert.equal(series.entries.a.values.voice.confidence,'limited');
 assert.equal(series.entries.a.values.followthrough.score,null);
 assert.equal(series.entries.a.values.voice.components.expression.score,null);
});
test('actual contrary evidence lowers estimates; duplicate passages and status labels do not inflate them',()=>{
 const event=(o,n)=>({...o,sourceId:String(n),date:'2026-10-0'+n+'T00:00:00Z',time:Date.parse('2026-10-0'+n+'T00:00:00Z')});
 const good=event(observation,1),bad=event({...observation,quote:'I could not choose between the two options despite having the information.',level:'developing',evidenceType:'reported_difficulty'},2);
 assert(componentEstimate([good,bad]).score<75);
 assert.equal(componentEstimate([good,{...good,time:good.time+86400000}]).score,75);
 const x=buildSeries([source],{a:makeRecord(source,{voice:[observation]})});
 const y=buildSeries([{...source,title:'Lab director or unhoused writer'}],{a:makeRecord(source,{voice:[observation]})});
 assert.deepEqual(x,y);
});
test('future evidence and historical anecdotes cannot rewrite an earlier estimate',()=>{
 const later={...source,id:'b',createdAt:'2026-10-05T00:00:00Z',sourceText:'I explained the mechanism and compared both proposed ways of coupling the movement.'};
 const a=makeRecord(source,{voice:[observation]}),b=makeRecord(later,{voice:[{...observation,component:'expression',quote:later.sourceText,level:'exceptional'}]});
 assert.equal(buildSeries([source,later],{a,b}).entries.a.values.voice.score,75);
 const historical=makeRecord(source,{voice:[{...observation,timeframe:'historical'}]});
 assert.equal(buildSeries([source],{a:historical}).entries.a.values.voice.score,null);
});
test('written plans do not become completed results and100 retains independent verification',()=>{
 const record=makeRecord(source,{followthrough:[{...observation,component:'execution'}]});
 assert.throws(()=>validateResult(record,source),/Writing a request or plan/);
 const top=makeRecord(source,{voice:[{...observation,level:'benchmark'}]});
 assert.throws(()=>validateResult(top,source),/independently corroborated/);
 const schema=schemaFor([{sourceId:source.id,sourceHash:hash(source.sourceText),passages:{s1:source.sourceText}}]);
 for(const metric of Object.values(schema.properties.entries.items.anyOf[0].properties.values.properties))assert(!metric.properties.observations.items.properties.level.enum.includes('benchmark'));
});
test('clear direct reasoning can be credited without claiming physical implementation',()=>{
 const record=makeRecord(source,{insight:[{...observation,component:'application'}],voice:[observation]});
 assert.equal(validateResult(record,source).insight.observations[0].evidenceType,'direct_writing');
});
test('a guarantee is not a performed routine, while an explicit completed routine remains creditable',()=>{
 const planned={...source,sourceText:'Every single day without failure. I can swear on that.'};
 const r=makeRecord(planned,{followthrough:[{...observation,component:'execution',evidenceType:'reported_action',quote:planned.sourceText}]});
 assert.throws(()=>validateResult(r,planned),/promise or guarantee/);
 const done={...source,sourceText:'I sent one message every day this week. I kept the promise through the trip.'};
 const actual=makeRecord(done,{followthrough:[{...observation,component:'execution',evidenceType:'reported_action',quote:done.sourceText}]});
 assert.equal(validateResult(actual,done).followthrough.observations.length,1);
});
