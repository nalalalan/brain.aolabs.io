'use strict';

// Estimate the typical pattern, not a perfect streak or the best observed day.
// Symmetric trimming cannot make one unusually strong day establish ability.
const version='20261027-overall-ability-v17';
function estimateDays(days){
 const weight=days.reduce((sum,d)=>sum+d.weight,0);
 if(!weight)return {raw:null,retainedWeight:0,retainedPoints:0,method:'unknown'};
 const fullPoints=days.reduce((sum,d)=>sum+d.points*d.weight,0);
 if(days.length<5)return {raw:fullPoints/weight,retainedWeight:weight,retainedPoints:fullPoints,method:'all-evidence'};
 const sorted=days.map(d=>({...d,retained:d.weight})).sort((a,b)=>a.points-b.points);
 for(const direction of [sorted,[...sorted].reverse()]){
  let remaining=weight*.2;
  for(const day of direction){const removed=Math.min(day.retained,remaining);day.retained-=removed;remaining-=removed;if(remaining<=1e-12)break;}
 }
 const retainedWeight=sorted.reduce((sum,d)=>sum+d.retained,0),retainedPoints=sorted.reduce((sum,d)=>sum+d.points*d.retained,0);
 // Serious contrary evidence must not disappear in a tail. Use the lower of
 // the typical estimate and the full mean, so admitting weaker evidence can
 // never increase the score merely by switching aggregation methods.
 if(days.some(d=>d.contraryPattern)&&fullPoints/weight<retainedPoints/retainedWeight)return {raw:fullPoints/weight,retainedWeight:weight,retainedPoints:fullPoints,method:'all-evidence'};
 return {raw:Math.max(0,Math.min(100,retainedPoints/retainedWeight)),retainedWeight,retainedPoints,method:'typical-evidence'};
}
const pointsRound=n=>Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n))):null;
module.exports={version,estimateDays,pointsRound};
