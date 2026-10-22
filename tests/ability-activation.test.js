const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const factory=require('../ability-score-store');
test('unaccepted replacement preserves the old read path and cannot score on a page load or activate',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'brain-ability-test-'));
 try{
  let filesRead=0;
  const store=factory(root,async()=>{filesRead++;return [];});
  const noBody=()=>{throw Error('Unexpected request body read');};let status;
  assert.equal(await store.handle({method:'GET'},new URL('https://test/api/note-scores'),noBody,()=>{}),false);
  await store.handle({method:'GET'},new URL('https://test/api/note-scores/status'),noBody,(_,s)=>status=s);
  assert.equal(status.available,false);assert.equal(status.pending,0);assert.equal(filesRead,0);
  await assert.rejects(store.handle({method:'POST'},new URL('https://test/api/note-scores/analyze'),noBody,()=>{}),/being updated/);
  await assert.rejects(store.handle({method:'POST'},new URL('https://test/api/ability-scores/activate'),async()=>({}),()=>{}),/Every note/);
  await assert.rejects(fs.stat(path.join(root,'.brain-ability-active.json')),{code:'ENOENT'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
