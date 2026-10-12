'use strict';

/* =========================================================================
   StudyBlue — flashcards from JSON files
   -------------------------------------------------------------------------
   Lessons live in the `lessons/` folder as .json files. The site finds them
   through `lessons/index.json` (generated automatically by the GitHub Action
   or by `node tools/build-index.mjs`). When that file is missing and the
   site runs on <user>.github.io, it asks the GitHub API for the folder list.
   ========================================================================= */

const CONFIG = {
  studentName: '',          // e.g. 'Emma' → "Hi Emma!" on the home screen
  lessonsFolder: 'lessons',
  githubRepo: '',           // 'owner/repo' — only needed on a custom domain without index.json
  githubBranch: '',         // leave empty for the default branch
};

const STORE_KEY = 'studyblue.v1';
const $app = document.getElementById('app');

let lessons = [];
let loadErrors = [];
let session = null;
let keyHandler = null;
let homeQuery = '';

/* ---------------------------------------------------------------- helpers */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pickRandom = arr => arr[Math.floor(Math.random() * arr.length)];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const dayString = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function starsFor(pct) {
  if (pct >= 90) return 3;
  if (pct >= 70) return 2;
  if (pct >= 40) return 1;
  return 0;
}

function starsHtml(n, total = 3) {
  let s = '';
  for (let i = 0; i < total; i++) s += `<span class="${i < n ? '' : 'off'}">⭐</span>`;
  return s;
}

/* ---------------------------------------------------------------- storage */

function defaultStore() {
  return { lessons: {}, xp: 0, streak: { count: 0, day: '' }, sound: true, prefs: { mode: 'cards', shuffle: true, reverse: false } };
}

const store = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && typeof saved === 'object') {
      const base = defaultStore();
      return { ...base, ...saved, prefs: { ...base.prefs, ...saved.prefs } };
    }
  } catch { /* storage unavailable */ }
  return defaultStore();
})();

function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* storage unavailable */ }
}

function statsFor(key, create = false) {
  if (!store.lessons[key] && create) store.lessons[key] = { best: 0, plays: 0, history: [], cards: {} };
  return store.lessons[key] || { best: 0, plays: 0, history: [], cards: {} };
}

function cardStat(card) {
  return statsFor(card.lessonId).cards[card.key];
}

function mastery(lesson) {
  const cards = statsFor(lesson.id).cards;
  const known = lesson.cards.filter(c => cards[c.key]?.last === 1).length;
  return known / lesson.cards.length;
}

function currentStreak() {
  const { count, day } = store.streak;
  const yesterday = dayString(new Date(Date.now() - 864e5));
  return day === dayString() || day === yesterday ? count : 0;
}

function bumpStreak() {
  const today = dayString();
  if (store.streak.day === today) return;
  store.streak = { count: currentStreak() + 1, day: today };
}

function updateTopbar() {
  document.getElementById('streakCount').textContent = currentStreak();
  document.getElementById('xpCount').textContent = store.xp;
  document.getElementById('soundBtn').textContent = store.sound ? '🔊' : '🔇';
}

/* ---------------------------------------------------------------- sound */

let audioCtx = null;
function tone(freq, start, dur, type = 'sine', vol = 0.15) {
  if (!store.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime + start;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  } catch { /* audio unavailable */ }
}

const sfx = {
  flip: () => tone(900, 0, 0.05, 'triangle', 0.05),
  right: () => { tone(660, 0, 0.12); tone(990, 0.09, 0.2); },
  wrong: () => { tone(240, 0, 0.16, 'triangle', 0.12); tone(190, 0.12, 0.22, 'triangle', 0.1); },
  win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.11, i === 4 ? 0.6 : 0.22, 'triangle', 0.14)),
  done: () => [392, 523, 659].forEach((f, i) => tone(f, i * 0.13, 0.3, 'triangle', 0.12)),
};

/* ---------------------------------------------------------------- confetti */

