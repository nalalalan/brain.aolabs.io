const assert=require('node:assert/strict');
const {componentEstimate,buildSeries,rubric,hash,validateResult,verifiedScope,pointsRound}=require('../behavior-evidence');
const event=(outcome,i,quote='event '+i)=>({outcome,quote,level:'everyday',scopeReason:'A concrete ordinary personal action with an observed result.',time:Date.parse('2026-06-01')+i*86400000,sourceId:String(i),date:new Date(Date.parse('2026-06-01')+i*86400000).toISOString()});
assert.equal(componentEstimate([]).score,0);
assert.equal(componentEstimate([event('demonstrated',0)]).score,20);
assert.equal(componentEstimate([event('difficulty',0)]).score,0);
assert.equal(componentEstimate([event('mixed',0)]).score,10);
const positive=Array.from({length:8},(_,i)=>event('demonstrated',i));
assert.equal(componentEstimate(positive).score,20,'Repeated everyday success must never become research leadership.');
assert.equal(componentEstimate(Array.from({length:500},(_,i)=>event('demonstrated',i))).score,20);
assert.equal(componentEstimate([{...event('demonstrated',0),level:'research'}]).score,60);
assert.equal(componentEstimate([{...event('demonstrated',0),level:'director'}]).score,100);
assert.equal(pointsRound(99.999),99,'Rounding must never create a director-level 100.');
assert.equal(pointsRound(100),100);
assert.equal(componentEstimate([{...event('demonstrated',0),level:'research'},event('demonstrated',1)]).score,60,'A routine success does not erase a harder demonstrated result.');
const granular=componentEstimate([{...event('demonstrated',0),level:'applied'},event('difficulty',1),{...event('demonstrated',2),level:'applied'}]).score;assert(granular>20&&granular<40&&granular%20!==0,'Weighted evidence can produce intermediate whole-number scores.');
assert(componentEstimate([...positive,event('difficulty',8)]).score<componentEstimate(positive).score);
assert.equal(componentEstimate([event('demonstrated',0),event('demonstrated',0)]).weight,1);
assert.equal(componentEstimate([event('demonstrated',0,'one'),event('demonstrated',0,'two')]).weight,1);
const neutral=()=>Object.fromEntries(rubric.metrics.map(m=>[m.key,{quote:'You write about a real situation today.',explanation:'You describe what matters to you in a concrete situation, but the note does not report how you acted on it. That distinction limits what this example establishes about your behavior.',observations:[]} ]));
const sources=[0,1,2].map(i=>({id:String(i),createdAt:new Date(Date.parse('2026-06-01')+i*86400000).toISOString(),sourceText:'You write about a real situation today. '+i}));
const records=Object.fromEntries(sources.map(s=>[s.id,{sourceId:s.id,sourceHash:hash(s.sourceText),version:rubric.version,reviewed:true,values:neutral()}]));
records['0'].values.voice.observations.push({component:'expression',timeframe:'current',outcome:'demonstrated',level:'everyday',scopeReason:'You directly communicated a concrete need in an ordinary relationship.',quote:'I told her clearly what I needed.',fact:'You report making a direct request.',limit:'The response is not described.'});
records['1'].values.voice.observations.push({...records['0'].values.voice.observations[0]});
const series=buildSeries(sources,records);
assert.equal(series.entries['0'].values.voice.score,5,'One report cannot create a near-maximum whole-metric score.');
assert.equal(series.entries['1'].values.voice.score,series.entries['0'].values.voice.score,'Retelling identical evidence earns no points.');
assert.equal(series.entries['1'].values.voice.observed,false);
assert.equal(series.entries['2'].values.voice.score,series.entries['0'].values.voice.score,'Silence is not a setback.');
const earlier=buildSeries(sources.slice(0,1),records);
assert.deepEqual(earlier.entries['0'].values,series.entries['0'].values,'Future notes do not affect the past.');
function rejection(quote,key,component){const source={id:'q',sourceText:quote},values=neutral();for(const v of Object.values(values))v.quote=quote;values[key].observations=[{component,outcome:'demonstrated',timeframe:'current',level:'everyday',scopeReason:'A concrete personal action is reported in an ordinary situation.',quote,fact:'You report a result from your actions.',limit:'This is only one reported occasion.'}];assert.throws(()=>validateResult({sourceId:'q',values},source));}
rejection('i would like a dial that changes the amount of compression.','insight','application');
rejection('i guess remembering that i can leave helps my anxiety.','insight','application');
rejection('i hope my thoughts help move the project along.','followthrough','accumulation');
rejection('i hope my feedback helps.','followthrough','accumulation');
rejection('If I responded with reassurance, it would help briefly but might exhaust me later.','insight','patterns');
rejection('keep searching.','followthrough','recovery');
rejection('Sending a message each day is something I can guarantee without failure.','followthrough','execution');
rejection('Sending a message each day is something I can guarantee without failure.','voice','agency');
rejection('After that setback, I will try a different plan next week.','followthrough','recovery');
rejection('Tomorrow I am going to send her this message.','voice','expression');
rejection('I will tell him what I need next week.','voice','agency');
for(const quote of ['I told her I will send the draft tomorrow.','The other day I told my stand partner I would like a quieter rehearsal.']){
 const values=neutral();for(const v of Object.values(values))v.quote=quote;
 values.voice.observations=[{component:'expression',outcome:'demonstrated',timeframe:'current',level:'everyday',scopeReason:'You actually communicated a concrete preference to another person.',quote,fact:'You report what you told another person.',limit:'The later action is not reported as completed.'}];
 assert.doesNotThrow(()=>validateResult({sourceId:'delivered',values},{id:'delivered',sourceText:quote}),'Reported speech can contain a future plan without making delivery hypothetical.');
}
rejection("now i've done it, and i probably won't do it again because it seems like it will result in a conflict.",'followthrough','recovery');
const {resolveItem}=require('../evidence-score-store');
const {sourceExclusions}=require('../evidence-score-store');
const auditedSource={id:'audited',sourceText:'A draft message with no delivery report.'};
const auditedRecords={audited:{sourceHash:hash(auditedSource.sourceText),sourceAudit:{removedComponents:{voice:['expression']},reason:'Delivery unconfirmed.'}}};
assert.equal(sourceExclusions([auditedSource],auditedRecords)[0].component,'expression','A source audit survives reassessment of unchanged text.');
assert.deepEqual(sourceExclusions([{...auditedSource,sourceText:'I sent the message and received a reply.'}],auditedRecords),[],'Changed source evidence receives a fresh assessment.');
const passageSource={id:'passages',sourceText:'I printed the parts and assembled the device.\nIt produced the dome when I turned the dial. I want faster travel next.'};
const passageCandidate={sourceId:'passages',values:Object.fromEntries(rubric.metrics.map(m=>[m.key,{quoteId:'s1',explanation:neutral()[m.key].explanation,observations:[]}]))};
passageCandidate.values.followthrough.observations=[{component:'execution',outcome:'demonstrated',timeframe:'current',quoteIds:['s1','s2'],fact:'You report assembling and testing the physical device yourself.',limit:'The requested speed improvement is not reported as completed.'}];
assert.equal(resolveItem(passageCandidate,passageSource).values.followthrough.observations[0].quote,'I printed the parts and assembled the device. It produced the dome when I turned the dial.');
passageCandidate.values.followthrough.observations[0].quoteIds=['s1','s3'];assert.throws(()=>resolveItem(passageCandidate,passageSource),'Nonadjacent excerpts cannot become a fabricated contiguous quote.');
passageCandidate.values.followthrough.observations[0].quoteIds=['s999'];assert.throws(()=>resolveItem(passageCandidate,passageSource),'Invented passage IDs are rejected.');
/* Previous behavior exclusions remain required under the director benchmark. */
console.log('PASS: transparent arithmetic, continuous aggregates, setbacks, daily caps, duplicate and future invariance, neutral uncertainty, known invalid evidence exclusions.');


