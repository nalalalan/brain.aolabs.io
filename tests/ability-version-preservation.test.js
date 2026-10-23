const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('V16 candidate leaves the accepted V15 reader and persistent files intact',async()=>{
 const legacy=require('../ability-v15-score-store'),current=require('../ability-score-store');
 assert.equal(legacy.analysisHash,'56d1a66504ece7578119c24d083be2c22998a6cf932be66f546a63d43ca2eb96');
 assert.notEqual(current.analysisHash,legacy.analysisHash);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'brain-version-test-'));
 try{
  const pointer=JSON.stringify({version:'20261022-ability-benchmark-v15'}),cache=JSON.stringify({records:{}});
  await fs.writeFile(path.join(root,'.brain-ability-active.json'),pointer);
  await fs.writeFile(path.join(root,'.brain-ability-evidence-v15.json'),cache);
  const req={method:'GET'},url=new URL('http://localhost/api/note-scores'),readJson=async()=>({});let sent;
  assert.equal(await current(root,async()=>[]).handle(req,url,readJson,(status,data)=>{sent=data}),false);
  assert.equal(await legacy(root,async()=>[]).handle(req,url,readJson,(status,data)=>{assert.equal(status,200);sent=data}),true);
  assert.equal(sent.version,'20261022-ability-benchmark-v15');
  assert.equal(await fs.readFile(path.join(root,'.brain-ability-active.json'),'utf8'),pointer);
  assert.equal(await fs.readFile(path.join(root,'.brain-ability-evidence-v15.json'),'utf8'),cache);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