const confetti = (() => {
  const canvas = document.getElementById('confetti');
  const ctx = canvas.getContext('2d');
  const colors = ['#1f7ae0', '#89c2ff', '#22b36b', '#ffb800', '#f0524f', '#a66bff', '#ff8ad8'];
  let parts = [];
  let raf = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function burst(count = 160, originX = 0.5, originY = 0.35) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    resize();
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 9;
      parts.push({
        x: innerWidth * originX, y: innerHeight * originY,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 6,
        w: 6 + Math.random() * 6, h: 8 + Math.random() * 8,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        color: pickRandom(colors), life: 0, max: 140 + Math.random() * 80,
        shape: Math.random() < 0.3 ? 'circle' : 'rect',
      });
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function tick() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter(p => p.life < p.max && p.y < innerHeight + 40);
    for (const p of parts) {
      p.life++;
      p.vy += 0.22;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.max);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2)) + 2);
      ctx.restore();
    }
    raf = parts.length ? requestAnimationFrame(tick) : 0;
    if (!raf) ctx.clearRect(0, 0, innerWidth, innerHeight);
  }

  function stop() {
    parts = [];
    cancelAnimationFrame(raf);
    raf = 0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
  }

  return { burst, stop };
})();

function toast(text, color) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  if (color) el.style.background = color;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

/* ---------------------------------------------------------------- loading */

function detectRepo() {
  if (CONFIG.githubRepo) return CONFIG.githubRepo;
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return '';
  const first = location.pathname.split('/').filter(Boolean)[0];
  return `${m[1]}/${first && !first.includes('.') ? first : `${m[1]}.github.io`}`;
}

async function discoverFiles() {
  const folder = CONFIG.lessonsFolder;
  try {
    const res = await fetch(`${folder}/index.json`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const files = Array.isArray(data) ? data : data.files;
      if (Array.isArray(files) && files.length) return files;
    }
  } catch { /* fall through to GitHub API */ }

  const repo = detectRepo();
  if (!repo) throw new Error(`Couldn't find ${folder}/index.json. Run "node tools/build-index.mjs" to create it.`);
  const ref = CONFIG.githubBranch ? `?ref=${encodeURIComponent(CONFIG.githubBranch)}` : '';
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${folder}${ref}`);
  if (!res.ok) throw new Error(`GitHub couldn't list the ${folder} folder (status ${res.status}).`);
  const list = await res.json();
  return list.filter(f => f.type === 'file' && /\.json$/i.test(f.name) && f.name !== 'index.json').map(f => f.name);
}

function resolveUrl(src, fileUrl) {
  if (!src) return '';
  try { return new URL(src, fileUrl).href; } catch { return ''; }
}

function firstOf(obj, keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
}

function normalizeCard(c, fileUrl, lessonId) {
  if (Array.isArray(c)) c = { front: c[0], back: c[1] };
  if (!c || typeof c !== 'object') return null;
  const front = firstOf(c, ['front', 'question', 'term', 'word', 'q']);
  const back = firstOf(c, ['back', 'answer', 'definition', 'meaning', 'a']);
  const image = resolveUrl(c.image || c.frontImage, fileUrl);
  const backImage = resolveUrl(c.backImage, fileUrl);
  if ((front === undefined && !image) || (back === undefined && !backImage)) return null;
  const card = {
    front: String(front ?? ''),
    back: String(back ?? ''),
    hint: c.hint ? String(c.hint) : '',
    image,
    backImage,
    wrong: Array.isArray(c.wrong) ? c.wrong.map(String) : [],
    lessonId,
  };
  card.key = hash(`${card.front}␞${card.back}`);
  return card;
}

function normalizeFile(raw, file, fileUrl) {
  if (Array.isArray(raw)) raw = { cards: raw };
  if (!raw || typeof raw !== 'object') throw new Error('The file must contain a JSON object.');
  const shared = { project: raw.project, icon: raw.icon, color: raw.color };
  const list = Array.isArray(raw.lessons) ? raw.lessons : [raw];
  return list.map((l, i) => {
    l = { ...shared, ...l };
    const id = list.length > 1 ? `${file}#${i}` : file;
    const rawCards = firstOf(l, ['cards', 'materials', 'flashcards', 'items', 'questions']) || [];
    if (!Array.isArray(rawCards)) throw new Error(`"cards" must be a list in "${l.name || file}".`);
    const cards = rawCards.map(c => normalizeCard(c, fileUrl, id)).filter(Boolean);
    if (!cards.length) throw new Error(`"${l.name || file}" has no cards with both a front and a back.`);
    return {
      id,
      file,
      project: String(l.project || 'My lessons'),
      name: String(l.name || l.title || file.replace(/\.json$/i, '').replace(/[-_]/g, ' ')),
      description: l.description ? String(l.description) : '',
      icon: l.icon ? String(l.icon) : '📘',
      color: l.color ? String(l.color) : '',
      order: Number.isFinite(l.order) ? l.order : 1e9,
      cards,
    };
  });
}

