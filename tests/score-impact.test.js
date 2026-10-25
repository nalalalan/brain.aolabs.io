const test=require('node:test'),assert=require('node:assert/strict');
const impact=require('../score-impact');
const value=(raw,extra={})=>({score:Math.round(raw),coverage:4,components:{a:{raw}},observed:true,...extra});
test('rounded-equal estimates retain their signed increases and decreases',()=>{
  const a=value(60.18),b=value(60.09),c=value(60.21);
  assert.equal(a.score,b.score);assert.equal(a.score,c.score);
  assert.equal(impact.label(impact.compare(a,b)),'−0.09 points');
  assert.equal(impact.label(impact.compare(a,c)),'+0.03 points');
  assert.equal(impact.signed(.0001),'+<0.01');
  assert.equal(impact.signed(-.0001),'−<0.01');
});
test('first evidence and unknown components never invent a zero baseline or a later reference',()=>{
  assert.equal(impact.compare(null,value(60)).kind,'first');
  assert.equal(impact.compare(null,value(60)).delta,null);
  assert.equal(impact.estimate({score:null,components:{a:{raw:null}}}),null);
  assert.equal(impact.estimate(value(100,{coverage:1})),99);
  assert.equal(impact.estimate(value(100)),100);
  assert.equal(impact.estimate(value(60,{components:{a:{raw:60},b:{raw:null}}})),60);
});
test('unchanged distinguishes supporting, repeated, historical, absent and offsetting evidence',()=>{
  const old=value(60);
  assert.equal(impact.compare(old,value(60)).kind,'supports');
  assert.equal(impact.compare(old,value(60,{observed:false}),{duplicate:true}).kind,'repeated');
  assert.equal(impact.compare(old,value(60,{observed:false,observations:[{timeframe:'current'}]})).kind,'repeated');
  assert.equal(impact.compare(old,value(60,{observed:false,observations:[{timeframe:'historical'}]})).kind,'historical');
  assert.equal(impact.compare(old,value(60,{observed:false,observations:[]})).kind,'no-evidence');
  const mixed=impact.compare(value(60,{components:{a:{raw:50},b:{raw:70}}}),value(60,{components:{a:{raw:55},b:{raw:65}}}));
  assert.equal(mixed.kind,'mixed');assert.equal(mixed.delta,0);assert.deepEqual(mixed.changes.map(c=>c.delta),[5,-5]);
  const addedCoverage=impact.compare(value(60,{coverage:1}),value(60,{coverage:2,components:{a:{raw:60},b:{raw:60}}}));
  assert.equal(addedCoverage.kind,'supports','Newly established evidence at the same estimate is not offsetting evidence');
});
test('index follows original source dates and id tie-breaks, not upload order; versions do not mix',()=>{
  const files=[{id:'b',sourceCreatedAt:'2026-10-02',createdAt:'2026-10-01'},{id:'a',sourceCreatedAt:'2026-10-01',createdAt:'2026-10-03'},{id:'c',sourceCreatedAt:'2026-10-02'},{id:'d',sourceCreatedAt:'2026-10-03'}];
  const entries=Object.fromEntries(['a','b','c','d'].map((id,i)=>[id,{version:i===3?'new':'v16',sourceHash:id,values:{voice:value(60+i/10)}}]));
  const frozen=JSON.stringify({files,entries});const result=impact.index(files,entries);
  assert.equal(result.a.voice.kind,'first');assert.equal(result.b.voice.before,60);assert.equal(result.c.voice.before,60.1);
  assert.equal(result.d.voice.kind,'baseline-unavailable');assert.equal(result.d.voice.delta,null);
  assert.equal(JSON.stringify({files,entries}),frozen,'Rendering cannot mutate original sources or assessments');
});
test('unknown earlier notes and pending latest notes cannot borrow a later score or hide pending state',()=>{
  const files=[{id:'a',createdAt:'2026-10-01'},{id:'b',createdAt:'2026-10-02'},{id:'pending',createdAt:'2026-10-03'}];
  const result=impact.index(files,{a:{values:{voice:{score:null,components:{}}}},b:{values:{voice:value(60)}}});
  assert.equal(result.a.voice.kind,'unknown');assert.equal(result.b.voice.kind,'first');assert.equal(result.pending,undefined);
});

