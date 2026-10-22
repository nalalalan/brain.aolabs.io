const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const createStore=require('../evidence-score-store');

test('inactive scoring exposes its pause without reading notes or making provider calls',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'brain-status-'));
  const store=createStore(root,()=>{throw Error('Status must not read source notes');});
  let result;
  const handled=await store.handle({method:'GET'},new URL('http://local/api/note-scores/status'),()=>{throw Error('No payload expected');},(status,data)=>{result={status,data};});
  assert.equal(handled,true);
  assert.equal(result.status,200);
  assert.equal(result.data.active,false);
  assert.equal(result.data.available,false);
  assert.equal(result.data.pending,0);
  assert.equal(result.data.message,'Scoring is paused. Your note is saved.');
  await assert.rejects(store.handle({method:'POST'},new URL('http://local/api/note-scores/analyze'),()=>{throw Error('Inactive scorer must not start work');},()=>{}),{status:409,message:'Scoring is paused. Your note is saved.'});
  await fs.rmdir(root);
});