async function loadLessons() {
  lessons = [];
  loadErrors = [];
  let files;
  try {
    files = await discoverFiles();
  } catch (e) {
    loadErrors.push({ file: 'lessons', message: e.message });
    return;
  }
  const base = new URL(`${CONFIG.lessonsFolder}/`, location.href);
  const results = await Promise.allSettled(files.map(async file => {
    const url = new URL(file, base).href;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Couldn't download (status ${res.status}).`);
    const text = await res.text();
    let raw;
    try { raw = JSON.parse(text.replace(/^﻿/, '')); }
    catch (e) { throw new Error(`Not valid JSON — ${e.message}`); }
    return normalizeFile(raw, file, url);
  }));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') lessons.push(...r.value);
    else loadErrors.push({ file: files[i], message: r.reason?.message || String(r.reason) });
  });
}

/* ---------------------------------------------------------------- home */

function projects() {
  const map = new Map();
  for (const l of lessons) {
    if (!map.has(l.project)) map.set(l.project, []);
    map.get(l.project).push(l);
  }
  return [...map.entries()]
    .sort((a, b) => byName(a[0], b[0]))
    .map(([name, list]) => ({ name, lessons: list.sort((a, b) => a.order - b.order || byName(a.name, b.name)) }));
}

function greeting() {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Hi' : 'Good evening';
  return CONFIG.studentName ? `${part}, ${esc(CONFIG.studentName)}! 👋` : `${part}! 👋`;
}

function renderHome() {
  confetti.stop();
  session = null;
  keyHandler = null;
  closeDialog();

  const errors = loadErrors.length ? `
    <div class="notice" role="alert">
      <b>⚠️ Some lesson files couldn't be loaded:</b>
      <ul>${loadErrors.map(e => `<li><code>${esc(e.file)}</code> — ${esc(e.message)}</li>`).join('')}</ul>
    </div>` : '';

  $app.innerHTML = `
    <section class="hero">
      <div>
        <h1>${greeting()}</h1>
        <p>What would you like to study today?</p>
      </div>
      ${lessons.length ? `<input class="search" id="search" type="search" placeholder="🔍 Search lessons…" value="${esc(homeQuery)}" aria-label="Search lessons" />` : ''}
    </section>
    ${errors}
    <div id="projects"></div>`;

  const search = document.getElementById('search');
  if (search) search.addEventListener('input', () => { homeQuery = search.value; renderProjectList(); });
  renderProjectList();
}

function renderProjectList() {
  const box = document.getElementById('projects');
  if (!box) return;
  if (!lessons.length) {
    box.innerHTML = `<div class="empty"><div class="big">📭</div><h2>No lessons yet</h2><p>Add a .json file to the <code>lessons</code> folder to get started.</p></div>`;
    return;
  }
  const q = homeQuery.trim().toLowerCase();
  const matches = l => !q || [l.name, l.project, l.description].some(s => s.toLowerCase().includes(q))
    || l.cards.some(c => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q));

  const groups = projects().map(p => ({ ...p, lessons: p.lessons.filter(matches) })).filter(p => p.lessons.length);
  if (!groups.length) {
    box.innerHTML = `<div class="empty"><div class="big">🔎</div><p>Nothing found for “${esc(homeQuery)}”.</p></div>`;
    return;
  }

  box.innerHTML = groups.map((p, pi) => {
    const total = p.lessons.reduce((n, l) => n + l.cards.length, 0);
    return `
      <section class="project">
        <div class="project-head">
          <div class="project-title"><h2>${esc(p.name)}</h2><span class="count">${plural(p.lessons.length, 'lesson')}</span></div>
          ${p.lessons.length > 1 ? `<button class="btn small secondary" data-project="${pi}">📚 Study all ${total} cards</button>` : ''}
        </div>
        <div class="grid">
          ${p.lessons.map(l => {
            const st = statsFor(l.id);
            const m = Math.round(mastery(l) * 100);
            return `
              <button class="lesson-card" data-lesson="${esc(l.id)}" ${l.color ? `style="--accent:${esc(l.color)}"` : ''}>
                <div class="lesson-icon">${esc(l.icon)}</div>
                <h3>${esc(l.name)}</h3>
                ${l.description ? `<p class="desc">${esc(l.description)}</p>` : '<p class="desc"></p>'}
                <div class="mastery" title="${m}% known"><span style="width:${m}%"></span></div>
                <div class="lesson-meta">
                  <span>${plural(l.cards.length, 'card')}${st.plays ? ` · best ${st.best}%` : ''}</span>
                  <span class="stars">${starsHtml(st.plays ? starsFor(st.best) : 0)}</span>
                </div>
              </button>`;
          }).join('')}
        </div>
      </section>`;
  }).join('');

  box.querySelectorAll('[data-lesson]').forEach(el => el.addEventListener('click', () => {
    const l = lessons.find(x => x.id === el.dataset.lesson);
    openSetup({ key: l.id, title: l.name, subtitle: l.project, lessons: [l] });
  }));
  box.querySelectorAll('[data-project]').forEach(el => el.addEventListener('click', () => {
    const p = groups[+el.dataset.project];
    const all = projects().find(x => x.name === p.name);
    openSetup({ key: `project:${p.name}`, title: `All of ${p.name}`, subtitle: plural(all.lessons.length, 'lesson'), lessons: all.lessons });
  }));
}