test('compact deltas and an equal displayed-score average retain unknown states',()=>{
  assert.equal(impact.compact(impact.compare(value(60.18),value(60.09))),'−0.09');
  assert.equal(impact.compact(impact.compare(value(60),value(60))),'0.00');
  assert.equal(impact.compact(impact.compare(null,value(60))),'new');
  assert.equal(impact.compact(null),'pending');
  assert.equal(impact.average([62,60,67]),63);
  assert.equal(impact.averageLabel([62,60,68]),'63.3/100');
  assert.equal(impact.averageLabel([62,60,67]),'63/100');
  assert.equal(impact.averageLabel([0,0,0]),'0/100');
  assert.equal(impact.averageLabel([62,null,67]),'—');
  assert.equal(impact.averageLabel([62,60]),'—');
});

test('average changes follow displayed scores without rounding the baseline or inventing unknown scores',()=>{
  const up=impact.compareAverage([61,60,67],[62,60,67]);
  assert.equal(impact.compact(up),'+0.33');assert.equal(impact.averageReason(up),'Voice rose.');
  const down=impact.compareAverage([62,60,67],[62,59,67]);
  assert.equal(impact.compact(down),'−0.33');assert.equal(impact.averageReason(down),'Follow-through fell.');
  assert.equal(impact.averageReason(impact.compareAverage([62,60,67],[63,59,67])),'Gains and drops balanced.');
  assert.equal(impact.averageReason(impact.compareAverage([62,60,67],[62,60,67])),'Whole-point scores held.');
  assert.equal(impact.compareAverage(null,[62,60,67]).delta,null);
  assert.equal(impact.compareAverage([62,60,67],[62,null,67]).kind,'unknown');
});

test('average history carries only earlier established scores and never crosses versions',()=>{
  const files=['a','b','c','d'].map((id,i)=>({id,createdAt:'2026-10-0'+(i+1)}));
  const entries={a:{version:'v16',values:{voice:value(60)}},b:{version:'v16',values:{followthrough:value(60),insight:value(60)}},c:{version:'v16',values:{voice:value(63)}},d:{version:'new',values:{voice:value(65),followthrough:value(65),insight:value(65)}}};
  const result=impact.index(files,entries);
  assert.equal(result.a.average.kind,'unknown');assert.equal(result.b.average.kind,'first');
  assert.equal(result.c.average.delta,1);assert.equal(result.d.average.kind,'baseline-unavailable');assert.equal(result.d.average.delta,null);
});

test('concise reasons use the dominant accepted observation, not an unrelated quote or invented improvement',()=>{
  const old=value(60),current=value(61,{observations:[{component:'a',timeframe:'current',level:'strong',reason:'You explain the competing priorities.'}],components:{a:{raw:61,observations:[{sourceId:'new',points:75,level:'strong'}]}}});
  assert.equal(impact.reason(impact.compare(old,current),current,'new'),'Up: you explain the competing priorities.');
  const lower=value(59,{observations:[{component:'a',timeframe:'current',level:'capable',reason:'You outline a choice but leave the next action undecided.'}],components:{a:{raw:59,observations:[{sourceId:'new',points:50,level:'capable'}]}}});
  assert.equal(impact.reason(impact.compare(old,lower),lower,'new'),'Down: you outline a choice but leave the next action undecided.');
  assert.equal(impact.reason(impact.compare(old,current),current,'unrelated'),'Up: the balance and age of your evidence changed.');
  current.observed=false;
  assert.equal(impact.reason(impact.compare(old,current),current,'new'),'Up: the balance and age of your evidence changed.');
});
