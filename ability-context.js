'use strict';
// A partial demonstration is not a demonstrated limitation of overall ability.
// Open-ended writing can support ability; it cannot contradict it just because
// the writer has not also chosen, negotiated, built or tested something.
const levels={struggling:0,developing:25,capable:50,strong:75,exceptional:90,benchmark:100};
const supportingWriting=o=>o.evidenceType==='direct_writing'&&levels[o.level]>=50;
const describeWriting=fact=>fact.trim().replace(/^You test\b/,'You examine').replace(/^You (?:build|construct) (an? (?:mechanism|prototype|system|device|structure))\b/,'You propose $1');
function unsupportedDifficulty(o){
 if(o.evidenceType!=='reported_difficulty')return false;
 const absence=/\b(?:uncertain|uncertainty|unsettled|unfinished|untested|unverified|not yet|no (?:test|result|execution|decision)|without (?:a |an )?(?:test|result|execution|decision)|do(?:es)? not (?:show|report|specify|choose|test|complete))\b/i.test(o.reason+' '+o.fact);
 const adverse=/\b(?:failed|failure|missed|broke|broken|harmful|ignored|dismissed|violated|ineffective|escalated|contradicted|fabricated|deceived|concealed|undisciplined)\b|\bnot having any discipline\b/i.test(o.fact+' '+o.quote);
 return absence&&!adverse;
}
function contextExplanation(observations){
 const current=observations.filter(o=>o.timeframe==='current');
 if(!current.length||!current.every(supportingWriting))return '';
 const facts=[...new Set(current.map(o=>describeWriting(o.fact)).filter(Boolean))].slice(0,2);
 // Keep genuine uncertainty about the interpretation, without borrowing
 // absent results or another component as evidence of a weakness.
 const uncertainty=current.map(o=>o.limit).find(s=>/\b(?:hypothesis|hypotheses|speculative|unverified interpretation|assumption|assumes|motives)\b/i.test(s));
 const text=[...facts,uncertainty].filter(Boolean).join(' ');
 return text.length<=460?text:facts[0];
}
const modelInstructions=`
ASSESS THE ACTIVITY ACTUALLY SHOWN. Brainstorming, asking research questions, comparing possibilities, revisiting constraints and leaving a choice open are normal parts of skilled work. An unfinished idea is not a failed task or a demonstrated limitation of overall ability. Rate the reasoning and expression actually present, without requiring a final decision, interpersonal negotiation, implementation or experiment in every note. In particular, voice.expression does not require negotiation or a settled design choice; insight.patterns and conceptual application do not require an experiment to demonstrate reasoning. A tentative design preference is not a bounded followthrough.selection unless a next action is actually chosen. Omit unobserved execution and outcomes rather than rating them as partial. Clear limitations in evidence limit what you can conclude, not the writer's ability. Keep actual observed mistakes, ignored constraints and reported difficulties distinct and rate them honestly. Use reported_difficulty for a specific demonstrated difficulty, not merely for uncertainty, questions, lack of motivation, missing detail or an unperformed test. Never invent adverse evidence. Do not automatically award higher anchors for brainstorming: explain the specific demonstrated thinking and its genuine uncertainty. Do not penalize one component for absence of a different component. In explanations describe the thought or action itself concisely in the second person; avoid repeatedly listing missing completion, testing or decisions as shortcomings of exploratory work.`;
module.exports={supportingWriting,unsupportedDifficulty,describeWriting,contextExplanation,modelInstructions};
