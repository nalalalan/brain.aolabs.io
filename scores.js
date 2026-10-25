(() => {
  const base=window.BRAIN_API_BASE.replace(/\/$/,''), metrics=[{key:'voice',label:'Voice',cls:'autism'},{key:'followthrough',label:'Follow-through',cls:'adhd'},{key:'insight',label:'Insight',cls:'life'}];
  let entries={},impacts={},rubric=null,availability={available:false,message:'Checking scoring availability…'}; const busy=new Set(), errors=new Map(), previews=new Map();
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  function impactLabel(impact,cls=''){const n=node('span',window.BrainScoreImpact.compact(impact),'score-impact impact-'+(impact?.kind||'pending')+' '+cls);n.title=window.BrainScoreImpact.label(impact);return n;}
  function averageFor(item){return window.BrainScoreImpact.averageLabel(metrics.map(m=>item?assessment(item,m.key,false)?.value.score:null));}
  const dateOf=item=>Date.parse(item.sourceCreatedAt||item.createdAt||0);
  function observations(){const seen=new Set();return [...state].sort((a,b)=>dateOf(a)-dateOf(b)||a.id.localeCompare(b.id)).filter(item=>{const e=entries[item.id];if(!e||seen.has(e.sourceHash))return false;seen.add(e.sourceHash);return true;});}
  function before(a,b){return dateOf(a)<dateOf(b)||(dateOf(a)===dateOf(b)&&a.id.localeCompare(b.id)<=0);}
  function assessment(item,key,allowLater=true){
    const own=entries[item.id]?.values[key];if(Number.isFinite(own?.score))return {source:item,value:own,later:false,carried:false};
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
  function evidencePassage(source,quote){
    if(!quote)return '';const parts=[];for(const segment of String(source||'').slice(0,60000).split(/(?<=[.!?])\s+|\n+/)){let part='';for(const word of segment.replace(/\s+/g,' ').trim().split(' ')){if(part.length+word.length>550&&part){parts.push(part);part='';}part+=(part?' ':'')+word;}if(part)parts.push(part);}return parts.find(part=>part.includes(quote))||quote;
  }
  function refresh(){
    const rows=observations(),last=rows.at(-1),end=last?dateOf(last):0,ability=rubric?.kind==='ability-estimate';
    impacts=ability?window.BrainScoreImpact.index(state,entries):{};
    const latest=window.BrainScoreImpact.ordered(state.filter(item=>item.sourceText?.trim())).at(-1);
    if(ability)document.querySelector('.document-intro > p').textContent=rubric?.endpointEvidence?'0 = Holmes at Theranos · 100 = Moritz Bacher. Ability estimates from your messages and actions.':'100 = our Moritz Bacher benchmark. Ability estimates from your messages and actions.';
    const averageBadge=document.getElementById('score-average');if(averageBadge){averageBadge.replaceChildren(node('span','average'),node('strong',averageFor(last)));averageBadge.title='Equal average of the three displayed scores: Voice, Follow-through and Insight.';if(ability&&latest){const impact=impacts[latest.id]?.average;averageBadge.append(impactLabel(impact,'average-score-impact'));}}
    for(const m of metrics){const badge=document.getElementById('score-'+m.key);if(!badge)continue;const current=last?assessment(last,m.key,false):null;badge.replaceChildren(node('span',m.label.toLowerCase()),node('strong',current?current.value.score+'/100':'Awaiting assessment'));if(ability&&latest)badge.append(impactLabel(impacts[latest.id]?.[m.key],'latest-score-impact'));}
    const graph=document.getElementById('brain-progress-history');graph.replaceChildren();
    if(rows.length)graph.append(buildScoreHistoryPlot(rows));else graph.append(node('p','Your scores will appear after your notes are read.','score-history-empty'));
    const summary=document.getElementById('score-summary');summary.replaceChildren();
    const eligible=state.filter(item=>item.sourceText?.trim()),ready=eligible.filter(item=>entries[item.id]).length;
    if(eligible.length&&ready<eligible.length)summary.append(node('p',ready+' of '+eligible.length+' notes scored. The chart is incomplete.','score-basis'));
    if(last&&rubric?.method){const text=metrics.map(m=>{const a=assessment(last,m.key,false);if(!a)return '';const why=latest&&entries[latest.id]?window.BrainScoreImpact.reason(impacts[latest.id]?.[m.key],entries[latest.id].values[m.key],latest.id):'';return m.label+': '+secondPerson(why||a.value.explanation).split(/(?<=[.!?])\s+/)[0];}).filter(Boolean).join(' ');summary.append(node('p',text,'summary-main'));}
    else if(!last)summary.append(node('p','Save a note to see your scores and highlighted evidence.'));
    const guide=node('details',undefined,'score-guide');guide.append(node('summary','How scores work'));
    if(ability)guide.append(node('p','Metric changes use unrounded estimates. Average and its change use the three displayed whole-point scores; the average is shown to one decimal and its change to two. A metric can move slightly while the average holds, or cross a rounding boundary that moves the average. Comparisons follow note dates, not upload order. Average appears once all three scores are established.'),node('p','Explanations describe the main changing component and its evidence limits. Older evidence also changes weight over time. Positive and negative changes mean the estimate moved; they do not prove a change in your underlying ability. Repeated evidence adds no weight. A first estimate has no earlier baseline. Decimals show the calculation, not measurement precision.'));
    if(rubric?.method){guide.append(node('p',rubric.method));if(rubric.levels)for(const level of rubric.levels)guide.append(node('p',level.points+' — '+level.label+': '+level.criterion));if(rubric.sources)for(const source of rubric.sources){const a=node('a',source.title);a.href=source.url;a.target='_blank';a.rel='noopener';guide.append(a);}guide.append(node('p','The dashed line fits daily averages across the history, using only updated assessments with evidence for all four components. It describes this score series; it does not establish improvement on its own.'));guide.append(node('p','0 — '+rubric.zero),node('p','100 — '+rubric.hundred));for(const metric of rubric.metrics){guide.append(node('strong',metric.label));for(const c of metric.components)guide.append(node('p',c.label+': '+(c.criterion||c.hundred)));}}
    else guide.append(node('p','Some saved scores give more credit than their quoted evidence supports. Until those are recalculated, use the underlying notes to judge progress.'));
    summary.append(guide);
    if(typeof renderVault==='function')renderVault();
  }
  async function loadAvailability(){try{const response=await fetch(base+'/api/note-scores/status',{cache:'no-store'});if(!response.ok)throw Error();availability=await response.json();}catch{availability={available:false,message:'Scoring is unavailable. Your note is saved.'};}return availability;}
  async function load(){try{const [response]=await Promise.all([fetch(base+'/api/note-scores',{cache:'no-store'}),loadAvailability()]);if(!response.ok)throw Error('Scores could not load.');const data=await response.json();rubric=data.rubric;entries=Object.fromEntries(Object.entries(data.entries).filter(([,entry])=>metrics.every(m=>entry.values?.[m.key])));refresh();}catch(e){document.getElementById('score-summary').textContent=e.message;}}
  async function analyze(item){if(busy.has(item.id))return;refresh();await loadAvailability();if(!availability.available){renderVault();return;}if(busy.has(item.id))return;busy.add(item.id);errors.delete(item.id);renderVault();try{const r=await fetch(base+'/api/note-scores/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceId:item.id})});const result=await r.json();if(!r.ok){if(r.status===409||r.status===503)await loadAvailability();throw Error(result.error||'Could not score this note.');}entries[item.id]=result.entry;await load();}catch(e){errors.set(item.id,e.message);}finally{busy.delete(item.id);renderVault();}}
  window.BrainScores={
    refresh,analyze,
    score(item,key){return assessment(item,key,false)?.value.score??NaN;},
    observedScore(item,key){const value=entries[item.id]?.values[key];return value?.observed===false||(Number.isInteger(value?.coverage)&&value.coverage<4)?NaN:value?.score??NaN;},
    coverage(item,key){return entries[item.id]?.values[key]?.coverage;},
    preview(item){const entry=entries[item.id];if(!entry||!item.sourceText)return '';const key=entry.sourceHash+entry.createdAt;if(!previews.has(key))previews.set(key,createTextPreviewDataUrl(item.sourceText,item.sourceCreatedAt||item.createdAt,Object.fromEntries(metrics.map(m=>[m.key,evidencePassage(item.sourceText,entry.values[m.key].quote)]))));return previews.get(key);},
    append(main,item){const entry=entries[item.id];if(entry){const analysis=node('div',undefined,'score-analysis'),average=node('p','average '+averageFor(item),'score-average'),averageRow=node('div',undefined,'score-headline average-headline');average.title='Equal average of the three displayed scores. Unestablished scores are not treated as zero.';averageRow.append(average);const averageImpact=impacts[item.id]?.average;if(averageImpact)averageRow.append(impactLabel(averageImpact,'average-score-impact'));analysis.append(averageRow);for(const m of metrics){const assessed=assessment(item,m.key),value=entry.values[m.key];const section=node('section',undefined,'score-metric');const score=node('p',m.label.toLowerCase()+(assessed?.later?' reference':'')+' '+(assessed?assessed.value.score+'/100':'Awaiting first assessment'),m.cls+'-score');const explanation=node('p',undefined,m.cls+'-score-why score-excerpt');
      if(value.quote)explanation.append(node('mark','“'+value.quote+'”',m.key),' ');
      const impact=impacts[item.id]?.[m.key];
      const why=window.BrainScoreImpact.reason(impact,value,item.id);
      explanation.append(node('span',secondPerson(why||value.explanation),'score-change-reason'));
      if(assessed?.later)explanation.append(' First estimated '+shortDate(assessed.source)+'. This later reference is not a historical assessment of this note.');
      const headline=node('div',undefined,'score-headline');headline.append(score);if(impact)headline.append(impactLabel(impact));section.append(headline,explanation);analysis.append(section);
    }main.append(analysis);if(entry.analyzedChars<entry.sourceChars)main.append(node('p','Based on the first '+entry.analyzedChars.toLocaleString()+' characters.','vault-meta'));}
      else if(item.sourceText){const p=node('p',busy.has(item.id)?'Reading and scoring this note…':!availability.available?availability.message:errors.get(item.id)||'Not scored yet.','vault-meta');main.append(p);if(availability.available&&!busy.has(item.id)&&item.source==='sync')main.append(actionButton(errors.has(item.id)?'Retry scores':'Read and score',()=>analyze(item)));}
      if(item.sourceText?.length===20000&&item.analysisQualityVersion)main.append(node('p','Based on saved text; this older entry may continue in the original PDF.','vault-meta'));
    }
  };
  load();
})();