/* ---------------------------------------------------------------- setup dialog */

function closeDialog() {
  document.querySelector('.overlay')?.remove();
}

function openSetup(target) {
  closeDialog();
  const cards = target.lessons.flatMap(l => l.cards);
  const missed = cards.filter(c => cardStat(c)?.last === 0);
  const canQuiz = new Set(cards.map(c => c.back)).size >= 2 || cards.some(c => c.wrong.length);
  const prefs = store.prefs;
  let mode = prefs.mode === 'quiz' && canQuiz ? 'quiz' : 'cards';

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="setupTitle">
      <h2 id="setupTitle">${esc(target.title)}</h2>
      <p class="sub">${esc(target.subtitle)} · ${plural(cards.length, 'card')}</p>
      <div class="mode-pick">
        <button class="mode" data-mode="cards"><span class="emoji">🃏</span><b>Flashcards</b><small>Flip and check yourself</small></button>
        <button class="mode" data-mode="quiz" ${canQuiz ? '' : 'disabled'}><span class="emoji">✅</span><b>Quiz</b><small>Pick the right answer</small></button>
      </div>
      <label class="option"><span>Shuffle cards</span>
        <span class="switch"><input type="checkbox" id="optShuffle" ${prefs.shuffle ? 'checked' : ''}><span></span></span></label>
      <label class="option"><span>Answer side first<small>Show the back, guess the front</small></span>
        <span class="switch"><input type="checkbox" id="optReverse" ${prefs.reverse ? 'checked' : ''}><span></span></span></label>
      <label class="option"><span>Only cards I missed<small>${missed.length ? `${plural(missed.length, 'card')} to practise` : 'Nothing missed yet — nice!'}</small></span>
        <span class="switch"><input type="checkbox" id="optMissed" ${missed.length ? '' : 'disabled'}><span></span></span></label>
      <div class="dialog-actions">
        <button class="btn secondary" id="cancelBtn">Back</button>
        <button class="btn" id="startBtn">Let's go! 🚀</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const modeBtns = overlay.querySelectorAll('[data-mode]');
  const paint = () => modeBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  paint();
  modeBtns.forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; paint(); }));
  overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog(); });
  overlay.querySelector('#cancelBtn').addEventListener('click', closeDialog);
  overlay.querySelector('#startBtn').addEventListener('click', () => {
    const shuffleOn = overlay.querySelector('#optShuffle').checked;
    const reverse = overlay.querySelector('#optReverse').checked;
    const onlyMissed = overlay.querySelector('#optMissed').checked;
    store.prefs = { mode, shuffle: shuffleOn, reverse };
    saveStore();
    closeDialog();
    startSession({ ...target, mode, reverse, shuffle: shuffleOn, practice: onlyMissed, deck: onlyMissed ? missed : cards });
  });
  overlay.querySelector('#startBtn').focus();
  keyHandler = e => { if (e.key === 'Escape') closeDialog(); };
}

/* ---------------------------------------------------------------- session */

function startSession(opts) {
  confetti.stop();
  const pool = opts.lessons.flatMap(l => l.cards);
  session = {
    ...opts,
    pool,
    deck: opts.shuffle ? shuffle(opts.deck) : opts.deck.slice(),
    i: 0,
    right: 0,
    wrong: 0,
    results: [],
    flipped: false,
    busy: false,
  };
  if (history.state?.study !== true) history.pushState({ study: true }, '', '#study');
  renderStudyFrame();
}

