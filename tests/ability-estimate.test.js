const test=require('node:test'),assert=require('node:assert/strict');
const {estimateDays,pointsRound}=require('../ability-estimate');
const {componentEstimate,buildSeries,hash,rubric}=require('../ability-evidence');
const days=values=>values.map(points=>({points,weight:1,contraryPattern:points<=25}));
const near=(actual,expected)=>assert(Math.abs(actual-expected)<1e-10);
test('benchmark ability tolerates ordinary weaker days without requiring a perfect streak',()=>{
 const observations=days([100,100,100,100,100,100,100,50]);
 const result=estimateDays(observations);
 near(result.raw,100);assert.equal(pointsRound(result.raw),100);
 near(estimateDays(days([75,75,75,75,75,75,75,50])).raw,75);
});
test('isolated excellent days cannot inflate the typical pattern, while repeated weaker evidence counts',()=>{
 near(estimateDays(days([50,50,50,50,50,50,50,100])).raw,50);
 const lower=estimateDays(days([100,100,100,100,50,50,50,50]));
 near(lower.raw,75);
 assert(estimateDays(days([100,100,100,100,100,100,100,25])).raw<100,'A validated counterproductive pattern cannot be trimmed away');
 assert(estimateDays(days([100,100,100,100,100,100,100,0])).raw<100,'Knowing deception stays in the estimate');
});
test('small or missing evidence stays bounded and all original observations remain unchanged',()=>{
 assert.equal(estimateDays([]).raw,null);
 assert.equal(estimateDays(days([100,50])).raw,75);
 const input=days([50,75,90,100,50,75]),snapshot=JSON.stringify(input);estimateDays(input);
 assert.equal(JSON.stringify(input),snapshot);
});

test('a serious weakness cannot increase the estimate by changing the aggregation method',()=>{
 const before=days([50,50,50,50,50,50,50,100]);
 const after=days([25,50,50,50,50,50,50,100]);
 assert(estimateDays(after).raw<=estimateDays(before).raw+1e-10);
 for(const start of [50,75,90,100])for(const weaker of [0,25,50])if(weaker<start){
  const original=days([start,50,75,100,50,75,90,100]);const changed=days([weaker,50,75,100,50,75,90,100]);
  assert(estimateDays(changed).raw<=estimateDays(original).raw+1e-10);
 }
});
test('partial weight trimming is symmetric and follows evidence weight rather than note count',()=>{
 const input=[{points:50,weight:.5},{points:75,weight:1},{points:90,weight:.5},{points:100,weight:1},{points:75,weight:1}];
 const result=estimateDays(input),mirror=estimateDays(input.map(d=>({...d,points:100-d.points})));
 assert(Math.abs(result.raw+mirror.raw-100)<1e-10);
 assert(Math.abs(result.retainedWeight-2.4)<1e-10);
});
test('dated components keep recency, duplicate protection and weaker evidence without a perfection veto',()=>{
 const observations=Array.from({length:8},(_,i)=>{const date='2026-10-'+String(10+i).padStart(2,'0')+'T12:00:00Z';return {sourceId:'n'+i,quote:'Distinct original evidence '+i,date,time:Date.parse(date),level:i===7?'capable':'benchmark',certainty:'clear',evidenceType:'reported_action',reason:'Concrete supported ability evidence with an observed outcome.'};});
 const result=componentEstimate(observations);assert.equal(result.score,100);assert.equal(result.observations.length,8);
 assert.equal(result.observations.at(-1).points,50,'Weak evidence is retained, not erased');
 assert.equal(componentEstimate([...observations,{...observations.at(-1)}]).raw,result.raw);
});
test('all three overall abilities can reach the benchmark despite an imperfect note; missing components cannot',()=>{
 const files=Array.from({length:8},(_,i)=>({id:'n'+i,createdAt:'2026-10-'+String(10+i).padStart(2,'0')+'T12:00:00Z',sourceText:'Source evidence from project day '+i}));
 const records=Object.fromEntries(files.map((s,i)=>[s.id,{sourceHash:hash(s.sourceText),version:rubric.version,reviewed:true,createdAt:s.createdAt,values:Object.fromEntries(rubric.metrics.map(m=>[m.key,{quote:s.sourceText,explanation:'Accepted evidence and its limitation.',observations:m.components.map(c=>({component:c.key,quote:s.sourceText+' '+c.key,timeframe:'current',level:i===7?'capable':'benchmark',certainty:'clear',evidenceType:'reported_action',reason:'Observed contribution with supporting evidence.'}))}]))}]));
 const result=buildSeries(files,records);
 for(const key of ['voice','followthrough','insight'])assert.equal(result.entries.n7.values[key].score,100);
 for(const record of Object.values(records))record.values.voice.observations=record.values.voice.observations.filter(o=>o.component!=='agency');
 assert.equal(buildSeries(files,records).entries.n7.values.voice.score,99);
});
