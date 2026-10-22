const test=require('node:test'),assert=require('node:assert/strict');
const {componentEstimate,buildSeries,validateResult,rubric,hash}=require('../ability-evidence');
const {schemaFor}=require('../ability-score-store');
const {resolveItem}=require('../ability-score-store');
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

test('technical diagnosis is allowed without allowing clinical diagnosis in an ability explanation',()=>{
 const r=makeRecord(source);r.values.insight.explanation='You diagnose a concrete layout problem by comparing the cropping across pressure panels and preserving a common scale. This identifies the visible defect, while the actual correction and its rendered result remain unverified.';
 assert.doesNotThrow(()=>validateResult(r,source));
 r.values.insight.explanation='You diagnose a mental disorder from the way the message is written and connect that claim to the problem. This explanation describes a clinical conclusion rather than the specific design reasoning available in the note.';
 assert.throws(()=>validateResult(r,source),/clinical diagnosis/);
});

test('exploratory uncertainty cannot be the sole reason for a low rating, while actual failure remains rateable',()=>{
 const exploratory={...observation,level:'developing',reason:'You describe a possible direction, but the choice remains tentative and lacks a final decision.'};
 assert.throws(()=>validateResult(makeRecord(source,{voice:[exploratory]}),source),/low rating needs a demonstrated weakness/);
 for(const reason of ['You identify a real preference, but the final choice remains unresolved.','You name a plausible next action, but you present it tentatively without committing.','You compare your preference with another context, but no actual negotiated difference appears.']){
  assert.throws(()=>validateResult(makeRecord(source,{voice:[{...exploratory,reason}]}),source),/low rating needs a demonstrated weakness/);
 }
 const difficult={...source,sourceText:'I ignored the agreed constraint and chose an incompatible design, so the assembly failed.'};
 const actual={...observation,quote:difficult.sourceText,level:'developing',evidenceType:'reported_difficulty',reason:'You report an actual incompatible choice that failed to respect the agreed assembly constraint.'};
 assert.doesNotThrow(()=>validateResult(makeRecord(difficult,{voice:[actual]}),difficult));
});

test('separated or reversed passage IDs retain the entire original context rather than fabricate a stitched quote',()=>{
 const s={...source,sourceText:'I planned to test it. The fixture was not ready. I only sketched the design.'};
 const item={sourceId:s.id,values:Object.fromEntries(rubric.metrics.map(m=>[m.key,{quoteId:'s1',explanation:makeRecord(s).values[m.key].explanation,observations:m.key==='voice'?[{...observation,quoteIds:['s3','s1']}]:[]}]))};
 const resolved=resolveItem(item,s);assert.equal(resolved.values.voice.observations[0].quote,s.sourceText);assert.doesNotThrow(()=>validateResult(resolved,s));
 const long={...s,sourceText:'I planned to test it. '+('The intervening setup was unavailable. '.repeat(50))+'I only sketched the design.'};
 item.values.voice.observations[0].quoteIds=['s1','s52'];assert.throws(()=>resolveItem(item,long),/quotation span is too long/);
});
