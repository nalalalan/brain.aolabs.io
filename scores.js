(() => {
  const base=window.BRAIN_API_BASE.replace(/\/$/,''), metrics=[{key:'voice',label:'Voice',cls:'autism'},{key:'followthrough',label:'Follow-through',cls:'adhd'},{key:'support',label:'Support',cls:'life'}];
  let entries={}; const busy=new Set(), errors=new Map(), previews=new Map();
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const dateOf=item=>Date.parse(item.sourceCreatedAt||item.createdAt||0);
  function observations(){const seen=new Set();return [...state].sort((a,b)=>dateOf(a)-dateOf(b)||a.id.localeCompare(b.id)).filter(item=>{const e=entries[item.id];if(!e||seen.has(e.sourceHash))return false;seen.add(e.sourceHash);return true;});}
  function before(a,b){return dateOf(a)<dateOf(b)||(dateOf(a)===dateOf(b)&&a.id.localeCompare(b.id)<=0);}
  function assessment(item,key,allowLater=true){
    const rows=observations(),prior=rows.filter(r=>before(r,item));
    const source=[...prior].reverse().find(r=>Number.isFinite(entries[r.id]?.values[key]?.score))||(allowLater?rows.find(r=>Number.isFinite(entries[r.id]?.values[key]?.score)):null);
    return source?{source,value:entries[source.id].values[key],later:!before(source,item),carried:source.id!==item.id}:null;
  }
  function secondPerson(text){
    // Current assessments are already addressed to you. Preserve references to other people.
    if(/\b(you|your)\b/i.test(String(text||'')))return String(text||'');
    const verbs={is:'are',was:'were',has:'have',does:'do',acknowledges:'acknowledge',adapts:'adapt',adjusts:'adjust',anticipates:'anticipate',articulates:'articulate',asks:'ask',challenges:'challenge',chooses:'choose',claims:'claim',completes:'complete',continues:'continue',contrasts:'contrast',critiques:'critique',defines:'define',describes:'describe',discusses:'discuss',distinguishes:'distinguish',expects:'expect',explains:'explain',expresses:'express',feels:'feel',frames:'frame',gives:'give',identifies:'identify',imagines:'imagine',initiates:'initiate',keeps:'keep',lays:'lay',makes:'make',mentions:'mention',moves:'move',names:'name',narrows:'narrow',needs:'need',notices:'notice',plans:'plan',prefers:'prefer',processes:'process',proposes:'propose',questions:'question',recognizes:'recognize',references:'reference',refines:'refine',reflects:'reflect',reframes:'reframe',reinterprets:'reinterpret',remains:'remain',repeats:'repeat',reports:'report',requests:'request',revises:'revise',says:'say',sees:'see',shows:'show',sits:'sit',specifies:'specify',states:'state',suggests:'suggest',talks:'talk',theorizes:'theorize',thinks:'think',turns:'turn',types:'type',voices:'voice',wants:'want',worries:'worry'};
    return String(text||'').replace(/\bHe\b/g,'You').replace(/\bhe\b/g,'you').replace(/\bHis\b/g,'Your').replace(/\bhis\b/g,'your').replace(/\bhimself\b/g,'yourself').replace(/\bhim\b/g,'you').replace(/\b(you(?:\s+(?:actually|again|already|briefly|clearly|directly|explicitly|honestly|not|only|openly|personally|still|successfully))*)\s+(\w+)/gi,(all,subject,verb)=>subject+' '+(verbs[verb.toLowerCase()]||verb));
  }
  function shortDate(item){return new Date(dateOf(item)).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'America/New_York'});}
  function refresh(){
    const rows=observations(),last=rows.at(-1),end=last?dateOf(last):0;
    for(const m of metrics){const badge=document.getElementById('score-'+m.key);if(!badge)continue;const current=last?assessment(last,m.key,false):null;const old=[...rows].reverse().find(r=>dateOf(r)<=end-28*86400000&&Number.isFinite(entries[r.id]?.values[m.key]?.score));let detail='latest estimate';if(current&&old){const delta=current.value.score-entries[old.id].values[m.key].score;detail+=' · '+(delta>0?'+':'')+delta+' vs 4 weeks ago';}badge.replaceChildren(node('span',m.label.toLowerCase()),node('strong',current?current.value.score+'/100':'Awaiting assessment'),node('em',detail));}
    const graph=document.getElementById('brain-progress-history');graph.replaceChildren();
    if(rows.length)graph.append(buildScoreHistoryPlot(rows));else graph.append(node('p','Your scores will appear after your notes are read.','score-history-empty'));
    const summary=document.getElementById('score-summary');summary.replaceChildren();
    if(last){const text=metrics.map(m=>assessment(last,m.key,false)).filter(Boolean).map(a=>secondPerson(a.value.explanation).split(/(?<=[.!?])\s+/)[0]).join(' ');summary.append(node('p',text,'summary-main'));}
    else summary.append(node('p','Save a note to see your scores and highlighted evidence.'));
    summary.append(node('p','Estimates from your recent notes. Scores can rise, fall, or stay steady; earlier achievements remain part of the context.','score-basis'));
    if(typeof renderVault==='function')renderVault();
  }
  async function load(){try{const response=await fetch(base+'/api/note-scores',{cache:'no-store'});if(!response.ok)throw Error('Scores could not load.');entries=Object.fromEntries(Object.entries((await response.json()).entries).filter(([,entry])=>metrics.every(m=>entry.values?.[m.key])));refresh();}catch(e){document.getElementById('score-summary').textContent=e.message;}}
  async function analyze(item){if(busy.has(item.id))return;busy.add(item.id);errors.delete(item.id);renderVault();try{const r=await fetch(base+'/api/note-scores/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceId:item.id})});const result=await r.json();if(!r.ok)throw Error(result.error||'Could not score this note.');entries[item.id]=result.entry;refresh();}catch(e){errors.set(item.id,e.message);}finally{busy.delete(item.id);renderVault();}}
  window.BrainScores={
    refresh,analyze,
    score(item,key){return assessment(item,key,false)?.value.score??NaN;},
    preview(item){const entry=entries[item.id];if(!entry||!item.sourceText)return '';const key=entry.sourceHash+entry.createdAt;if(!previews.has(key))previews.set(key,createTextPreviewDataUrl(item.sourceText,item.sourceCreatedAt||item.createdAt,Object.fromEntries(metrics.map(m=>[m.key,entry.values[m.key].quote]))));return previews.get(key);},
    append(main,item){const entry=entries[item.id];if(entry){for(const m of metrics){const assessed=assessment(item,m.key),value=assessed?.value;const score=node('p',m.label.toLowerCase()+' '+(value?value.score+'/100':'Awaiting first assessment'),m.cls+'-score');const explanation=node('p',undefined,m.cls+'-score-why score-excerpt');
      if(assessed?.carried)explanation.append(node('span',(assessed.later?'First assessed ':'From your ')+shortDate(assessed.source)+' note: '));
      if(value?.quote)explanation.append(node('mark','“'+value.quote+'”',m.key),' ');
      const copy=!assessed?'Your score will appear after the first relevant assessment.':assessed.later?'Your first available estimate is from this later note; it is not a rating of this earlier entry.':assessed.carried?'Your latest '+m.label.toLowerCase()+' estimate remains '+value.score+'/100, based on that note.':secondPerson(value.explanation);
      explanation.append(document.createTextNode(copy));main.append(score,explanation);
      const reference=assessed?.carried?assessed.source.id:value?.comparisonSourceId;
      if(reference){const link=node('a',assessed?.carried?'Score source':'Earlier comparison','vault-meta');link.href=base+'/api/files/'+encodeURIComponent(reference)+'/view';link.target='_blank';link.rel='noopener';main.append(link);}
    }if(entry.analyzedChars<entry.sourceChars)main.append(node('p','Based on the first '+entry.analyzedChars.toLocaleString()+' characters.','vault-meta'));}
      else if(item.sourceText){const p=node('p',busy.has(item.id)?'Reading and scoring this note…':errors.get(item.id)||'Not scored yet.','vault-meta');main.append(p);if(!busy.has(item.id)&&item.source==='sync')main.append(actionButton(errors.has(item.id)?'Retry scores':'Read and score',()=>analyze(item)));}
      if(item.sourceText?.length===20000&&item.analysisQualityVersion)main.append(node('p','Based on saved text; this older entry may continue in the original PDF.','vault-meta'));
    }
  };
  load();
})();
