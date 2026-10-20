(() => {
  const base=window.BRAIN_API_BASE.replace(/\/$/,''), metrics=[{key:'clarity',label:'Clarity',cls:'autism'},{key:'agency',label:'Agency',cls:'adhd'},{key:'fit',label:'Life fit',cls:'life'}];
  let entries={}; const busy=new Set(), errors=new Map(), previews=new Map();
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const dateOf=item=>Date.parse(item.sourceCreatedAt||item.createdAt||0);
  function observations(){const seen=new Set();return [...state].sort((a,b)=>dateOf(a)-dateOf(b)).filter(item=>{const e=entries[item.id];if(!e||seen.has(e.sourceHash))return false;seen.add(e.sourceHash);return true;});}
  function dailyValues(rows,key){const days=new Map();for(const r of rows){const value=entries[r.id]?.values[key]?.score;if(!Number.isFinite(value))continue;const day=new Date(dateOf(r)).toLocaleDateString('en-CA',{timeZone:'America/New_York'});days.set(day,[...(days.get(day)||[]),value]);}return [...days.values()].map(medianNumber);}
  function refresh(){
    const rows=observations(),end=Math.max(...rows.map(dateOf),0),recent=rows.filter(r=>dateOf(r)>end-28*86400000),previous=rows.filter(r=>dateOf(r)<=end-28*86400000&&dateOf(r)>end-56*86400000);
    for(const m of metrics){const badge=document.getElementById('score-'+m.key);if(!badge)continue;const values=dailyValues(recent,m.key),before=dailyValues(previous,m.key),score=values.length?Math.round(medianNumber(values)):null;let detail='recent 28 days of notes';if(values.length>=3&&before.length>=3){const delta=score-Math.round(medianNumber(before));detail+=(delta>0?' · +':' · ')+delta+' vs previous 28 days';}badge.replaceChildren(node('span',m.label.toLowerCase()),node('strong',score===null?'Not enough evidence':score+'/100'),node('em',detail));}
    const graph=document.getElementById('brain-progress-history');graph.replaceChildren();
    if(rows.length)graph.append(buildScoreHistoryPlot(rows));else graph.append(node('p','Scores will appear after the notes are read.','score-history-empty'));
    const summary=document.getElementById('score-summary');summary.replaceChildren();
    const latest=[...rows].reverse().find(r=>metrics.some(m=>Number.isFinite(entries[r.id].values[m.key].score)));
    if(latest){const p=node('p',metrics.map(m=>entries[latest.id].values[m.key]).filter(v=>Number.isFinite(v.score)).map(v=>v.explanation.split(/(?<=[.!?])\s+/)[0]).join(' '),'summary-main');summary.append(p);}
    else summary.append(node('p','Save a note to see its scores and highlighted evidence.'));
    summary.append(node('p','AI readings of each note. Trends reflect the notes recorded, not a clinical assessment.','score-basis'));
    if(typeof renderVault==='function')renderVault();
  }
  async function load(){try{const response=await fetch(base+'/api/note-scores',{cache:'no-store'});if(!response.ok)throw Error('Scores could not load.');entries=(await response.json()).entries;refresh();}catch(e){document.getElementById('score-summary').textContent=e.message;}}
  async function analyze(item){if(busy.has(item.id))return;busy.add(item.id);errors.delete(item.id);renderVault();try{const r=await fetch(base+'/api/note-scores/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceId:item.id})});const result=await r.json();if(!r.ok)throw Error(result.error||'Could not score this note.');entries[item.id]=result.entry;refresh();}catch(e){errors.set(item.id,e.message);}finally{busy.delete(item.id);renderVault();}}
  window.BrainScores={
    refresh,analyze,
    score(item,key){return entries[item.id]?.values[key]?.score??NaN;},
    preview(item){const entry=entries[item.id];if(!entry||!item.sourceText)return '';const key=entry.sourceHash+entry.createdAt;if(!previews.has(key))previews.set(key,createTextPreviewDataUrl(item.sourceText,item.sourceCreatedAt||item.createdAt,Object.fromEntries(metrics.map(m=>[m.key,entry.values[m.key].quote]))));return previews.get(key);},
    append(main,item){const entry=entries[item.id];if(entry){for(const m of metrics){const value=entry.values[m.key],score=node('p',m.label.toLowerCase()+' '+(value.score===null?'— not enough evidence':value.score+'/100'),m.cls+'-score');const explanation=node('p',undefined,m.cls+'-score-why score-excerpt');if(value.quote){const quote=node('mark','“'+value.quote+'”',m.key);explanation.append(quote,' ');}explanation.append(document.createTextNode(value.explanation));main.append(score,explanation);}if(entry.analyzedChars<entry.sourceChars)main.append(node('p','Based on the first '+entry.analyzedChars.toLocaleString()+' characters.','vault-meta'));}
      else if(item.sourceText){const p=node('p',busy.has(item.id)?'Reading and scoring this note…':errors.get(item.id)||'Not scored yet.','vault-meta');main.append(p);if(!busy.has(item.id))main.append(actionButton(errors.has(item.id)?'Retry scores':'Read and score',()=>analyze(item)));}
    }
  };
  load();
})();
