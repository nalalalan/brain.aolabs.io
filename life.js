(() => {
  const base = window.BRAIN_API_BASE.replace(/\/$/, '');
  const root = document.getElementById('life-progress');
  let data, selectedWeek, editing = null, loading = false;
  const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(value || new Date());
  const monday = value => { const d = new Date(value + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); };
  const shift = (value, n) => { const d = new Date(value + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const label = value => new Date(value + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  selectedWeek = monday(day());
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const button = (text, action, cls) => { const b = el('button', text, cls); b.type = 'button'; b.addEventListener('click', action); return b; };
  const message = text => { document.getElementById('life-message').textContent = text; };
  async function request(path = '', payload) {
    const response = await fetch(base + '/api/life' + path, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, revision: data?.revision }) } : { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) { if (response.status === 409) await load(); throw new Error(result.error || 'Could not save. Please try again.'); }
    data = result;
    render();
    return result;
  }
  async function load() {
    try { await request(); }
    catch (e) { root.replaceChildren(el('p', 'Progress history could not load. Your notes are still available below.'), button('Retry', load)); message(e.message); }
  }
  function field(form, name, title, type = 'text', value = '') {
    const wrap = el('label', title);
    const input = el(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.name = name; input.value = value; input.required = !['before', 'note', 'quote'].includes(name);
    if (type === 'date') input.max = day();
    if (type === 'textarea') { input.rows = 3; input.maxLength = name === 'quote' ? 1600 : 800; }
    if (type === 'text') input.maxLength = 180;
    wrap.append(input); form.append(wrap); return input;
  }
  function select(form, name, title, choices, value) {
    const wrap = el('label', title), input = el('select'); input.name = name; input.required = true;
    input.append(new Option('Choose…', ''));
    for (const choice of choices) input.append(new Option(choice, choice));
    input.value = value || ''; wrap.append(input); form.append(wrap); return input;
  }
  const dialog = document.getElementById('life-editor');
  function showStep(step = {}, suggestion = false) {
    editing = { ...step };
    dialog.replaceChildren();
    const form = el('form');
    form.append(el('h2', suggestion ? 'Keep this step?' : step.id ? 'Edit step' : 'Record a meaningful step'));
    field(form, 'title', 'What moved forward?', 'text', step.title);
    field(form, 'date', 'When did it happen?', 'date', step.date || day());
    select(form, 'area', 'Area', ['Research & career', 'Money', 'Daily life', 'Connection', 'Enjoyment'], step.area);
    field(form, 'evidence', 'What actually changed?', 'textarea', step.evidence);
    field(form, 'before', 'Before (optional)', 'textarea', step.before);
    if (step.sourceId) {
      field(form, 'quote', 'Exact evidence from your note', 'textarea', step.quote).required = true;
      const link = el('a', 'Read original note'); link.href = base + '/api/files/' + encodeURIComponent(step.sourceId) + '/view'; link.target = '_blank'; link.rel = 'noopener'; form.append(link);
      form.append(el('p', 'Check the date: a note may describe an earlier event.', 'life-muted'));
    }
    const status = el('p', '', 'form-status'); status.setAttribute('role', 'status'); form.append(status);
    const actions = el('div', undefined, 'life-actions');
    const save = el('button', 'Save step', 'primary'); save.type = 'submit';
    actions.append(save, button('Cancel', () => dialog.close())); form.append(actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true; status.textContent = 'Saving…';
      try {
        await request('/steps', { ...Object.fromEntries(new FormData(form)), sourceId: step.sourceId || '', id: suggestion ? undefined : step.id, suggestionId: suggestion ? step.id : undefined });
        dialog.close(); message('Step saved.');
      } catch (e) { status.textContent = e.message; } finally { save.disabled = false; }
    });
    dialog.append(form); dialog.showModal();
  }
  function showCheckin() {
    dialog.replaceChildren();
    const existing = data.checkins.find(c => c.week === selectedWeek) || {};
    const form = el('form'); form.append(el('h2', 'Week of ' + label(selectedWeek)), el('p', 'Compared with your previous week. Your own experience; no AI rating.', 'life-muted'));
    select(form, 'ease', 'Daily life felt…', ['Easier', 'About the same', 'Harder'], existing.ease);
    select(form, 'enjoyment', 'I had… enjoyment', ['More', 'About the same', 'Less'], existing.enjoyment);
    field(form, 'note', 'Anything you want to remember (optional)', 'textarea', existing.note);
    const status = el('p', '', 'form-status'); status.setAttribute('role', 'status'); form.append(status);
    const actions = el('div', undefined, 'life-actions'), save = el('button', 'Save check-in', 'primary'); save.type = 'submit';
    actions.append(save, button('Cancel', () => dialog.close()));
    if (existing.week) actions.append(button('Remove check-in', async () => {
      try { await request('/remove', { collection: 'checkins', id: existing.week }); dialog.close(); message('Check-in removed.'); } catch (e) { status.textContent = e.message; }
    }));
    form.append(actions); form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true;
      try { await request('/checkins', { ...Object.fromEntries(new FormData(form)), week: selectedWeek }); dialog.close(); message('Weekly check-in saved.'); }
      catch (e) { status.textContent = e.message; } finally { save.disabled = false; }
    }); dialog.append(form); dialog.showModal();
  }
  function stepRow(step, candidate = false) {
    const row = el('article', undefined, 'life-step');
    row.append(el('p', `${label(step.date)} · ${step.area} · ${candidate ? 'Suggested; not counted' : step.basis}`, 'life-muted'), el('h3', step.title));
    if (step.before) { row.append(el('p', 'Then: ' + step.before, 'life-before')); row.append(el('p', 'Now: ' + step.evidence)); }
    else row.append(el('p', step.evidence));
    const actions = el('div', undefined, 'life-actions');
    if (step.sourceId) {
      const source = el('a', 'Original note'); source.href = base + '/api/files/' + encodeURIComponent(step.sourceId) + '/view'; source.target = '_blank'; source.rel = 'noopener'; actions.append(source);
    }
    actions.append(button(candidate ? 'Review & keep' : 'Edit', () => showStep(step, candidate)));
    const remove = button(candidate ? 'Dismiss' : 'Remove', async () => {
      if (!candidate && !confirm('Remove this progress step? The original note stays saved.')) return;
      remove.disabled = true;
      try { await request('/remove', { collection: candidate ? 'suggestions' : 'steps', id: step.id }); message(candidate ? 'Suggestion dismissed.' : 'Step removed. Original note preserved.'); }
      catch (e) { message(e.message); remove.disabled = false; }
    }); actions.append(remove); row.append(actions); return row;
  }
  function render() {
    root.replaceChildren();
    const header = el('div', undefined, 'life-heading'); header.append(el('h1', 'Life progress'), button('Record a step', () => showStep(), 'primary')); root.append(header);
    const nav = el('div', undefined, 'life-week');
    const prev = button('←', () => { selectedWeek = shift(selectedWeek, -7); render(); }); prev.setAttribute('aria-label', 'Previous week');
    const next = button('→', () => { selectedWeek = shift(selectedWeek, 7); render(); }); next.setAttribute('aria-label', 'Next week'); next.disabled = selectedWeek >= monday(day());
    nav.append(prev, el('span', `Week of ${label(selectedWeek)}`), next);
    if (selectedWeek !== monday(day())) nav.append(button('This week', () => { selectedWeek = monday(day()); render(); })); root.append(nav);
    const weekSteps = data.steps.filter(s => s.date >= selectedWeek && s.date < shift(selectedWeek, 7));
    const checkin = data.checkins.find(c => c.week === selectedWeek);
    const metrics = el('div', undefined, 'life-metrics');
    for (const [name, value, detail] of [
      ['Meaningful steps', String(weekSteps.length), weekSteps.length ? 'Recorded this week' : 'None recorded this week. Not a judgment of the week.'],
      ['Daily ease', checkin?.ease || 'Not recorded', 'Compared with the previous week'],
      ['Enjoyment', checkin?.enjoyment || 'Not recorded', 'Compared with the previous week']]) {
      const metric = el('div', undefined, 'life-metric'); metric.append(el('h2', name), el('strong', value), el('p', detail, 'life-muted')); metrics.append(metric);
    }
    root.append(metrics, button(checkin ? 'Edit weekly check-in' : 'Weekly check-in', showCheckin));
    if (checkin?.note) root.append(el('p', checkin.note, 'checkin-note'));
    const weekList = el('div', undefined, 'week-steps');
    for (const step of weekSteps.sort((a, b) => b.date.localeCompare(a.date))) weekList.append(stepRow(step)); root.append(weekList);
    if (data.suggestions.length) {
      const pending = el('details', undefined, 'life-details'); pending.append(el('summary', `${data.suggestions.length} possible step${data.suggestions.length === 1 ? '' : 's'} to review`));
      for (const s of data.suggestions) pending.append(stepRow(s, true)); root.append(pending);
    }
    const history = el('section', undefined, 'life-history'); history.append(el('h2', 'Then → now'));
    const earlier = data.steps.filter(s => !weekSteps.includes(s)).sort((a,b) => b.date.localeCompare(a.date));
    if (!data.steps.length) history.append(el('p', 'Your changes will stay here, even through difficult weeks. Record a step or find one in a saved note.', 'life-muted'));
    const show = earlier.slice(0, 3); for (const s of show) history.append(stepRow(s));
    if (earlier.length > 3) { const more = el('details', undefined, 'life-details'); more.append(el('summary', `View ${earlier.length - 3} earlier steps`)); for (const s of earlier.slice(3)) more.append(stepRow(s)); history.append(more); }
    const past = data.checkins.filter(c => c.week !== selectedWeek).sort((a,b) => b.week.localeCompare(a.week));
    if (past.length) {
      const details = el('details', undefined, 'life-details'); details.append(el('summary', 'Past weekly check-ins'));
      for (const c of past) { const p = el('p', `${label(c.week)} · Daily ease: ${c.ease} · Enjoyment: ${c.enjoyment}${c.note ? ' — ' + c.note : ''}`); p.append(' ', button('Open week', () => { selectedWeek = c.week; render(); })); details.append(p); } history.append(details);
    }
    if (earlier.length || !data.steps.length || past.length) root.append(history);
  }
  window.BrainLife = {
    recordFromNote(item) { showStep({ sourceId: item.source === 'sync' ? item.id : '', date: day(new Date(item.sourceCreatedAt || item.createdAt)), quote: '', evidence: '' }); },
    async suggest(item) {
      if (loading) { message('Still reading the previous note.'); return; }
      loading = true; message('Looking for a completed step in this note…');
      document.getElementById('life-message').scrollIntoView({ behavior: 'smooth', block: 'center' });
      try { const before = data?.suggestions.length || 0; await request('/suggest', { sourceId: item.id }); message(data.suggestions.length > before ? 'Possible steps are ready to review above. They are not counted yet.' : 'No new supported steps found. The note stays valuable as a note.'); }
      catch (e) { message(e.message); } finally { loading = false; }
    }
  };
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  load();
})();