const source={id:'leader',createdAt:'2026-10-21T00:00:00Z',sourceText:'I led the research program across two projects and delivered systems independently adopted by the research team.'};
const values=neutral();for(const v of Object.values(values))v.quote='I led the research program across two projects';
values.followthrough.observations=[{component:'accumulation',outcome:'demonstrated',timeframe:'current',level:'director',scopeReason:'Two original research projects produced validated systems independently used by another team.',quote:source.sourceText,fact:'You report leading projects with adopted research systems.',limit:'The claim needs independent verification of your contribution and outcomes.'}];
assert.throws(()=>validateResult({sourceId:source.id,values},source),/independently inspected/,'Self-described leadership cannot unlock100.');
const approved={sourceId:source.id,sourceHash:hash(source.sourceText),metric:'followthrough',component:'accumulation',level:'director',status:'verified',personalContribution:'Evidence identifies project leadership and contribution.',observedOutcome:'Systems independently adopted.',references:['verified-project-one','verified-project-two'],evidenceDate:'2026-10-20T00:00:00Z',projectCount:2,peopleCount:3,sustainedDays:120,researchDirection:'Original research direction tested across projects.',externalUse:'Independent researchers use both systems.'};
assert(verifiedScope(source,'followthrough','accumulation','director',[approved]));
assert.equal(validateResult({sourceId:source.id,values},source,[approved]).followthrough.observations[0].level,'director');
for(const change of [{sourceHash:'wrong'},{sourceId:'other'},{projectCount:1},{references:['one']},{sustainedDays:2},{peopleCount:1},{externalUse:''},{evidenceDate:'2026-10-22T00:00:00Z'}])assert(!verifiedScope(source,'followthrough','accumulation','director',[{...approved,...change}]),'Incomplete or future verification cannot unlock100.');
console.log('PASS: ordinary successes stay ordinary; substantial research differs;100 requires source-bound sustained independent leadership proof; no rounding to100.');

const {schemaFor}=require('../evidence-score-store');
const ordinarySchema=schemaFor([{sourceId:'unverified',sourceHash:'unknown',passages:{s1:'An impressive claim.'}}]);
for(const v of Object.values(ordinarySchema.properties.entries.items.anyOf[0].properties.values.properties))assert.deepEqual(v.properties.observations.items.properties.level.enum,['everyday','applied','research'],'Model output cannot even select professional/director without independent approval.');
const typingAudit=require('../source-evidence-exclusions.json').records.find(a=>a.sourceId==='b7c7254b-ec01-4e97-8d23-9f340a1e6163');
const typingSchema=schemaFor([{sourceId:typingAudit.sourceId,sourceHash:typingAudit.sourceHash,passages:{s1:'A claimed ability with no identified completed outcome.'}}],Object.entries(typingAudit.removedComponents).flatMap(([metric,components])=>components.map(component=>({sourceId:typingAudit.sourceId,metric,component}))));
for(const value of Object.values(typingSchema.properties.entries.items.anyOf[0].properties.values.properties))assert.equal(value.properties.observations.maxItems,0,'A rejected self-claim must not reappear as an accomplished outcome.');

assert.equal(componentEstimate(Array.from({length:6},(_,i)=>({...event('demonstrated',i),level:'director'}))).score,100,'Floating point arithmetic must preserve an exactly satisfied director benchmark.');
assert(componentEstimate([...Array.from({length:6},(_,i)=>({...event('demonstrated',i),level:'director'})),{...event('mixed',6),level:'director'}]).score<100,'A partial outcome must not round into100.');
