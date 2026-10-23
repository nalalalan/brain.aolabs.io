const test=require('node:test'),assert=require('node:assert/strict');
const {repairExclusions}=require('../ability-score-store');
test('bounded correction cannot exclude evidence required by a source review',()=>{
 const error={metric:'followthrough',component:'accumulation',message:'Writing alone is not completed work.'};
 assert.deepEqual(repairExclusions(error,{requiredComponents:{followthrough:['accumulation']}}),[]);
 assert.equal(repairExclusions(error,{}).length,1);
 assert.deepEqual(repairExclusions({...error,preserveComponent:true},{}),[]);
});
