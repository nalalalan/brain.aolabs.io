const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const factory=require('../ability-score-store'),{rubric,hash}=require('../ability-evidence');
test('accepted legacy evidence is reused under the context rule without a paid rescore',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'brain-context-'));
 const source={id:'legacy-context',createdAt:'2026-10-01T12:00:00Z',sourceText:'I am considering a geometry change that could hold its shape without a continuous pressure source.'};
 const record={sourceId:source.id,sourceHash:hash(source.sourceText),version:rubric.version,analysisHash:'1b609b0cf6c01c832ce5e203b7f6ff9ab770203a3c2aa013bf75616c24d55b6f',reviewed:true,createdAt:source.createdAt,values:Object.fromEntries(rubric.metrics.map(m=>[m.key,{quote:source.sourceText,explanation:'You describe a possible geometry change and explain the pressure constraint it would address. This is an exploratory design idea whose feasibility remains open.',observations:[]}]))};
 const originalFetch=global.fetch;let calls=0;
 try{
  await fs.writeFile(path.join(root,'.brain-ability-evidence-v16.json'),JSON.stringify({records:{[source.id]:record}}));
  await fs.writeFile(path.join(root,'.brain-ability-v16-active.json'),JSON.stringify({version:rubric.version}));
  global.fetch=async()=>{calls++;throw Error('Unexpected paid call');};
  const store=factory(root,async()=>[source]);let result;
  await store.handle({method:'GET'},new URL('https://test/api/ability-scores/candidates'),async()=>({}),(_,body)=>result=body);
  assert.equal(result.ready,1);assert.equal(result.missing.length,0);
  await store.handle({method:'POST'},new URL('https://test/api/note-scores/analyze'),async()=>({sourceId:source.id}),(_,body)=>result=body);
  assert(result.entry);assert.equal(calls,0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'.brain-ability-evidence-v16.json'))).records[source.id],record);
 }finally{global.fetch=originalFetch;assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});}
});