function sideText(card, side) {
  // side: 'q' (question) or 'a' (answer), taking "answer side first" into account
  const front = { text: card.front, image: card.image };
  const back = { text: card.back, image: card.backImage };
  return (side === 'q') !== session.reverse ? front : back;
}

function renderStudyFrame() {
  const s = session;
  $app.innerHTML = `
    <div class="study-top">
      <button class="close-btn" id="quitBtn" aria-label="Stop studying">✕</button>
      <div class="title"><h2>${esc(s.title)}</h2><small>${s.mode === 'quiz' ? 'Quiz' : 'Flashcards'}${s.practice ? ' · practising missed cards' : ''}</small></div>
    </div>
    <div class="scorebar">
      <div class="progress" aria-hidden="true"><div class="ok" id="pOk"></div><div class="bad" id="pBad"></div></div>
      <div class="tally"><span class="r" title="Right">✓ <b id="tRight">0</b></span><span class="w" title="Wrong">✗ <b id="tWrong">0</b></span></div>
    </div>
    <div class="counter" id="counter"></div>
    <div id="stage"></div>`;
  document.getElementById('quitBtn').addEventListener('click', quitSession);
  updateScore();
  s.mode === 'quiz' ? renderQuizQuestion() : renderFlashcard();
}

function updateScore() {
  const s = session;
  const total = s.deck.length;
  document.getElementById('pOk').style.width = `${(s.right / total) * 100}%`;
  document.getElementById('pBad').style.width = `${(s.wrong / total) * 100}%`;
  document.getElementById('tRight').textContent = s.right;
  document.getElementById('tWrong').textContent = s.wrong;
  document.getElementById('counter').textContent = `Card ${Math.min(s.i + 1, total)} of ${total}`;
}

function quitSession() {
  if (session && session.results.length && session.i < session.deck.length && !confirm('Stop this lesson? Your progress on these cards is saved.')) return;
  goHome();
}

function goHome() {
  if (history.state?.study) history.back();
  else renderHome();
}

window.addEventListener('popstate', () => { if (!history.state?.study) renderHome(); });

function record(ok) {
  const s = session;
  const card = s.deck[s.i];
  s.results.push({ card, ok });
  ok ? s.right++ : s.wrong++;
  const st = statsFor(card.lessonId, true);
  const c = st.cards[card.key] || (st.cards[card.key] = { r: 0, w: 0, last: null });
  ok ? c.r++ : c.w++;
  c.last = ok ? 1 : 0;
  if (ok) store.xp++;
  saveStore();
  updateTopbar();
  updateScore();
  ok ? sfx.right() : sfx.wrong();

  const streak = streakOfRight();
  if (ok && streak > 0 && streak % 5 === 0) toast(`🔥 ${streak} in a row!`);
}

function streakOfRight() {
  let n = 0;
  for (let i = session.results.length - 1; i >= 0 && session.results[i].ok; i--) n++;
  return n;
}

function next() {
  session.i++;
  session.flipped = false;
  session.busy = false;
  if (session.i >= session.deck.length) return finishSession();
  updateScore();
  session.mode === 'quiz' ? renderQuizQuestion() : renderFlashcard();
}

/* ---------------------------------------------------------------- flashcards */

function faceHtml(side, label, extra = '') {
  const long = side.text.length > 90;
  return `
    <span class="label">${label}</span>
    ${side.image ? `<img src="${esc(side.image)}" alt="" draggable="false">` : ''}
    ${side.text ? `<div class="text${long ? ' long' : ''}">${esc(side.text)}</div>` : ''}
    ${extra}`;
}

