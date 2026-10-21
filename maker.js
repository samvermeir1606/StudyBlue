'use strict';

/* =========================================================================
   Lesmaker — type cards as simple lines, get a lesson file to put on GitHub.
   ========================================================================= */

const DRAFT_KEY = 'studyblue.draft';
const MAKER_EMOJIS = ['📘', '🍂', '🌳', '🐾', '🔤', '✏️', '🧮', '🌍', '🔬', '🎨', '🎵', '⚽', '🏰', '⏰', '🇫🇷', '🇬🇧'];
const MAKER_COLORS = ['#1f7ae0', '#22b36b', '#fe9934', '#e0451f', '#8a5cf0', '#e83e8c', '#14a3b8', '#8a6a4a'];
const MAKER_LANGS = [['nl-BE', 'Nederlands (Vlaams)'], ['nl-NL', 'Nederlands (Nederland)'], ['fr-FR', 'Frans'], ['en-GB', 'Engels'], ['de-DE', 'Duits']];
const CARD_SEPARATORS = ['\t', ' = ', '=', ' - ', ' – ', ': ', ';'];

function slugify(name) {
  const s = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${s || 'les'}.json`;
}

const oneLine = t => String(t ?? '').replace(/\s*\n\s*/g, ' ').trim();
const textKeys = ['front', 'back', 'question', 'answer', 'term', 'definition', 'word', 'woord', 'hint', 'tip', 'sentence', 'zin', 'q', 'a', 'meaning', 'voorkant', 'achterkant', 'vraag', 'antwoord'];

// Extra fields (pictures, audio, wrong answers…) that the text box can't show are kept per card.
function cardExtras(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (!textKeys.includes(k)) out[k] = v;
  return out;
}

function emptyMakerState() {
  return { type: 'cards', project: '', name: '', description: '', icon: '📘', color: MAKER_COLORS[0], language: CONFIG.speechLang, text: '', file: '', editing: '', extras: {}, order: undefined };
}

function stateFromLesson(l) {
  const spelling = l.type === 'spelling';
  const extras = {};
  const lines = l.cards.map(c => {
    const key = spelling ? c.back : oneLine(c.front);
    const ex = cardExtras(c.raw);
    if (Object.keys(ex).length) extras[key] = ex;
    if (spelling) return c.sentence ? `${c.back} | ${oneLine(c.sentence)}` : c.back;
    return `${oneLine(c.front)} = ${oneLine(c.back)}${c.hint ? ` | ${oneLine(c.hint)}` : ''}`;
  });
  return {
    type: l.type, project: l.project, name: l.name, description: l.description, icon: l.icon,
    color: l.color || MAKER_COLORS[0], language: l.language, text: lines.join('\n'),
    file: l.file, editing: l.id, extras, order: l.order < 1e9 ? l.order : undefined,
  };
}

function parseCards(text, type) {
  const cards = [];
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    if (type === 'spelling') {
      const [word, sentence] = t.split(/\s*\|\s*/);
      if (!word) return problems.push({ line: i + 1, text: t, msg: 'geen woord' });
      cards.push({ word, sentence: sentence || '' });
      return;
    }
    const sep = CARD_SEPARATORS.find(s => t.includes(s));
    if (!sep) return problems.push({ line: i + 1, text: t, msg: 'geen = tussen voorkant en achterkant' });
    const at = t.indexOf(sep);
    const front = t.slice(0, at).trim();
    const [back, hint] = t.slice(at + sep.length).split(/\s*\|\s*/);
    if (!front || !back?.trim()) return problems.push({ line: i + 1, text: t, msg: front ? 'achterkant ontbreekt' : 'voorkant ontbreekt' });
    cards.push({ front, back: back.trim(), hint: hint?.trim() || '' });
  });
  return { cards, problems };
}

function buildLessonJson(st, cards) {
  const out = { project: st.project.trim() || 'Mijn lessen', name: st.name.trim() };
  if (st.description.trim()) out.description = st.description.trim();
  if (st.type === 'spelling') out.type = 'spelling';
  out.icon = st.icon || '📘';
  out.color = st.color;
  if (st.language && st.language !== CONFIG.speechLang) out.language = st.language;
  if (st.order !== undefined) out.order = st.order;
  out.cards = cards.map(c => {
    if (st.type === 'spelling') {
      const card = { word: c.word };
      if (c.sentence) card.sentence = c.sentence;
      return { ...card, ...st.extras[c.word] };
    }
    const card = { front: c.front, back: c.back };
    if (c.hint) card.hint = c.hint;
    return { ...card, ...st.extras[c.front] };
  });
  return out;
}

function renderMaker(editId) {
  let st;
  const editLesson = editId ? lessons.find(l => l.id === editId && !l.draft) : null;
  if (editLesson) st = stateFromLesson(editLesson);
  else {
    st = emptyMakerState();
    try { Object.assign(st, JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}, { editing: '' }); } catch { /* no draft */ }
  }
  const editing = !!editLesson;
  const repo = detectRepo();
  const branch = CONFIG.githubBranch || 'master';
  const projectNames = [...new Set(lessons.filter(l => !l.draft).map(l => l.project))];

  $app.innerHTML = `
    <button class="back-link" id="backBtn">← ${editing ? 'Terug naar de les' : 'Alle lessen'}</button>
    <section class="hero"><div>
      <h1>${editing ? '✏️ Les bewerken' : '✏️ Les maken'}</h1>
      <p>${editing ? `Je past <b>${esc(st.file)}</b> aan.` : 'Typ de kaarten, probeer ze uit en zet de les online.'}</p>
    </div></section>

    <section class="panel maker">
      <h3>1. Over de les</h3>
      <div class="mode-pick two">
        <button class="mode" data-type="cards"><span class="emoji">🃏</span><b>Kaarten</b><small>Een voorkant en een achterkant</small></button>
        <button class="mode" data-type="spelling"><span class="emoji">🔊</span><b>Spelling</b><small>Luisteren naar een woord en het typen</small></button>
      </div>
      <div class="form-grid">
        <label class="field"><span>Vak</span>
          <input id="fProject" list="projectList" placeholder="bv. Wero" value="${esc(st.project)}">
          <datalist id="projectList">${projectNames.map(p => `<option value="${esc(p)}">`).join('')}</datalist></label>
        <label class="field"><span>Naam van de les</span><input id="fName" placeholder="bv. Herfst" value="${esc(st.name)}"></label>
        <label class="field wide"><span>Korte uitleg <small>(mag leeg blijven)</small></span><input id="fDesc" placeholder="bv. Woordenschat" value="${esc(st.description)}"></label>
        <div class="field"><span>Icoon</span>
          <div class="pick-row">
            <input id="fIcon" class="icon-input" value="${esc(st.icon)}" maxlength="4" aria-label="Icoon">
            ${MAKER_EMOJIS.map(e => `<button class="pick" data-emoji="${e}" type="button">${e}</button>`).join('')}
          </div></div>
        <div class="field"><span>Kleur</span>
          <div class="pick-row">
            ${MAKER_COLORS.map(c => `<button class="swatch" data-color="${c}" style="background:${c}" type="button" aria-label="Kleur ${c}"></button>`).join('')}
            <input id="fColor" type="color" value="${esc(st.color)}" aria-label="Eigen kleur">
          </div></div>
        <label class="field"><span>Taal om voor te lezen</span>
          <select id="fLang">${MAKER_LANGS.map(([v, n]) => `<option value="${v}" ${v === st.language ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
    </section>

    <section class="panel maker">
      <h3>2. Kaarten</h3>
      <div class="maker-help" id="makerHelp"></div>
      <textarea id="fCards" rows="12" spellcheck="false" autocapitalize="off">${esc(st.text)}</textarea>
      <div class="maker-status" id="makerStatus"></div>
      <div class="maker-preview" id="makerPreview"></div>
    </section>

    <section class="panel maker">
      <h3>3. Klaar?</h3>
      <label class="field"><span>Bestandsnaam</span><input id="fFile" value="${esc(st.file)}" ${editing ? 'readonly' : ''} placeholder="wordt automatisch ingevuld"></label>
      <div class="maker-actions">
        <button class="btn green" id="tryBtn">▶ Uitproberen</button>
        <button class="btn secondary" id="copyBtn">📋 Kopieer tekst</button>
        <button class="btn secondary" id="downloadBtn">⬇️ Download</button>
        ${repo ? `<button class="btn" id="githubBtn">🐙 ${editing ? 'Aanpassen op GitHub' : 'Zet op GitHub'}</button>` : ''}
      </div>
      <p class="maker-error" id="makerError" role="alert"></p>
      ${repo ? `<ol class="steps">
        <li>Tik op <b>📋 Kopieer tekst</b>.</li>
        <li>Tik op <b>🐙 ${editing ? 'Aanpassen op GitHub' : 'Zet op GitHub'}</b> en meld je aan als dat gevraagd wordt.</li>
        <li>${editing ? 'Selecteer alle tekst in het grote vak en plak' : 'Plak'} de tekst in het grote vak.</li>
        <li>Tik op <b>Commit changes…</b> en daarna nog eens op <b>Commit changes</b>.</li>
        <li>Na ongeveer een minuut staat de les in StudyBlue. 🎉</li>
      </ol>` : ''}
      <details class="json-view"><summary>Bekijk het bestand</summary><pre id="jsonOut"></pre></details>
      ${editing ? '' : '<button class="link-btn danger" id="clearBtn">Alles wissen en opnieuw beginnen</button>'}
    </section>`;

  const $ = id => document.getElementById(id);
  const inputs = { project: $('fProject'), name: $('fName'), description: $('fDesc'), icon: $('fIcon'), color: $('fColor'), language: $('fLang'), text: $('fCards'), file: $('fFile') };
  let fileTouched = editing || (!!st.file && st.file !== slugify(st.name));
  let parsed = { cards: [], problems: [] };

  const help = {
    cards: `<p>Eén kaart per regel: <b>voorkant = achterkant</b>. Een tip toevoegen kan met <b>|</b> erachter.</p>
      <pre class="example">de eikel = de vrucht van de eik
het beukenblad = ovaal en glad blad | denk aan de beuk</pre>
      <p class="muted">Kopiëren uit Excel of Word (twee kolommen) werkt ook.</p>`,
    spelling: `<p>Eén woord per regel. Wil je ook een zinnetje laten voorlezen? Zet het achter een <b>|</b>.</p>
      <pre class="example">eikel | De eekhoorn eet een eikel.
kastanje
paddenstoel | In het bos groeit een paddenstoel.</pre>
      <p class="muted">Bij het typen mag je kind “de” of “het” weglaten of erbij typen.</p>`,
  };

  function update(save = true) {
    st.project = inputs.project.value;
    st.name = inputs.name.value;
    st.description = inputs.description.value;
    st.icon = inputs.icon.value.trim();
    st.color = inputs.color.value;
    st.language = inputs.language.value;
    st.text = inputs.text.value;
    if (!fileTouched) inputs.file.value = st.name.trim() ? slugify(st.name) : '';
    st.file = inputs.file.value.trim();

    document.querySelectorAll('[data-type]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.type === st.type)));
    document.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color.toLowerCase() === st.color.toLowerCase())));
    $('makerHelp').innerHTML = help[st.type];
    inputs.text.placeholder = st.type === 'spelling' ? 'eikel | De eekhoorn eet een eikel.' : 'de eikel = de vrucht van de eik';

    parsed = parseCards(st.text, st.type);
    const n = parsed.cards.length;
    $('makerStatus').innerHTML = `
      <span class="ok-count">✓ ${plural(n, st.type === 'spelling' ? 'woord' : 'kaart', st.type === 'spelling' ? 'woorden' : 'kaarten')}</span>
      ${parsed.problems.length ? `<div class="problems"><b>Deze regels begrijp ik niet:</b><ul>${parsed.problems.map(p => `<li>Regel ${p.line}: “${esc(p.text)}” — ${p.msg}</li>`).join('')}</ul></div>` : ''}`;
    $('makerPreview').innerHTML = n ? `
      <table><thead><tr>${st.type === 'spelling' ? '<th>Woord</th><th>Zin</th><th></th>' : '<th>Voorkant</th><th>Achterkant</th><th>Tip</th>'}</tr></thead>
      <tbody>${parsed.cards.slice(0, 100).map((c, i) => st.type === 'spelling'
        ? `<tr><td><b>${esc(c.word)}</b></td><td>${esc(c.sentence)}</td><td><button class="say-btn inline" data-preview="${i}" type="button" aria-label="Voorlezen">🔊</button></td></tr>`
        : `<tr><td><b>${esc(c.front)}</b></td><td>${esc(c.back)}</td><td class="muted">${esc(c.hint)}</td></tr>`).join('')}</tbody></table>` : '';
    $('makerPreview').querySelectorAll('[data-preview]').forEach(b => b.addEventListener('click', () => {
      speech.unlock();
      speech.speak(parsed.cards[+b.dataset.preview].word, st.language, 0.75);
    }));
    $('jsonOut').textContent = JSON.stringify(buildLessonJson(st, parsed.cards), null, 2);
    $('makerError').textContent = '';
    if (save && !editing) {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...st, extras: {} })); } catch { /* storage unavailable */ }
    }
  }

  function ready() {
    const problems = [];
    if (!st.name.trim()) problems.push('Geef de les een naam.');
    if (!parsed.cards.length) problems.push('Typ minstens één kaart.');
    if (!/^[\w.\- ]+\.json$/i.test(st.file)) problems.push('De bestandsnaam moet eindigen op .json en mag geen speciale tekens bevatten.');
    $('makerError').textContent = problems.join(' ');
    return !problems.length;
  }
  const jsonText = () => `${JSON.stringify(buildLessonJson(st, parsed.cards), null, 2)}\n`;

  Object.values(inputs).forEach(el => el.addEventListener('input', () => update()));
  inputs.file.addEventListener('input', () => { fileTouched = true; });
  document.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
    st.type = b.dataset.type;
    if (st.type === 'spelling' && (!st.icon || st.icon === '📘')) inputs.icon.value = '🔤';
    if (st.type === 'cards' && st.icon === '🔤') inputs.icon.value = '📘';
    update();
  }));
  document.querySelectorAll('[data-emoji]').forEach(b => b.addEventListener('click', () => { inputs.icon.value = b.dataset.emoji; update(); }));
  document.querySelectorAll('[data-color]').forEach(b => b.addEventListener('click', () => { inputs.color.value = b.dataset.color; update(); }));
  $('backBtn').addEventListener('click', () => navigate(editing ? `#/les/${encodeURIComponent(editLesson.id)}` : '#/'));

  $('tryBtn').addEventListener('click', () => {
    if (!ready()) return;
    const id = `draft:${st.file}`;
    const lesson = normalizeLesson(buildLessonJson(st, parsed.cards), id, st.file, new URL(`${CONFIG.lessonsFolder}/${st.file}`, location.href).href);
    lesson.draft = true;
    lessons = lessons.filter(l => l.id !== id).concat(lesson);
    toast('✏️ Concept klaar om te oefenen');
    navigate(`#/les/${encodeURIComponent(id)}`);
  });
  $('copyBtn').addEventListener('click', async () => {
    if (!ready()) return;
    try {
      await navigator.clipboard.writeText(jsonText());
      toast('📋 Gekopieerd!');
    } catch {
      $('makerError').textContent = 'Kopiëren lukte niet. Open “Bekijk het bestand” en kopieer de tekst zelf.';
      document.querySelector('.json-view').open = true;
    }
  });
  $('downloadBtn').addEventListener('click', () => { if (ready()) saveFile(st.file, jsonText()); });
  $('githubBtn')?.addEventListener('click', () => {
    if (!ready()) return;
    const folder = CONFIG.lessonsFolder;
    const url = editing
      ? `https://github.com/${repo}/edit/${branch}/${folder}/${st.file.split('/').map(encodeURIComponent).join('/')}`
      : `https://github.com/${repo}/new/${branch}/${folder}?filename=${encodeURIComponent(st.file)}`;
    window.open(url, '_blank', 'noopener');
  });
  $('clearBtn')?.addEventListener('click', () => {
    if (!confirm('Alles wissen en opnieuw beginnen?')) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ }
    renderMaker('');
  });

  update(false);
}
