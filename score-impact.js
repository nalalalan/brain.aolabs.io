(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BrainScoreImpact=api;
})(typeof window==='object'?window:globalThis,function(){
  const keys=['voice','followthrough','insight'],epsilon=1e-9;
  const time=item=>Date.parse(item.sourceCreatedAt||item.createdAt||0);
  const ordered=files=>[...files].sort((a,b)=>time(a)-time(b)||a.id.localeCompare(b.id));
  function estimate(value){
    const known=Object.values(value?.components||{}).map(c=>c.raw).filter(Number.isFinite);
    if(!known.length||!Number.isFinite(value?.score))return null;
    const raw=known.reduce((sum,n)=>sum+n,0)/known.length;
    // Match the existing evidence gate; partial coverage cannot establish 100.
    return raw===100&&value.coverage<4?99:raw;
  }
  function signed(delta){
    if(Math.abs(delta)<epsilon)return '0.00';
    return (delta>0?'+':'−')+(Math.abs(delta)<.01?'<0.01':Math.abs(delta).toFixed(2));
  }
  function compare(previous,current,{duplicate=false}={}){
    const after=estimate(current),before=estimate(previous);
    if(after===null)return {kind:'unknown',before,after,delta:null,changes:[]};
    if(before===null)return {kind:'first',before,after,delta:null,changes:[]};
    const changes=Object.entries(current.components||{}).flatMap(([key,c])=>{
      const old=previous.components?.[key]?.raw;
      if(!Number.isFinite(c.raw))return [];
      if(!Number.isFinite(old))return [{key,before:null,after:c.raw,delta:null}];
      return Math.abs(c.raw-old)>epsilon?[{key,before:old,after:c.raw,delta:c.raw-old}]:[];
    });
    const delta=after-before;
    let kind=Math.abs(delta)>=epsilon?(delta>0?'up':'down'):
      changes.some(c=>c.delta!==null)?'mixed':current.observed?'supports':duplicate||current.observations?.some(o=>o.timeframe==='current')?'repeated':
      current.observations?.length&&current.observations.every(o=>o.timeframe==='historical')?'historical':'no-evidence';
    return {kind,before,after,delta:Math.abs(delta)<epsilon?0:delta,changes};
  }
  function index(files,entries){
    const result={},prior={},seen=new Set();
    for(const file of ordered(files)){
      const entry=entries[file.id];if(!entry)continue;
      const duplicate=Boolean(entry.sourceHash&&seen.has(entry.sourceHash));
      result[file.id]={};
      for(const key of keys){
        const value=entry.values?.[key];
        const previous=prior[key]&&prior[key].version===entry.version?prior[key].value:null;
        const impact=compare(previous,value,{duplicate});
        if(!previous&&prior[key]&&impact.kind==='first')impact.kind='baseline-unavailable';
        result[file.id][key]=impact;
        if(impact.after!==null)prior[key]={value,version:entry.version};
      }
      if(entry.sourceHash)seen.add(entry.sourceHash);
    }
    return result;
  }
  function label(impact){
    if(!impact)return 'Awaiting assessment';
    if(impact.kind==='up'||impact.kind==='down')return signed(impact.delta)+' points';
    return {first:'First estimate',unknown:'Not yet estimated',mixed:'No net change · mixed effects',supports:'No change · supports estimate',repeated:'No change · repeated evidence',historical:'No change · past experience only','no-evidence':'No change · no new evidence','baseline-unavailable':'Earlier comparison unavailable'}[impact.kind];
  }
  function compact(impact){
    if(!impact)return 'pending';
    if(Number.isFinite(impact.delta))return signed(impact.delta);
    return impact.kind==='first'?'new':'—';
  }
  function average(scores){
    return scores.length===3&&scores.every(Number.isFinite)?scores.reduce((sum,n)=>sum+n,0)/3:null;
  }
  function averageLabel(scores){const result=average(scores);return result===null?'—':Number(result.toFixed(1))+'/100';}
  return {estimate,signed,ordered,compare,index,label,compact,average,averageLabel};
});