function renderFlashcard() {
  const s = session;
  const card = s.deck[s.i];
  const q = sideText(card, 'q');
  const a = sideText(card, 'a');
  const hint = card.hint && !s.reverse ? `<button class="hint-btn" id="hintBtn">💡 Show hint</button>` : '';
  const stage = document.getElementById('stage');
  stage.innerHTML = `
    <div class="card-stage">
      <div class="flashcard enter" id="card" role="button" tabindex="0" aria-label="Flashcard, press space to flip">
        <div class="face front">${faceHtml(q, s.reverse ? 'Answer' : 'Question', hint)}<span class="tap">Tap to flip ↻</span></div>
        <div class="face back">${faceHtml(a, s.reverse ? 'Question' : 'Answer')}<span class="tap">Did you know it?</span></div>
      </div>
    </div>
    <div class="answer-row">
      <button class="btn red" id="wrongBtn" disabled>✗ Didn't know</button>
      <button class="btn green" id="rightBtn" disabled>✓ Knew it!</button>
    </div>
    <p class="keys"><kbd>Space</kbd> flip · <kbd>←</kbd> didn't know · <kbd>→</kbd> knew it · or swipe</p>`;

  const el = document.getElementById('card');
  const hintBtn = document.getElementById('hintBtn');
  if (hintBtn) {
    hintBtn.addEventListener('pointerdown', e => e.stopPropagation());
    hintBtn.addEventListener('click', e => {
      e.stopPropagation();
      hintBtn.outerHTML = `<div class="hint-text">💡 ${esc(card.hint)}</div>`;
    });
  }
  document.getElementById('rightBtn').addEventListener('click', () => answerCard(true));
  document.getElementById('wrongBtn').addEventListener('click', () => answerCard(false));
  attachSwipe(el);

  keyHandler = e => {
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); flip(); }
    else if (e.key === 'ArrowRight') answerCard(true);
    else if (e.key === 'ArrowLeft') answerCard(false);
    else if (e.key.toLowerCase() === 'h') hintBtn?.click();
    else if (e.key === 'Escape') quitSession();
  };
}

function flip() {
  const s = session;
  if (!s || s.busy) return;
  s.flipped = !s.flipped;
  const el = document.getElementById('card');
  el.classList.remove('enter');
  el.classList.toggle('flipped', s.flipped);
  document.getElementById('rightBtn').disabled = false;
  document.getElementById('wrongBtn').disabled = false;
  sfx.flip();
}

function answerCard(ok) {
  const s = session;
  if (!s || s.busy) return;
  if (!s.flipped) { flip(); return; } // peek at the answer first
  s.busy = true;
  record(ok);
  const el = document.getElementById('card');
  el.style.transform = '';
  el.classList.add(ok ? 'fly-right' : 'fly-left');
  setTimeout(next, 330);
}

