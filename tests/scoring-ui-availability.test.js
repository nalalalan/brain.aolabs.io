const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('paused cards and save callbacks cannot offer or submit futile score retries',async()=>{
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.textContent='';}
    append(...items){this.children.push(...items);}
    replaceChildren(...items){this.children=items;}
  }
  const elements=new Map(),writes=[];
  let available=false;
  const context={window:{BRAIN_API_BASE:'https://brain.test'},state:[],renderVault:()=>{},
    document:{createElement:tag=>new Element(tag),getElementById:id=>{if(!elements.has(id))elements.set(id,new Element('div'));return elements.get(id);}},
    actionButton:label=>Object.assign(new Element('button'),{textContent:label}),
    fetch:async(url,options={})=>{
      if(options.method==='POST'){writes.push(url);return {ok:false,status:502,json:async()=>({error:'Temporary scoring failure'})};}
      return {ok:true,json:async()=>url.endsWith('/status')?{available,message:available?'':'Scoring is paused. Your note is saved.'}:{entries:{},rubric:null}};
    }};
  vm.runInNewContext(fs.readFileSync(require.resolve('../scores.js'),'utf8'),context);
  await new Promise(setImmediate);
  const item={id:'saved-note',source:'sync',sourceText:'My original saved note.'};
  const paused=new Element('main');context.window.BrainScores.append(paused,item);
  assert.equal(paused.children[0].textContent,'Scoring is paused. Your note is saved.');
  assert.equal(paused.children.filter(n=>n.tag==='button').length,0);
  await context.window.BrainScores.analyze(item);
  assert.deepEqual(writes,[],'A save callback must not submit scoring while unavailable');
  available=true;
  await context.window.BrainScores.analyze(item);
  assert.equal(writes.length,1);
  const failed=new Element('main');context.window.BrainScores.append(failed,item);
  assert.equal(failed.children.find(n=>n.tag==='button').textContent,'Retry scores','A transient failure may offer retry when scoring is available');
});
