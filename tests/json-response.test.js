const test=require('node:test'),assert=require('node:assert/strict'),{gunzipSync}=require('node:zlib'),encode=require('../json-response');
test('large score histories transfer losslessly to gzip clients and stay readable for other clients',()=>{
 const payload={entries:Array.from({length:1000},(_,i)=>({id:i,score:52,quote:'Your original words — retained exactly.',unknown:null}))};
 const compressed=encode(payload,'gzip, deflate, br');assert.equal(compressed.headers['Content-Encoding'],'gzip');assert.deepEqual(JSON.parse(gunzipSync(compressed.body)),payload);assert(compressed.body.length<JSON.stringify(payload).length/5);
 for(const accept of ['', 'br', 'gzip;q=0, br','gzip; q=0.0']){const plain=encode(payload,accept);assert(!plain.headers['Content-Encoding']);assert.deepEqual(JSON.parse(plain.body),payload);}
 assert.deepEqual(JSON.parse(encode({active:false},'gzip').body),{active:false});
});