function attachSwipe(el) {
  let startX = 0, startY = 0, dx = 0, dragging = false, moved = false;
  el.addEventListener('pointerdown', e => {
    if (session.busy) return;
    dragging = true; moved = false; dx = 0;
    startX = e.clientX; startY = e.clientY;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => {
    if (!dragging) return;
    dx = e.clientX - startX;
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(e.clientY - startY)) moved = true;
    if (moved && session.flipped) {
      el.style.transition = 'none';
      el.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg) rotateY(180deg)`;
      el.querySelector('.back').style.boxShadow = dx > 0 ? `0 0 0 ${Math.min(6, dx / 20)}px var(--green)` : `0 0 0 ${Math.min(6, -dx / 20)}px var(--red)`;
    }
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.style.transition = '';
    el.querySelector('.back').style.boxShadow = '';
    if (!moved) { flip(); return; }
    if (session.flipped && Math.abs(dx) > 90) { answerCard(dx > 0); return; }
    el.style.transform = '';
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { moved = true; dx = 0; end(); });
}

/* ---------------------------------------------------------------- quiz */

function buildChoices(card) {
  const s = session;
  const correct = sideText(card, 'a').text;
  const seen = new Set([correct.trim().toLowerCase()]);
  const out = [];
  const add = t => {
    const k = String(t).trim().toLowerCase();
    if (!k || seen.has(k) || out.length >= 3) return;
    seen.add(k);
    out.push(String(t));
  };
  if (!s.reverse) shuffle(card.wrong).forEach(add);
  const sameLesson = shuffle(s.pool.filter(c => c !== card && c.lessonId === card.lessonId));
  const others = shuffle(s.pool.filter(c => c !== card && c.lessonId !== card.lessonId));
  [...sameLesson, ...others].forEach(c => add(sideText(c, 'a').text));
  return shuffle([correct, ...out]).map(text => ({ text, correct: text === correct }));
}

function renderQuizQuestion() {
  const s = session;
  const card = s.deck[s.i];
  const q = sideText(card, 'q');
  const choices = buildChoices(card);
  const stage = document.getElementById('stage');
  stage.innerHTML = `
    <div class="quiz-q enter-q">
      <span class="label">${s.reverse ? 'Which one matches?' : 'Question'}</span>
      ${q.image ? `<img src="${esc(q.image)}" alt="">` : ''}
      ${q.text ? `<div class="text">${esc(q.text)}</div>` : ''}
      ${card.hint && !s.reverse ? `<button class="hint-btn" id="hintBtn">💡 Show hint</button>` : ''}
    </div>
    <div class="choices">
      ${choices.map((c, i) => `<button class="choice" data-i="${i}"><span class="key">${i + 1}</span><span>${esc(c.text)}</span></button>`).join('')}
    </div>
    <div class="quiz-next" id="quizNext"></div>
    <p class="keys"><kbd>1</kbd>–<kbd>${choices.length}</kbd> choose · <kbd>Enter</kbd> next</p>`;

  const hintBtn = document.getElementById('hintBtn');
  hintBtn?.addEventListener('click', () => { hintBtn.outerHTML = `<div class="hint-text">💡 ${esc(card.hint)}</div>`; });

  const btns = [...stage.querySelectorAll('.choice')];
  let answered = false;
  const choose = i => {
    if (answered || !btns[i]) return;
    answered = true;
    const ok = choices[i].correct;
    btns.forEach((b, j) => {
      b.disabled = true;
      if (choices[j].correct) b.classList.add('correct');
    });
    if (!ok) btns[i].classList.add('wrong');
    record(ok);
    if (ok) {
      session.busy = true;
      setTimeout(() => { if (session && session.deck[session.i] === card) next(); }, 850);
    } else {
      const nextBox = document.getElementById('quizNext');
      nextBox.innerHTML = `<button class="btn" id="nextBtn">Next →</button>`;
      document.getElementById('nextBtn').addEventListener('click', next);
      document.getElementById('nextBtn').focus();
    }
  };
  btns.forEach((b, i) => b.addEventListener('click', () => choose(i)));

  keyHandler = e => {
    if (/^[1-9]$/.test(e.key)) choose(+e.key - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && answered && !session.busy) { e.preventDefault(); next(); }
    else if (e.key.toLowerCase() === 'h') hintBtn?.click();
    else if (e.key === 'Escape') quitSession();
  };
}

/* ---------------------------------------------------------------- results */

const MESSAGES = {
  perfect: ['PERFECT SCORE! You nailed every single card! 🏆', 'Flawless! You are a superstar! 🌟', '100%! Your brain is on fire! 🔥'],
  3: ['Amazing work! You really know this!', 'Fantastic! Almost perfect!', 'Brilliant job — you rock!'],
  2: ['Great job! You\'re getting there!', 'Nice work! A little more practice and you\'ve got it!', 'Well done — keep it up!'],
  1: ['Good effort! Practice the missed ones and try again.', 'You\'re learning! Every try makes you stronger. 💪', 'Nice start! Let\'s practise the tricky ones.'],
  0: ['Every expert started as a beginner. Let\'s try again! 🌱', 'Learning takes practice — you can do it!', 'Don\'t give up! Review the cards and try once more.'],
};

function finishSession() {
  const s = session;
  keyHandler = null;
  const total = s.deck.length;
  const pct = Math.round((s.right / total) * 100);
  const stars = starsFor(pct);
  const perfect = s.right === total;

  // Save scores (practice runs on missed cards only update per-card stats).
  let newBest = false;
  let tries = [];
  if (!s.practice) {
    const st = statsFor(s.key, true);
    newBest = st.plays > 0 && pct > st.best;
    st.best = Math.max(st.best, pct);
    st.plays++;
    st.history = [...st.history, pct].slice(-10);
    tries = st.history;
  }
  bumpStreak();
  saveStore();
  updateTopbar();

  const trophy = perfect ? '🏆' : stars === 3 ? '🥇' : stars === 2 ? '🎉' : stars === 1 ? '💪' : '🌱';
  const headline = perfect ? 'Perfect!' : stars === 3 ? 'Awesome!' : stars === 2 ? 'Great job!' : stars === 1 ? 'Good try!' : 'Keep going!';
  const message = pickRandom(perfect ? MESSAGES.perfect : MESSAGES[stars]);
  const missed = s.results.filter(r => !r.ok).map(r => r.card);
  const R = 70, C = 2 * Math.PI * R;

  $app.innerHTML = `
    <div class="results">
      <div class="trophy">${trophy}</div>
      <h1>${headline}</h1>
      <p class="lead">${esc(message)}</p>
      <div class="big-stars">${[0, 1, 2].map(i => `<span class="${i < stars ? '' : 'off'}" style="animation-delay:${0.35 + i * 0.25}s">⭐</span>`).join('')}</div>

      <div class="result-panel">
        <div class="donut">
          <svg viewBox="0 0 170 170"><circle class="track" cx="85" cy="85" r="${R}"/><circle class="arc" id="arc" cx="85" cy="85" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
          <div class="center"><div><div class="pct" id="pctNum">0%</div><small>correct</small></div></div>
        </div>
        <div class="stat-list">
          <div class="stat"><span class="dot" style="background:var(--green)"></span><b>${s.right}</b><span>knew it</span></div>
          <div class="stat"><span class="dot" style="background:var(--red)"></span><b>${s.wrong}</b><span>still learning</span></div>
          <div class="stat"><span class="dot" style="background:var(--blue)"></span><b>${total}</b><span>${total === 1 ? 'card' : 'cards'} studied</span></div>
          <div class="stat"><span class="dot" style="background:var(--gold)"></span><b>${currentStreak()}</b><span>day streak 🔥</span></div>
          ${newBest ? '<div><span class="badge-new">🎖️ New personal best!</span></div>' : ''}
        </div>
      </div>

      ${tries.length > 1 ? `
        <div class="history">
          <h3>📈 Your last ${tries.length} tries</h3>
          <div class="bars">${tries.map((h, i) => `<div class="bar ${i === tries.length - 1 ? 'now' : ''}" title="${h}%"><small>${h}%</small><i style="height:${Math.max(4, h) * 0.8}%"></i></div>`).join('')}</div>
        </div>` : ''}

      ${missed.length ? `
        <div class="missed">
          <h3>📝 Cards to practise (${missed.length})</h3>
          <ul>${missed.map(c => `<li><b>${c.image ? `<img src="${esc(c.image)}" alt="">` : ""}${esc(c.front)}</b><span>${esc(c.back || '🖼️')}</span></li>`).join('')}</ul>
        </div>` : ''}

      <div class="result-actions">
        ${missed.length ? `<button class="btn red" id="practiceBtn">🔁 Practise ${plural(missed.length, 'missed card')}</button>` : ''}
        <button class="btn" id="againBtn">↻ Study again</button>
        <button class="btn secondary" id="homeBtn2">🏠 All lessons</button>
      </div>
    </div>`;

  // Animate donut + percentage
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.getElementById('arc').style.strokeDashoffset = String(C * (1 - s.right / total));
  }));
  const pctEl = document.getElementById('pctNum');
  const t0 = performance.now();
  const count = now => {
    const p = Math.min(1, (now - t0) / 1200);
    pctEl.textContent = `${Math.round(pct * (1 - Math.pow(1 - p, 3)))}%`;
    if (p < 1 && document.body.contains(pctEl)) requestAnimationFrame(count);
  };
  requestAnimationFrame(count);

  // Celebrate
  if (stars >= 1) {
    setTimeout(() => (stars >= 2 ? sfx.win() : sfx.done()), 250);
    confetti.burst(stars === 3 ? 220 : stars === 2 ? 140 : 60);
    if (stars === 3) {
      setTimeout(() => confetti.burst(120, 0.2, 0.5), 450);
      setTimeout(() => confetti.burst(120, 0.8, 0.5), 700);
    }
  } else {
    setTimeout(sfx.done, 250);
  }

  const again = cards => startSession({ ...s, deck: cards, practice: cards !== s.deck ? true : s.practice });
  document.getElementById('practiceBtn')?.addEventListener('click', () => again(missed));
  document.getElementById('againBtn').addEventListener('click', () => again(s.deck));
  document.getElementById('homeBtn2').addEventListener('click', goHome);
  keyHandler = e => { if (e.key === 'Enter') document.getElementById(missed.length ? 'practiceBtn' : 'againBtn').click(); else if (e.key === 'Escape') goHome(); };
}

/* ---------------------------------------------------------------- boot */

document.addEventListener('keydown', e => {
  if (e.target.matches?.('input, textarea')) return;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  keyHandler?.(e);
});

document.getElementById('homeBtn').addEventListener('click', () => (session ? quitSession() : renderHome()));
document.getElementById('soundBtn').addEventListener('click', () => {
  store.sound = !store.sound;
  saveStore();
  updateTopbar();
  sfx.right();
});

(async () => {
  updateTopbar();
  if (history.state?.study) history.replaceState(null, '', location.pathname + location.search);
  await loadLessons();
  renderHome();
})();
