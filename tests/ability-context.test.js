const test=require('node:test'),assert=require('node:assert/strict');
const {buildSeries,rubric,hash}=require('../ability-evidence');
const {contextExplanation,unsupportedDifficulty,describeWriting,modelInstructions}=require('../ability-context');
const impact=require('../score-impact');
const keys=rubric.metrics.map(m=>m.key);
function fixture(specs){
 const files=specs.map((s,i)=>({id:'context-'+i,createdAt:s.date||new Date(Date.UTC(2026,9,1+i)).toISOString(),sourceText:'Original evidence '+i}));
 const records=Object.fromEntries(files.map((f,i)=>[f.id,{sourceId:f.id,sourceHash:hash(f.sourceText),version:rubric.version,reviewed:true,createdAt:f.createdAt,values:Object.fromEntries(rubric.metrics.map(m=>[m.key,{quote:f.sourceText,explanation:'You explain a design possibility while the outcome is still open.',observations:m.components.filter(c=>!specs[i].only||specs[i].only.includes(c.key)).map(c=>({component:c.key,evidenceType:specs[i].type||'direct_writing',level:specs[i].level||'capable',timeframe:'current',certainty:'clear',quote:(specs[i].duplicate?'Original evidence 0':f.sourceText)+' '+c.key,fact:'You compare two structural options and identify the pressure constraint.',limit:'This is a hypothesis; its feasibility is untested.',reason:'You identify a possibility without having completed a prototype yet.'}))}]))}]));
 return {files,records,series:buildSeries(files,records)};
}
test('unfinished brainstorming cannot lower established ability, even repeatedly or after a long gap',()=>{
 const {files,series}=fixture([{level:'strong'},...Array.from({length:10},()=>({level:'capable'})),{level:'capable',date:'2026-12-20T12:00:00Z'}]);
 for(const f of files)for(const k of keys)assert.equal(series.entries[f.id].values[k].score,75);
 const last=series.entries[files.at(-1).id];for(const k of keys){assert(last.values[k].evidenceUse.every(o=>o.use==='context-only'));assert(last.values[k].observations.length>0);}
});
test('brainstorming can add supported skill evidence without earning completed work or a bonus for every note',()=>{
 const {files,series}=fixture([{level:'capable'},{level:'strong'},{level:'strong',duplicate:true}]);
 for(const k of keys){assert(series.entries[files[1].id].values[k].score>50);assert.equal(series.entries[files[2].id].values[k].score,series.entries[files[1].id].values[k].score);}
 assert(modelInstructions.includes('Omit unobserved execution and outcomes'));
});
test('actual reported difficulty and counterproductive reasoning can lower scores in the same estimator',()=>{
 for(const spec of [{level:'capable',type:'reported_difficulty'},{level:'developing',type:'direct_writing'}]){
  const {files,series}=fixture([{level:'strong'},spec]);for(const k of keys)assert(series.entries[files[1].id].values[k].score<75);
 }
});
test('partial coverage and same-day exploratory updates cannot create a hidden penalty',()=>{
 const {files,series}=fixture([{level:'strong',only:['direction']},{level:'capable',date:'2026-10-01T01:00:00Z'}]);
 assert.equal(series.entries[files[1].id].values.voice.score,75);
 assert.equal(series.entries[files[1].id].values.voice.components.expression.raw,null);
 const sameDay=fixture([{level:'strong'},{level:'capable',date:'2026-10-01T01:00:00Z'}]);
 for(const k of keys)assert.equal(sameDay.series.entries[sameDay.files[1].id].values[k].score,75);
});
test('a previously context-only passage cannot be recycled after a setback to inflate recovery',()=>{
 const {files,records}=fixture([{level:'strong'},{level:'capable'},{level:'developing',type:'reported_difficulty'},{level:'capable'}]);
 for(const k of keys)records[files[3].id].values[k].observations=structuredClone(records[files[1].id].values[k].observations);
 const result=buildSeries(files,records);for(const k of keys)assert.equal(result.entries[files[3].id].values[k].score,result.entries[files[2].id].values[k].score);
});
test('exploratory explanations describe accepted facts and uncertainty without cross-component penalties',()=>{
 const o={evidenceType:'direct_writing',level:'capable',timeframe:'current',fact:'You connect adjustable geometry with stable shape retention.',limit:'This is a hypothesis, not a checked mechanism.',reason:'You have not negotiated with anyone or built a working prototype.'};
 const text=contextExplanation([o]);assert(text.includes(o.fact)&&text.includes(o.limit));assert(!text.includes('negotiated'));
 assert.equal(impact.reason({kind:'supports'},{contextExplanation:text},'a'),text);
 assert.equal(contextExplanation([{...o,evidenceType:'reported_difficulty'}]),'');
 assert.equal(describeWriting('You build a mechanism linking geometry to expansion.'),'You propose a mechanism linking geometry to expansion.');
 assert.equal(describeWriting('You test the idea against the pressure constraint.'),'You examine the idea against the pressure constraint.');
});
test('context changes cannot rewrite earlier estimates with future evidence',()=>{
 const {files,records,series}=fixture([{level:'capable'},{level:'strong'}]);assert.deepEqual(series.entries[files[0].id],buildSeries(files.slice(0,1),records).entries[files[0].id]);
});

test('uncertainty cannot bypass the context rule by being mislabeled as a reported difficulty',()=>{
 const o={evidenceType:'reported_difficulty',reason:'You do not specify a test or a settled decision.',fact:'You are uncertain about which mechanism to investigate.',quote:'Could this geometry hold the expanded state? I want to explore both options.'};
 assert(unsupportedDifficulty(o));
 assert(!unsupportedDifficulty({...o,fact:'You ignored measured instability and repeated the failed setup.',quote:'I ignored the failed measurements and repeated the same setup.'}));
 assert(!unsupportedDifficulty({...o,reason:'You report an obstacle in disciplined practice, but the note does not show duration or outcomes.',fact:'You describe undisciplined practice.',quote:'I keep practicing without any discipline.'}));
});
