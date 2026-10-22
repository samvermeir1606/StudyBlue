'use strict';

/* =========================================================================
   StudyBlue — flashcards from JSON files
   -------------------------------------------------------------------------
   Lessons live in the `lessons/` folder as .json files. The site finds them
   through `lessons/index.json` (generated automatically by the GitHub Action
   or by `node tools/build-index.mjs`). When that file is missing it asks the
   GitHub API for the folder list.
   ========================================================================= */

const CONFIG = {
  studentName: '',                        // bv. 'Emma' → "Dag Emma!" op het startscherm
  lessonsFolder: 'lessons',
  githubRepo: 'samvermeir1606/StudyBlue', // gebruikt door de lesmaker en als reserve om lessen te vinden
  githubBranch: 'master',
  speechLang: 'nl-BE',                    // standaardtaal voor voorlezen (per les aan te passen met "language")
};

const STORE_KEY = 'studyblue.v1';
const $app = document.getElementById('app');
const LOCALE = 'nl-BE';

let lessons = [];
let loadErrors = [];
let session = null;
let keyHandler = null;
let homeQuery = '';

/* ---------------------------------------------------------------- helpers */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pickRandom = arr => arr[Math.floor(Math.random() * arr.length)];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const byName = (a, b) => a.localeCompare(b, LOCALE, { numeric: true, sensitivity: 'base' });
const dayString = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

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

// Saves a text file. On iPhone the share sheet is used ("Bewaar in Bestanden").
async function saveFile(name, text, type = 'application/json') {
  const file = new File([text], name, { type });
  if (isIOS && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------------------------------------------------------- storage */

function defaultStore() {
  return {
    lessons: {},        // per les/vak: beste score, rondes en resultaten per kaart
    activity: {},       // per dag: { n: kaarten beantwoord, r: juist, ms: tijd }
    xp: 0,
    streak: { count: 0, day: '', best: 0 },
    sound: true,
    prefs: { mode: 'cards', shuffle: true, reverse: false, autoSpeak: false, hideInstallTip: false },
  };
}

const store = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && typeof saved === 'object') {
      const base = defaultStore();
      return { ...base, ...saved, prefs: { ...base.prefs, ...saved.prefs }, streak: { ...base.streak, ...saved.streak } };
    }
  } catch { /* storage unavailable */ }
  return defaultStore();
})();

function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* storage unavailable */ }
}

const emptyStats = () => ({ best: 0, plays: 0, history: [], sessions: [], cards: {} });

function statsFor(key, create = false) {
  if (!store.lessons[key] && create) store.lessons[key] = emptyStats();
  const st = store.lessons[key] || emptyStats();
  st.sessions = st.sessions || [];
  return st;
}

// Per card: r/w = right/wrong counts, last = 1|0, log = last 10 results, t = last time seen
function cardStat(card) {
  return statsFor(card.lessonId).cards[card.key];
}

function cardStatus(card) {
  const c = cardStat(card);
  if (!c || !(c.r + c.w)) return 'new';
  return c.last === 1 ? 'known' : 'learning';
}

function cardCounts(cards) {
  const counts = { known: 0, learning: 0, new: 0 };
  for (const c of cards) counts[cardStatus(c)]++;
  return counts;
}

function mastery(lesson) {
  return cardCounts(lesson.cards).known / lesson.cards.length;
}

function currentStreak() {
  const { count, day } = store.streak;
  const yesterday = dayString(new Date(Date.now() - 864e5));
  return day === dayString() || day === yesterday ? count : 0;
}

function bumpStreak() {
  const today = dayString();
  if (store.streak.day === today) return;
  const count = currentStreak() + 1;
  store.streak = { count, day: today, best: Math.max(store.streak.best || 0, count) };
}

function logActivity(ok, ms) {
  const day = dayString();
  const a = store.activity[day] || (store.activity[day] = { n: 0, r: 0, ms: 0 });
  a.n++;
  if (ok) a.r++;
  a.ms += ms;
}

function timeAgo(t) {
  const days = Math.round((new Date(dayString()) - new Date(dayString(new Date(t)))) / 864e5);
  return days <= 0 ? 'vandaag' : days === 1 ? 'gisteren' : days < 30 ? `${days} dagen geleden` : shortDate(t);
}

function updateTopbar() {
  document.getElementById('streakCount').textContent = currentStreak();
  document.getElementById('xpCount').textContent = store.xp;
  document.getElementById('soundBtn').textContent = store.sound ? '🔊' : '🔇';
}

/* ---------------------------------------------------------------- sound effects */

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

/* ---------------------------------------------------------------- read aloud
   Uses the voices built into the device (Web Speech API). iPhones and iPads
   have Dutch voices (Flemish "Ellen", Dutch "Xander"/"Claire"); better ones can
   be downloaded in Instellingen › Toegankelijkheid › Gesproken materiaal ›
   Stemmen. A card can also point to its own recording with "audio". */

const speech = (() => {
  const synth = window.speechSynthesis;
  let voices = [];
  let current = null;
  const load = () => { voices = synth ? synth.getVoices() : []; };
  if (synth) {
    load();
    synth.addEventListener?.('voiceschanged', load);
  }

  const norm = l => String(l || '').toLowerCase().replace('_', '-');
  const quality = v => (/(premium|enhanced|natural|neural)/i.test(v.name) ? 3 : 0) + (/google/i.test(v.name) ? 1 : 0) + (v.localService ? 1 : 0);
  function voiceFor(lang) {
    const want = norm(lang);
    const exact = voices.filter(v => norm(v.lang) === want);
    const pool = exact.length ? exact : voices.filter(v => norm(v.lang).split('-')[0] === want.split('-')[0]);
    return pool.sort((a, b) => quality(b) - quality(a))[0] || null;
  }

  function stop() {
    synth?.cancel();
    if (current) { current.pause(); current = null; }
  }

  function speak(text, lang, rate = 0.9) {
    if (!synth || !text) return;
    stop();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    const v = voiceFor(lang);
    if (v) u.voice = v;
    u.rate = rate;
    synth.speak(u);
  }

  function play(url) {
    stop();
    current = new Audio(url);
    current.play().catch(() => {});
  }

  // iOS only allows speech after a tap; call this from a click handler once.
  function unlock() {
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
  }

  return { available: !!synth, speak, play, stop, unlock, hasVoice: lang => !!voiceFor(lang), voiceName: lang => voiceFor(lang)?.name || '' };
})();

// side: { text, say, audio } — plays the recording if there is one, otherwise reads it aloud
function sayAloud(side, lang, slow = false) {
  if (side.audio) speech.play(side.audio);
  else speech.speak(side.say || side.text, lang, slow ? 0.75 : 0.9);
}

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
  if (!repo) throw new Error(`${folder}/index.json niet gevonden. Maak het aan met "node tools/build-index.mjs".`);
  const ref = CONFIG.githubBranch ? `?ref=${encodeURIComponent(CONFIG.githubBranch)}` : '';
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${folder}${ref}`);
  if (!res.ok) throw new Error(`GitHub kon de map ${folder} niet tonen (status ${res.status}).`);
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

function normalizeCard(c, fileUrl, lessonId, type) {
  if (type === 'spelling') {
    // { "word": "eikel", "say": "de eikel", "sentence": "De eekhoorn eet een eikel." }
    if (typeof c === 'string') c = { word: c };
    if (!c || typeof c !== 'object') return null;
    const word = firstOf(c, ['word', 'woord', 'back', 'answer']);
    if (word === undefined) return null;
    const card = {
      front: '',
      back: String(word),
      say: String(c.say || c.zeg || word),
      sentence: c.sentence || c.zin ? String(c.sentence || c.zin) : '',
      hint: '',
      image: resolveUrl(c.image, fileUrl),
      backImage: '',
      audio: resolveUrl(c.audio, fileUrl),
      backAudio: '',
      wrong: Array.isArray(c.wrong) ? c.wrong.map(String) : [],
      lessonId,
      raw: c,
    };
    card.key = hash(`␞${card.back}`);
    return card;
  }

  if (Array.isArray(c)) c = { front: c[0], back: c[1] };
  if (!c || typeof c !== 'object') return null;
  const front = firstOf(c, ['front', 'question', 'term', 'word', 'q', 'voorkant', 'vraag']);
  const back = firstOf(c, ['back', 'answer', 'definition', 'meaning', 'a', 'achterkant', 'antwoord']);
  const image = resolveUrl(c.image || c.frontImage, fileUrl);
  const backImage = resolveUrl(c.backImage, fileUrl);
  const audio = resolveUrl(c.audio, fileUrl);
  if ((front === undefined && !image && !audio) || (back === undefined && !backImage)) return null;
  const card = {
    front: String(front ?? ''),
    back: String(back ?? ''),
    say: c.say ? String(c.say) : '',
    sentence: '',
    hint: c.hint || c.tip ? String(c.hint || c.tip) : '',
    image,
    backImage,
    audio,
    backAudio: resolveUrl(c.backAudio, fileUrl),
    wrong: Array.isArray(c.wrong) ? c.wrong.map(String) : [],
    lessonId,
    raw: c,
  };
  card.key = hash(`${card.front}␞${card.back}`);
  return card;
}

function normalizeFile(raw, file, fileUrl) {
  if (Array.isArray(raw)) raw = { cards: raw };
  if (!raw || typeof raw !== 'object') throw new Error('Het bestand moet een JSON-object bevatten.');
  const shared = { project: raw.project, icon: raw.icon, color: raw.color, language: raw.language, type: raw.type };
  const list = Array.isArray(raw.lessons) ? raw.lessons : [raw];
  return list.map((l, i) => normalizeLesson({ ...shared, ...l }, list.length > 1 ? `${file}#${i}` : file, file, fileUrl));
}

function normalizeLesson(l, id, file, fileUrl) {
  const type = /^spel/i.test(l.type || '') ? 'spelling' : 'cards';
  const rawCards = firstOf(l, ['cards', 'materials', 'flashcards', 'items', 'questions', 'words', 'kaarten', 'woorden']) || [];
  if (!Array.isArray(rawCards)) throw new Error(`"cards" moet een lijst zijn in "${l.name || file}".`);
  const cards = rawCards.map(c => normalizeCard(c, fileUrl, id, type)).filter(Boolean);
  if (!cards.length) throw new Error(`"${l.name || file}" heeft geen kaarten met een voor- én achterkant.`);
  return {
    id,
    file,
    type,
    project: String(l.project || 'Mijn lessen'),
    name: String(l.name || l.title || file.replace(/\.json$/i, '').replace(/[-_]/g, ' ')),
    description: l.description ? String(l.description) : '',
    icon: l.icon ? String(l.icon) : (type === 'spelling' ? '🔤' : '📘'),
    color: l.color ? String(l.color) : '',
    language: l.language ? String(l.language) : CONFIG.speechLang,
    order: Number.isFinite(l.order) ? l.order : 1e9,
    cards,
  };
}

async function loadLessons() {
  const drafts = lessons.filter(l => l.draft);
  lessons = [];
  loadErrors = [];
  let files;
  try {
    files = await discoverFiles();
  } catch (e) {
    loadErrors.push({ file: 'lessons', message: e.message });
    lessons.push(...drafts);
    return;
  }
  const base = new URL(`${CONFIG.lessonsFolder}/`, location.href);
  const results = await Promise.allSettled(files.map(async file => {
    const url = new URL(file, base).href;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Kon niet downloaden (status ${res.status}).`);
    const text = await res.text();
    let raw;
    try { raw = JSON.parse(text.replace(/^﻿/, '')); }
    catch (e) { throw new Error(`Geen geldige JSON — ${e.message}`); }
    return normalizeFile(raw, file, url);
  }));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') lessons.push(...r.value);
    else loadErrors.push({ file: files[i], message: r.reason?.message || String(r.reason) });
  });
  lessons.push(...drafts);
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
  const part = h < 12 ? 'Goedemorgen' : h < 18 ? 'Dag' : 'Goedenavond';
  return CONFIG.studentName ? `${part} ${esc(CONFIG.studentName)}! 👋` : `${part}! 👋`;
}

function renderHome() {
  const errors = loadErrors.length ? `
    <div class="notice" role="alert">
      <b>⚠️ Sommige lesbestanden konden niet geladen worden:</b>
      <ul>${loadErrors.map(e => `<li><code>${esc(e.file)}</code> — ${esc(e.message)}</li>`).join('')}</ul>
    </div>` : '';

  const installTip = isIOS && !isStandalone && !store.prefs.hideInstallTip ? `
    <div class="install-tip">
      <span>📱 <b>Tip:</b> tik onderaan op <b>Deel</b> <span class="share-icon" aria-hidden="true">⬆︎</span> en dan op <b>Zet op beginscherm</b> om StudyBlue als app te gebruiken.</span>
      <button class="icon-btn small" id="hideTip" aria-label="Tip verbergen">✕</button>
    </div>` : '';

  $app.innerHTML = `
    <section class="hero">
      <div>
        <h1>${greeting()}</h1>
        <p>Wat wil je vandaag leren?</p>
      </div>
      <div class="hero-actions">
        ${lessons.length ? `<input class="search" id="search" type="search" placeholder="🔍 Zoek een les…" value="${esc(homeQuery)}" aria-label="Zoek een les" />` : ''}
        <button class="btn small secondary" id="makeBtn">✏️ Les maken</button>
      </div>
    </section>
    ${installTip}
    ${errors}
    <div id="projects"></div>`;

  const search = document.getElementById('search');
  if (search) search.addEventListener('input', () => { homeQuery = search.value; renderProjectList(); });
  document.getElementById('makeBtn').addEventListener('click', () => navigate('#/maken'));
  document.getElementById('hideTip')?.addEventListener('click', () => {
    store.prefs.hideInstallTip = true;
    saveStore();
    document.querySelector('.install-tip').remove();
  });
  renderProjectList();
}

function renderProjectList() {
  const box = document.getElementById('projects');
  if (!box) return;
  if (!lessons.length) {
    box.innerHTML = `<div class="empty"><div class="big">📭</div><h2>Nog geen lessen</h2><p>Maak een les met <b>✏️ Les maken</b> of zet een .json-bestand in de map <code>lessons</code>.</p></div>`;
    return;
  }
  const q = homeQuery.trim().toLowerCase();
  const matches = l => !q || [l.name, l.project, l.description].some(s => s.toLowerCase().includes(q))
    || l.cards.some(c => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q));

  const groups = projects().map(p => ({ ...p, lessons: p.lessons.filter(matches) })).filter(p => p.lessons.length);
  if (!groups.length) {
    box.innerHTML = `<div class="empty"><div class="big">🔎</div><p>Niets gevonden voor “${esc(homeQuery)}”.</p></div>`;
    return;
  }

  box.innerHTML = groups.map((p, pi) => {
    const total = p.lessons.reduce((n, l) => n + l.cards.length, 0);
    return `
      <section class="project">
        <div class="project-head">
          <div class="project-title"><button class="project-link" data-project-page="${pi}" title="Voortgang voor ${esc(p.name)}"><h2>${esc(p.name)}</h2><span aria-hidden="true">›</span></button><span class="count">${plural(p.lessons.length, 'les', 'lessen')}</span></div>
          ${p.lessons.length > 1 ? `<button class="btn small secondary" data-project="${pi}">📚 Alles oefenen (${total} kaarten)</button>` : ''}
        </div>
        <div class="grid">
          ${p.lessons.map(l => {
            const st = statsFor(l.id);
            const m = Math.round(mastery(l) * 100);
            return `
              <button class="lesson-card" data-lesson="${esc(l.id)}" ${l.color ? `style="--accent:${esc(l.color)}"` : ''}>
                <div class="lesson-icon">${esc(l.icon)}</div>
                ${l.type === 'spelling' ? '<span class="type-badge">🔊 Spelling</span>' : ''}
                ${l.draft ? '<span class="type-badge draft">✏️ Concept</span>' : ''}
                <h3>${esc(l.name)}</h3>
                <p class="desc">${esc(l.description)}</p>
                <div class="mastery" title="${m}% gekend"><span style="width:${m}%"></span></div>
                <div class="lesson-meta">
                  <span>${plural(l.cards.length, l.type === 'spelling' ? 'woord' : 'kaart', l.type === 'spelling' ? 'woorden' : 'kaarten')}${st.plays ? ` · beste ${st.best}%` : ''}</span>
                  <span class="stars">${starsHtml(st.plays ? starsFor(st.best) : 0)}</span>
                </div>
              </button>`;
          }).join('')}
        </div>
      </section>`;
  }).join('');

  box.querySelectorAll('[data-lesson]').forEach(el => el.addEventListener('click', () => {
    navigate(`#/les/${encodeURIComponent(el.dataset.lesson)}`);
  }));
  box.querySelectorAll('[data-project]').forEach(el => el.addEventListener('click', () => {
    openSetup({ ...projectTarget(groups[+el.dataset.project].name), backLabel: 'Alle lessen' });
  }));
  box.querySelectorAll('[data-project-page]').forEach(el => el.addEventListener('click', () => {
    navigate(`#/vak/${encodeURIComponent(groups[+el.dataset.projectPage].name)}`);
  }));
}

/* ---------------------------------------------------------------- routing */

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  const [view, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const arg = decodeURIComponent(rest.join('/'));
  if (view === 'oefenen') {
    if (session) return;
    history.replaceState(null, '', '#/'); // reloaded mid-session: nothing to resume
  }
  session = null;
  keyHandler = null;
  speech.stop();
  confetti.stop();
  closeDialog();
  tooltip.hide();
  scrollTo(0, 0);
  if (view === 'les') {
    const l = lessons.find(x => x.id === arg);
    if (l) return renderDeck(lessonTarget(l));
  }
  if (view === 'vak') {
    const t = projectTarget(arg);
    if (t) return renderDeck(t);
  }
  if (view === 'voortgang') return renderStats();
  if (view === 'maken') return renderMaker(arg);
  renderHome();
}

window.addEventListener('hashchange', route);

function lessonTarget(l) {
  return { key: l.id, kind: 'lesson', title: l.name, subtitle: l.project, icon: l.icon, color: l.color, description: l.description, lessons: [l], backLabel: 'Terug naar de les' };
}

function projectTarget(name) {
  const p = projects().find(x => x.name === name);
  if (!p) return null;
  return { key: `project:${name}`, kind: 'project', title: name, subtitle: plural(p.lessons.length, 'les', 'lessen'), icon: '📚', color: '', description: '', lessons: p.lessons, backLabel: 'Terug naar het vak' };
}

/* ---------------------------------------------------------------- shared bits */

function tile(label, value, sub = '') {
  return `<div class="tile"><small>${label}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
}

function statusBar(counts, height) {
  return stackBar([
    { value: counts.known, cls: 's-right', label: 'Gekend' },
    { value: counts.learning, cls: 's-wrong', label: 'Nog aan het leren' },
    { value: counts.new, cls: 's-new', label: 'Nog niet geoefend' },
  ], { height });
}

function statusLegend(counts) {
  return legend([
    { cls: 's-right', label: `✓ Gekend <b>${counts.known}</b>` },
    { cls: 's-wrong', label: `✗ Nog aan het leren <b>${counts.learning}</b>` },
    { cls: 's-new', label: `Nog niet geoefend <b>${counts.new}</b>` },
  ]);
}

// Score history for a lesson/project. Older saves only kept percentages without dates.
function scorePoints(st) {
  if (st.sessions.length) return st.sessions;
  return st.history.map((pct, i) => ({ pct, label: `Poging ${i + 1}` }));
}

function resultDots(log = []) {
  const pad = Array(Math.max(0, 10 - log.length)).fill(null);
  return `<span class="dots" aria-label="Laatste resultaten">${[...pad, ...log].map(v =>
    v === null ? '<i class="d-none"></i>' : v ? '<i class="d-right" title="Juist"></i>' : '<i class="d-wrong" title="Fout"></i>').join('')}</span>`;
}

function cardLabel(c) {
  return c.front || c.back;
}

/* ---------------------------------------------------------------- lesson / project page */

let deckFilter = 'all';
let deckSort = 'order';

function renderDeck(t) {
  const cards = t.lessons.flatMap(l => l.cards);
  const st = statsFor(t.key);
  const counts = cardCounts(cards);
  let right = 0, wrong = 0, lastSeen = 0;
  for (const c of cards) {
    const cs = cardStat(c);
    if (!cs) continue;
    right += cs.r;
    wrong += cs.w;
    lastSeen = Math.max(lastSeen, cs.t || 0);
  }
  const answers = right + wrong;
  const known = Math.round((counts.known / cards.length) * 100);
  const points = scorePoints(st);
  const lesson = t.kind === 'lesson' ? t.lessons[0] : null;
  const canEdit = lesson && !lesson.id.includes('#');
  deckFilter = 'all';

  $app.innerHTML = `
    <button class="back-link" id="backHome">← Alle lessen</button>
    <section class="deck-head" ${t.color ? `style="--accent:${esc(t.color)}"` : ''}>
      <div class="lesson-icon big">${esc(t.icon)}</div>
      <div class="deck-title">
        <small>${esc(t.subtitle)} · ${plural(cards.length, 'kaart', 'kaarten')}${lesson?.type === 'spelling' ? ' · 🔊 spelling' : ''}</small>
        <h1>${esc(t.title)}</h1>
        ${t.description ? `<p>${esc(t.description)}</p>` : ''}
      </div>
      <div class="deck-actions">
        ${canEdit ? '<button class="btn secondary" id="editBtn">✏️ Bewerken</button>' : ''}
        <button class="btn" id="studyBtn">▶ Oefenen</button>
      </div>
    </section>

    <div class="tiles">
      ${tile('Kaarten gekend', `${known}%`, `${counts.known} van ${cards.length}`)}
      ${tile('Beste score', st.plays ? `${st.best}%` : '–', `<span class="stars">${starsHtml(st.plays ? starsFor(st.best) : 0)}</span>`)}
      ${tile('Keer geoefend', st.plays, lastSeen ? `laatst: ${timeAgo(lastSeen)}` : 'nog niet')}
      ${tile('Juiste antwoorden', answers ? `${Math.round((right / answers) * 100)}%` : '–', `${right} van ${answers}`)}
    </div>

    <section class="panel">
      <h3>Voortgang kaarten</h3>
      ${statusBar(counts, 18)}
      ${statusLegend(counts)}
    </section>

    <section class="panel">
      <h3>Scores door de tijd</h3>
      ${points.length ? '<div class="chart-box" id="scoreChart"></div>' : '<p class="muted empty-chart">Speel een ronde om hier je scores te zien.</p>'}
    </section>

    ${t.kind === 'project' ? `
      <section class="panel">
        <h3>Lessen</h3>
        <div class="lesson-bars">
          ${t.lessons.map(l => {
            const c = cardCounts(l.cards);
            return `<button class="lesson-bar" data-goto="${esc(l.id)}">
              <span class="lb-name">${esc(l.icon)} ${esc(l.name)}</span>
              ${statusBar(c, 12)}
              <span class="lb-pct">${Math.round((c.known / l.cards.length) * 100)}%</span>
            </button>`;
          }).join('')}
        </div>
      </section>` : ''}

    <section class="panel">
      <div class="panel-head">
        <h3>Kaarten</h3>
        <label class="sort">Sorteer
          <select id="sortSel">
            <option value="order">Volgorde van de les</option>
            <option value="hardest">Moeilijkste eerst</option>
            <option value="most">Meest geoefend</option>
            <option value="least">Minst geoefend</option>
            <option value="az">A → Z</option>
          </select>
        </label>
      </div>
      <div class="chips" id="chips">
        ${[['all', 'Alle', cards.length], ['learning', '✗ Nog leren', counts.learning], ['known', '✓ Gekend', counts.known], ['new', 'Nieuw', counts.new]]
          .map(([k, label, n]) => `<button class="chip" data-filter="${k}" aria-pressed="${k === 'all'}">${label} <b>${n}</b></button>`).join('')}
      </div>
      <div class="card-table" id="cardList"></div>
    </section>

    <div class="deck-foot">
      <button class="link-btn danger" id="resetBtn">Voortgang wissen voor ${t.kind === 'project' ? 'dit vak' : 'deze les'}</button>
    </div>`;

  if (points.length) mountChart(document.getElementById('scoreChart'), w => scoreLineChart(points, w));
  document.getElementById('backHome').addEventListener('click', () => navigate('#/'));
  document.getElementById('studyBtn').addEventListener('click', () => openSetup(t));
  document.getElementById('editBtn')?.addEventListener('click', () => navigate(`#/maken/${encodeURIComponent(lesson.id)}`));
  $app.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => navigate(`#/les/${encodeURIComponent(el.dataset.goto)}`)));

  const sortSel = document.getElementById('sortSel');
  sortSel.value = deckSort;
  sortSel.addEventListener('change', () => { deckSort = sortSel.value; renderCardList(t, cards); });
  $app.querySelectorAll('[data-filter]').forEach(el => el.addEventListener('click', () => {
    deckFilter = el.dataset.filter;
    $app.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === el)));
    renderCardList(t, cards);
  }));
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm(`Alle scores en resultaten voor “${t.title}” wissen? Dit kan je niet ongedaan maken.`)) return;
    delete store.lessons[t.key];
    for (const l of t.lessons) delete store.lessons[l.id];
    saveStore();
    renderDeck(t);
  });
  renderCardList(t, cards);
}

function renderCardList(t, cards) {
  const box = document.getElementById('cardList');
  const lessonOf = id => lessons.find(l => l.id === id);
  const acc = r => (r.n ? r.s.r / r.n : 2); // unplayed cards sort after played ones
  let rows = cards.map((c, i) => {
    const s = cardStat(c) || { r: 0, w: 0, log: [] };
    return { c, i, s, n: s.r + s.w, status: cardStatus(c) };
  });
  if (deckFilter !== 'all') rows = rows.filter(r => r.status === deckFilter);
  const sorters = {
    order: (a, b) => a.i - b.i,
    hardest: (a, b) => acc(a) - acc(b) || b.s.w - a.s.w,
    most: (a, b) => b.n - a.n || a.i - b.i,
    least: (a, b) => a.n - b.n || a.i - b.i,
    az: (a, b) => byName(cardLabel(a.c), cardLabel(b.c)),
  };
  rows.sort(sorters[deckSort]);

  if (!rows.length) {
    box.innerHTML = `<p class="muted empty-chart">Geen kaarten hier.</p>`;
    return;
  }
  box.innerHTML = `
    <div class="crow chead" aria-hidden="true">
      <span>#</span><span>Kaart</span><span>Gespeeld</span><span>✓ / ✗</span><span>Juist</span><span>Laatste 10</span>
    </div>
    ${rows.map(({ c, i, s, n, status }) => {
      const spelling = lessonOf(c.lessonId)?.type === 'spelling';
      return `
      <div class="crow st-${status}" tabindex="0" role="button" aria-expanded="false" data-i="${i}">
        <span class="cnum">${i + 1}</span>
        <span class="ctext">
          <b>${c.image ? `<img src="${esc(c.image)}" alt="">` : ''}${esc(spelling ? c.back : c.front)}<span class="say-btn small" role="button" tabindex="0" data-say="${i}" aria-label="Voorlezen">🔊</span></b>
          ${spelling ? (c.sentence ? `<span class="cback">${esc(c.sentence)}</span>` : '') : `<span class="cback">${esc(c.back)}</span>`}
          ${t.kind === 'project' ? `<small class="clesson">${esc(lessonOf(c.lessonId)?.name || '')}</small>` : ''}
        </span>
        <span class="cplayed"><b>${n}</b><small>× gespeeld</small></span>
        <span class="crw"><span class="cr">✓ ${s.r}</span><span class="cw">✗ ${s.w}</span></span>
        <span class="cacc">${n ? `${stackBar([{ value: s.r, cls: 's-right', label: '✓ Juist' }, { value: s.w, cls: 's-wrong', label: '✗ Fout' }], { height: 10 })}<small>${Math.round((s.r / n) * 100)}%</small>` : '<small class="muted">nieuw</small>'}</span>
        <span class="clog">${resultDots(s.log)}</span>
      </div>`;
    }).join('')}`;

  box.querySelectorAll('.crow:not(.chead)').forEach(row => {
    const toggle = () => row.setAttribute('aria-expanded', String(row.getAttribute('aria-expanded') !== 'true'));
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', e => { if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } });
  });
  box.querySelectorAll('[data-say]').forEach(btn => {
    const card = cards[+btn.dataset.say];
    const say = e => {
      e.stopPropagation();
      const l = lessonOf(card.lessonId);
      sayAloud(l.type === 'spelling' ? { text: card.back, say: card.say, audio: card.audio } : { text: card.front, say: card.say, audio: card.audio }, l.language);
    };
    btn.addEventListener('click', say);
    btn.addEventListener('keydown', e => { if (e.key === 'Enter') say(e); });
  });
}

/* ---------------------------------------------------------------- progress page */

function renderStats() {
  const allCards = lessons.flatMap(l => l.cards);
  const counts = cardCounts(allCards);
  const days = Object.values(store.activity);
  const answered = days.reduce((n, d) => n + d.n, 0);
  const right = days.reduce((n, d) => n + d.r, 0);
  const minutes = Math.round(days.reduce((n, d) => n + (d.ms || 0), 0) / 60000);
  const daysStudied = days.filter(d => d.n > 0).length;

  const last14 = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - i);
    const a = store.activity[dayString(day)] || { r: 0, n: 0 };
    last14.push({ day, r: a.r, w: a.n - a.r });
  }

  const tricky = allCards
    .map(c => ({ c, s: cardStat(c) }))
    .filter(x => x.s && x.s.r + x.s.w >= 2 && x.s.w > 0)
    .sort((a, b) => a.s.r / (a.s.r + a.s.w) - b.s.r / (b.s.r + b.s.w) || b.s.w - a.s.w)
    .slice(0, 8);

  $app.innerHTML = `
    <button class="back-link" id="backHome">← Alle lessen</button>
    <section class="hero"><div><h1>Mijn voortgang 📊</h1><p>Alles wat je op dit toestel geleerd hebt.</p></div></section>

    <div class="tiles">
      ${tile('Dagen op rij', `🔥 ${currentStreak()}`, `record: ${plural(Math.max(store.streak.best || 0, currentStreak()), 'dag', 'dagen')}`)}
      ${tile('Dagen geleerd', daysStudied, daysStudied ? `sinds ${shortDate(Object.keys(store.activity).sort()[0])}` : 'begin vandaag!')}
      ${tile('Kaarten beantwoord', answered, answered ? `${Math.round((right / answered) * 100)}% juist` : '')}
      ${tile('Tijd geleerd', minutes < 1 && answered ? '< 1 min' : `${minutes} min`)}
      ${tile('Kaarten gekend', `${counts.known}`, `van ${allCards.length}`)}
    </div>

    <section class="panel">
      <h3>Leerkalender</h3>
      <div class="chart-box" id="heatChart"></div>
      <div class="legend heat-legend"><span>Minder</span>${[0, 1, 2, 3, 4].map(i => `<i class="heat-${i}"></i>`).join('')}<span>Meer</span></div>
    </section>

    <section class="panel">
      <h3>Laatste 2 weken</h3>
      <div class="chart-box" id="dayChart"></div>
      ${legend([{ cls: 's-right', label: '✓ Juist' }, { cls: 's-wrong', label: '✗ Fout' }])}
    </section>

    <section class="panel">
      <h3>Lessen</h3>
      <div class="lesson-bars">
        ${projects().map(p => `
          <div class="lb-project">${esc(p.name)}</div>
          ${p.lessons.map(l => {
            const c = cardCounts(l.cards);
            return `<button class="lesson-bar" data-goto="${esc(l.id)}">
              <span class="lb-name">${esc(l.icon)} ${esc(l.name)}</span>
              ${statusBar(c, 12)}
              <span class="lb-pct">${Math.round((c.known / l.cards.length) * 100)}%</span>
            </button>`;
          }).join('')}`).join('')}
      </div>
      ${statusLegend(counts)}
    </section>

    <section class="panel">
      <div class="panel-head">
        <h3>Moeilijkste kaarten</h3>
        ${tricky.length ? '<button class="btn small" id="trickyBtn">🔁 Oefen deze</button>' : ''}
      </div>
      ${tricky.length ? `<div class="tricky">${tricky.map(({ c, s }) => {
        const n = s.r + s.w;
        return `<div class="tricky-row">
          <span class="ctext"><b>${c.image ? `<img src="${esc(c.image)}" alt="">` : ''}${esc(cardLabel(c))}</b><small class="clesson">${esc(lessons.find(l => l.id === c.lessonId)?.name || '')}</small></span>
          <span class="cacc">${stackBar([{ value: s.r, cls: 's-right', label: '✓ Juist' }, { value: s.w, cls: 's-wrong', label: '✗ Fout' }], { height: 10 })}<small>${s.r} van ${n}</small></span>
        </div>`;
      }).join('')}</div>` : '<p class="muted empty-chart">Kaarten die je vaak fout hebt, verschijnen hier.</p>'}
    </section>

    <section class="panel">
      <h3>Reservekopie</h3>
      <p class="muted">Je voortgang wordt in deze browser bewaard. Download een reservekopie om ze veilig te bewaren of naar een ander toestel over te zetten.</p>
      <div class="backup-actions">
        <button class="btn small secondary" id="exportBtn">⬇️ Reservekopie downloaden</button>
        <label class="btn small secondary">⬆️ Reservekopie terugzetten<input type="file" id="importInput" accept=".json,application/json" hidden></label>
      </div>
    </section>`;

  mountChart(document.getElementById('heatChart'), w => heatmapChart(store.activity, w));
  mountChart(document.getElementById('dayChart'), w => dailyBarsChart(last14, w));
  document.getElementById('backHome').addEventListener('click', () => navigate('#/'));
  $app.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => navigate(`#/les/${encodeURIComponent(el.dataset.goto)}`)));
  document.getElementById('trickyBtn')?.addEventListener('click', () => {
    const deck = tricky.map(x => x.c);
    const ids = new Set(deck.map(c => c.lessonId));
    openSetup({ key: 'tricky', title: 'Moeilijkste kaarten', subtitle: 'Uit al je lessen', lessons: lessons.filter(l => ids.has(l.id)), deck, backLabel: 'Terug naar mijn voortgang' });
  });
  document.getElementById('exportBtn').addEventListener('click', () => saveFile(
    `studyblue-voortgang-${dayString()}.json`,
    JSON.stringify({ app: 'studyblue', version: 1, exported: new Date().toISOString(), data: store }, null, 1),
  ));
  document.getElementById('importInput').addEventListener('change', e => importProgress(e.target.files[0]));
}

async function importProgress(file) {
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const data = backup?.data;
    if (backup?.app !== 'studyblue' || !data || typeof data.lessons !== 'object') throw new Error('Dit is geen StudyBlue-reservekopie.');
    const when = backup.exported ? new Date(backup.exported).toLocaleString(LOCALE) : 'een onbekende datum';
    if (!confirm(`De voortgang op dit toestel vervangen door de reservekopie van ${when}?`)) return;
    const base = defaultStore();
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, base, data, { prefs: { ...base.prefs, ...data.prefs }, streak: { ...base.streak, ...data.streak } });
    saveStore();
    updateTopbar();
    toast('✅ Voortgang teruggezet!');
    renderStats();
  } catch (e) {
    alert(`Terugzetten mislukt: ${e.message}`);
  }
}

/* ---------------------------------------------------------------- setup dialog */

function closeDialog() {
  document.querySelector('.overlay')?.remove();
}

const MAX_TYPE_LEN = 40;
const shortAnswers = cards => cards.every(c => c.length <= MAX_TYPE_LEN);

function openSetup(target) {
  closeDialog();
  const cards = target.deck || target.lessons.flatMap(l => l.cards);
  const missed = cards.filter(c => cardStat(c)?.last === 0);
  const spelling = target.lessons.every(l => l.type === 'spelling');
  const lang = target.lessons[0]?.language || CONFIG.speechLang;
  const canQuiz = new Set(cards.map(c => c.back)).size >= 2 || cards.some(c => c.wrong.length);
  const prefs = store.prefs;
  let mode = spelling ? 'type' : prefs.mode;
  let reverse = spelling ? false : prefs.reverse;
  const typeOk = rev => spelling || shortAnswers(cards.map(c => (rev ? c.front : c.back)));
  const noVoice = speech.available && !speech.hasVoice(lang);

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="setupTitle">
      <h2 id="setupTitle">${esc(target.title)}</h2>
      <p class="sub">${esc(target.subtitle)} · ${plural(cards.length, 'kaart', 'kaarten')}</p>
      <div class="mode-pick">
        <button class="mode" data-mode="cards"><span class="emoji">🃏</span><b>Kaarten</b><small>${spelling ? 'Luister, schrijf op papier, draai om' : 'Draai om en controleer jezelf'}</small></button>
        <button class="mode" data-mode="quiz" ${canQuiz ? '' : 'disabled'}><span class="emoji">✅</span><b>Meerkeuze</b><small>Kies het juiste antwoord</small></button>
        <button class="mode" data-mode="type"><span class="emoji">⌨️</span><b>Typen</b><small id="typeNote">${spelling ? 'Luister en typ het woord' : 'Typ het antwoord'}</small></button>
      </div>
      <label class="option"><span>Kaarten schudden</span>
        <span class="switch"><input type="checkbox" id="optShuffle" ${prefs.shuffle ? 'checked' : ''}><span></span></span></label>
      ${spelling ? '' : `<label class="option"><span>Eerst de achterkant<small>Toon het antwoord, raad de voorkant</small></span>
        <span class="switch"><input type="checkbox" id="optReverse" ${reverse ? 'checked' : ''}><span></span></span></label>`}
      ${speech.available && !spelling ? `<label class="option"><span>Automatisch voorlezen<small>Lees elke vraag hardop voor</small></span>
        <span class="switch"><input type="checkbox" id="optSpeak" ${prefs.autoSpeak ? 'checked' : ''}><span></span></span></label>` : ''}
      <label class="option"><span>Alleen kaarten die ik fout had<small>${missed.length ? `${plural(missed.length, 'kaart', 'kaarten')} om te oefenen` : 'Nog niets fout — goed zo!'}</small></span>
        <span class="switch"><input type="checkbox" id="optMissed" ${missed.length ? '' : 'disabled'}><span></span></span></label>
      ${spelling && !speech.available ? '<p class="warn">⚠️ Deze browser kan niet voorlezen. Probeer Safari of Chrome.</p>' : ''}
      ${spelling && noVoice ? '<p class="warn">⚠️ Er is geen Nederlandse stem gevonden op dit toestel. Op een iPhone: Instellingen › Toegankelijkheid › Gesproken materiaal › Stemmen › Nederlands.</p>' : ''}
      <div class="dialog-actions">
        <button class="btn secondary" id="cancelBtn">Terug</button>
        <button class="btn" id="startBtn">Starten! 🚀</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const modeBtns = overlay.querySelectorAll('[data-mode]');
  const reverseBox = overlay.querySelector('#optReverse');
  const paint = () => {
    const typeBtn = overlay.querySelector('[data-mode="type"]');
    typeBtn.disabled = !typeOk(reverse);
    overlay.querySelector('#typeNote').textContent = typeBtn.disabled
      ? (typeOk(!reverse) ? `Kan met “Eerst de ${reverse ? 'voorkant' : 'achterkant'}”` : 'Alleen voor korte antwoorden')
      : (spelling ? 'Luister en typ het woord' : 'Typ het antwoord');
    if (mode === 'type' && typeBtn.disabled) mode = 'cards';
    if (mode === 'quiz' && !canQuiz) mode = 'cards';
    modeBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  };
  paint();
  modeBtns.forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; paint(); }));
  reverseBox?.addEventListener('change', () => { reverse = reverseBox.checked; paint(); });
  overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog(); });
  overlay.querySelector('#cancelBtn').addEventListener('click', closeDialog);
  overlay.querySelector('#startBtn').addEventListener('click', () => {
    speech.unlock();
    const shuffleOn = overlay.querySelector('#optShuffle').checked;
    const autoSpeak = spelling || !!overlay.querySelector('#optSpeak')?.checked;
    const onlyMissed = overlay.querySelector('#optMissed').checked;
    if (!spelling) store.prefs = { ...store.prefs, mode, shuffle: shuffleOn, reverse, autoSpeak };
    else store.prefs.shuffle = shuffleOn;
    saveStore();
    closeDialog();
    startSession({ ...target, mode, reverse, autoSpeak, spelling, lang, shuffle: shuffleOn, practice: onlyMissed, deck: onlyMissed ? missed : cards });
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
    lastT: Date.now(),
  };
  if (location.hash !== '#/oefenen') location.hash = '#/oefenen';
  renderStudyFrame();
}

function sideOf(card, side) {
  // side: 'q' (question) or 'a' (answer), taking "eerst de achterkant" into account
  const front = { text: card.front, image: card.image, audio: card.audio, say: card.say };
  const back = { text: card.back, image: card.backImage, audio: card.backAudio, say: '' };
  return (side === 'q') !== session.reverse ? front : back;
}

const MODE_NAMES = { cards: 'Kaarten', quiz: 'Meerkeuze', type: 'Typen' };

function renderStudyFrame() {
  const s = session;
  $app.innerHTML = `
    <div class="study-top">
      <button class="close-btn" id="quitBtn" aria-label="Stoppen">✕</button>
      <div class="title"><h2>${esc(s.title)}</h2><small>${MODE_NAMES[s.mode]}${s.practice ? ' · foute kaarten oefenen' : ''}</small></div>
    </div>
    <div class="scorebar">
      <div class="progress" aria-hidden="true"><div class="ok" id="pOk"></div><div class="bad" id="pBad"></div></div>
      <div class="tally"><span class="r" title="Juist">✓ <b id="tRight">0</b></span><span class="w" title="Fout">✗ <b id="tWrong">0</b></span></div>
    </div>
    <div class="counter" id="counter"></div>
    <div id="stage"></div>`;
  document.getElementById('quitBtn').addEventListener('click', quitSession);
  updateScore();
  showCard();
}

function showCard() {
  const s = session;
  if (s.mode === 'quiz') renderQuizQuestion();
  else if (s.mode === 'type') renderTypeQuestion();
  else renderFlashcard();
  if (s.autoSpeak) {
    const q = sideOf(s.deck[s.i], 'q');
    setTimeout(() => { if (session === s) sayAloud(q, s.lang, s.spelling); }, 250);
  }
}

function updateScore() {
  const s = session;
  const total = s.deck.length;
  document.getElementById('pOk').style.width = `${(s.right / total) * 100}%`;
  document.getElementById('pBad').style.width = `${(s.wrong / total) * 100}%`;
  document.getElementById('tRight').textContent = s.right;
  document.getElementById('tWrong').textContent = s.wrong;
  document.getElementById('counter').textContent = `Kaart ${Math.min(s.i + 1, total)} van ${total}`;
}

function confirmQuit() {
  const midway = session && session.results.length && session.i < session.deck.length;
  return !midway || confirm('Wil je stoppen? Wat je al gedaan hebt, is bewaard.');
}

function quitSession() {
  if (confirmQuit()) leaveStudy();
}

// The study screen is always entered from another page, so "back" returns there.
function leaveStudy() {
  session = null;
  speech.stop();
  history.back();
}

function record(ok) {
  const s = session;
  const card = s.deck[s.i];
  s.results.push({ card, ok });
  ok ? s.right++ : s.wrong++;
  const st = statsFor(card.lessonId, true);
  const c = st.cards[card.key] || (st.cards[card.key] = { r: 0, w: 0, last: null });
  ok ? c.r++ : c.w++;
  c.last = ok ? 1 : 0;
  c.log = [...(c.log || []), c.last].slice(-10);
  c.t = Date.now();
  if (ok) store.xp++;
  logActivity(ok, Math.min(60000, c.t - s.lastT));
  s.lastT = c.t;
  bumpStreak();
  saveStore();
  updateTopbar();
  updateScore();
  ok ? sfx.right() : sfx.wrong();

  const streak = streakOfRight();
  if (ok && streak > 0 && streak % 5 === 0) toast(`🔥 ${streak} juist op rij!`);
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
  showCard();
}

// A face shows text and/or a picture; a face with only sound gets a big listen button.
function faceHtml(side, label, extra = '') {
  const long = side.text.length > 90;
  const listenOnly = !side.text && !side.image && (side.say || side.audio);
  const canSay = speech.available || side.audio;
  return `
    <span class="label">${label}</span>
    ${listenOnly ? `<button class="listen-btn" data-say-side="1" aria-label="Luister">🔊</button><span class="listen-cap">Luister en schrijf het woord</span>` : ''}
    ${side.image ? `<img src="${esc(side.image)}" alt="" draggable="false">` : ''}
    ${side.text ? `<div class="text${long ? ' long' : ''}">${esc(side.text)}</div>` : ''}
    ${!listenOnly && side.text && canSay ? '<button class="say-btn" data-say-side="1" aria-label="Voorlezen">🔊</button>' : ''}
    ${extra}`;
}

function bindSay(container, side, lang, slow) {
  container.querySelectorAll('[data-say-side]').forEach(b => {
    b.addEventListener('pointerdown', e => e.stopPropagation());
    b.addEventListener('click', e => { e.stopPropagation(); sayAloud(side, lang, slow); });
  });
}

function sentenceBtn(card) {
  return card.sentence ? '<button class="hint-btn" data-sentence="1">💬 Zin voorlezen</button>' : '';
}

function bindSentence(container, card, lang) {
  container.querySelectorAll('[data-sentence]').forEach(b => {
    b.addEventListener('pointerdown', e => e.stopPropagation());
    b.addEventListener('click', e => { e.stopPropagation(); speech.speak(card.sentence, lang, 0.85); });
  });
}

/* ---------------------------------------------------------------- flashcards */

function renderFlashcard() {
  const s = session;
  const card = s.deck[s.i];
  const q = sideOf(card, 'q');
  const a = sideOf(card, 'a');
  const hint = card.hint && !s.reverse ? `<button class="hint-btn" id="hintBtn">💡 Toon tip</button>` : '';
  const stage = document.getElementById('stage');
  stage.innerHTML = `
    <div class="card-stage">
      <div class="flashcard enter" id="card" role="button" tabindex="0" aria-label="Flashcard, druk op spatie om om te draaien">
        <div class="face front">${faceHtml(q, s.reverse ? 'Antwoord' : 'Vraag', hint + sentenceBtn(card))}<span class="tap">Tik om om te draaien ↻</span></div>
        <div class="face back">${faceHtml(a, s.reverse ? 'Vraag' : (s.spelling ? 'Zo schrijf je het' : 'Antwoord'))}<span class="tap">Wist je het?</span></div>
      </div>
    </div>
    <div class="answer-row">
      <button class="btn red" id="wrongBtn" disabled>✗ Wist ik niet</button>
      <button class="btn green" id="rightBtn" disabled>✓ Wist ik!</button>
    </div>
    <p class="keys"><kbd>Spatie</kbd> omdraaien · <kbd>←</kbd> wist ik niet · <kbd>→</kbd> wist ik · of veeg</p>`;

  const el = document.getElementById('card');
  bindSay(el.querySelector('.front'), q, s.lang, s.spelling);
  bindSay(el.querySelector('.back'), a, s.lang);
  bindSentence(el, card, s.lang);
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
    else if (e.key.toLowerCase() === 'l') sayAloud(s.flipped ? a : q, s.lang);
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
  const correct = sideOf(card, 'a').text;
  const seen = new Set([correct.trim().toLowerCase()]);
  const out = [];
  const add = t => {
    const k = String(t).trim().toLowerCase();
    if (!k || seen.has(k) || out.length >= 3) return;
    seen.add(k);
    out.push(String(t));
  };
  // A card with its own wrong answers only uses those (e.g. "gewerveld" vs "ongewerveld")
  if (!s.reverse && card.wrong.length) {
    shuffle(card.wrong).forEach(add);
    return shuffle([correct, ...out]).map(text => ({ text, correct: text === correct }));
  }
  const sameLesson = shuffle(s.pool.filter(c => c !== card && c.lessonId === card.lessonId));
  const others = shuffle(s.pool.filter(c => c !== card && c.lessonId !== card.lessonId));
  [...sameLesson, ...others].forEach(c => add(sideOf(c, 'a').text));
  return shuffle([correct, ...out]).map(text => ({ text, correct: text === correct }));
}

function questionHtml(q, card, label) {
  const listenOnly = !q.text && !q.image;
  return `
    <div class="quiz-q enter-q">
      <span class="label">${label}</span>
      ${listenOnly ? '<button class="listen-btn" data-say-side="1" aria-label="Luister">🔊</button>' : ''}
      ${q.image ? `<img src="${esc(q.image)}" alt="">` : ''}
      ${q.text ? `<div class="text">${esc(q.text)}${speech.available || q.audio ? ' <button class="say-btn inline" data-say-side="1" aria-label="Voorlezen">🔊</button>' : ''}</div>` : ''}
      <div class="q-extras">
        ${card.hint && !session.reverse ? `<button class="hint-btn" id="hintBtn">💡 Toon tip</button>` : ''}
        ${sentenceBtn(card)}
      </div>
    </div>`;
}

function renderQuizQuestion() {
  const s = session;
  const card = s.deck[s.i];
  const q = sideOf(card, 'q');
  const choices = buildChoices(card);
  const stage = document.getElementById('stage');
  stage.innerHTML = `
    ${questionHtml(q, card, s.spelling ? 'Welk woord hoor je?' : (s.reverse ? 'Wat hoort hierbij?' : 'Vraag'))}
    <div class="choices">
      ${choices.map((c, i) => `<button class="choice" data-i="${i}"><span class="key">${i + 1}</span><span>${esc(c.text)}</span></button>`).join('')}
    </div>
    <div class="quiz-next" id="quizNext"></div>
    <p class="keys"><kbd>1</kbd>–<kbd>${choices.length}</kbd> kiezen · <kbd>Enter</kbd> volgende</p>`;

  bindSay(stage, q, s.lang, s.spelling);
  bindSentence(stage, card, s.lang);
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
      nextBox.innerHTML = `<button class="btn" id="nextBtn">Volgende →</button>`;
      document.getElementById('nextBtn').addEventListener('click', next);
      document.getElementById('nextBtn').focus();
    }
  };
  btns.forEach((b, i) => b.addEventListener('click', () => choose(i)));

  keyHandler = e => {
    if (/^[1-9]$/.test(e.key)) choose(+e.key - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && answered && !session.busy) { e.preventDefault(); next(); }
    else if (e.key.toLowerCase() === 'h') hintBtn?.click();
    else if (e.key.toLowerCase() === 'l') sayAloud(q, s.lang, s.spelling);
    else if (e.key === 'Escape') quitSession();
  };
}

/* ---------------------------------------------------------------- typing */

const normAnswer = (t, dropArticle) => {
  let s = String(t).toLowerCase().replace(/[’‘`´]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').trim();
  if (dropArticle) s = s.replace(/^(de|het|een|'t) /, '');
  return s;
};

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

// Highlights the part that differs between what was typed and the right answer.
function diffHtml(typed, correct) {
  let p = 0;
  while (p < typed.length && p < correct.length && typed[p].toLowerCase() === correct[p].toLowerCase()) p++;
  let sfx = 0;
  while (sfx < typed.length - p && sfx < correct.length - p
    && typed[typed.length - 1 - sfx].toLowerCase() === correct[correct.length - 1 - sfx].toLowerCase()) sfx++;
  const mark = (t, cls) => `${esc(t.slice(0, p))}<mark class="${cls}">${esc(t.slice(p, t.length - sfx)) || '&nbsp;'}</mark>${esc(t.slice(t.length - sfx))}`;
  return { typed: mark(typed, 'bad'), correct: mark(correct, 'good') };
}

function renderTypeQuestion() {
  const s = session;
  const card = s.deck[s.i];
  const q = sideOf(card, 'q');
  const answer = sideOf(card, 'a').text;
  const stage = document.getElementById('stage');

  // The input stays in place between cards so the iPhone keyboard doesn't close.
  if (!document.getElementById('typeInput')) {
    stage.innerHTML = `
      <div id="typeQ"></div>
      <form class="type-form" id="typeForm" autocomplete="off">
        <input id="typeInput" class="type-input" type="text" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="${s.spelling ? 'Typ het woord…' : 'Typ je antwoord…'}" aria-label="Jouw antwoord">
        <button class="btn" id="checkBtn" type="submit">Controleer</button>
      </form>
      <div class="type-feedback" id="typeFeedback" aria-live="polite"></div>
      <div class="type-actions" id="typeActions"><button class="link-btn" id="dontKnow" type="button">Ik weet het niet</button></div>
      <p class="keys"><kbd>Enter</kbd> controleren · <kbd>Enter</kbd> volgende</p>`;
  }
  const qBox = document.getElementById('typeQ');
  const input = document.getElementById('typeInput');
  const form = document.getElementById('typeForm');
  const feedback = document.getElementById('typeFeedback');
  const actions = document.getElementById('typeActions');
  qBox.innerHTML = questionHtml(q, card, s.spelling ? 'Luister en typ het woord' : (s.reverse ? 'Antwoord' : 'Vraag'));
  bindSay(qBox, q, s.lang, s.spelling);
  bindSentence(qBox, card, s.lang);
  const hintBtn = document.getElementById('hintBtn');
  hintBtn?.addEventListener('click', () => { hintBtn.outerHTML = `<div class="hint-text">💡 ${esc(card.hint)}</div>`; });

  input.value = '';
  input.disabled = false;
  input.className = 'type-input';
  feedback.innerHTML = '';
  actions.innerHTML = '<button class="link-btn" id="dontKnow" type="button">Ik weet het niet</button>';
  document.getElementById('checkBtn').textContent = 'Controleer';
  input.focus({ preventScroll: true });

  let state = 'answering'; // → 'wrong' (waiting for "volgende")
  const goNext = () => { if (session === s && s.deck[s.i] === card) next(); };

  const showWrong = (typed, title) => {
    state = 'wrong';
    input.classList.add('is-wrong');
    const d = typed ? diffHtml(typed, answer) : null;
    feedback.innerHTML = `
      <div class="fb wrong">
        <b>${title}</b>
        ${d ? `<div class="fb-row"><small>Jij typte</small><span class="fb-word">${d.typed}</span></div>` : ''}
        <div class="fb-row"><small>Juist is</small><span class="fb-word">${d ? d.correct : esc(answer)}</span>
          ${speech.available ? '<button class="say-btn inline" id="sayAnswer" type="button" aria-label="Voorlezen">🔊</button>' : ''}</div>
      </div>`;
    document.getElementById('sayAnswer')?.addEventListener('click', () => speech.speak(answer, s.lang, 0.8));
    actions.innerHTML = s.spelling ? '' : '<button class="link-btn" id="overrule" type="button">Ik had het toch goed</button>';
    document.getElementById('overrule')?.addEventListener('click', () => {
      // undo the wrong answer and count it as right
      const st = statsFor(card.lessonId).cards[card.key];
      st.w--; st.r++; st.last = 1; st.log[st.log.length - 1] = 1;
      s.wrong--; s.right++; s.results[s.results.length - 1].ok = true;
      store.xp++;
      const day = store.activity[dayString()];
      if (day) day.r++;
      saveStore(); updateTopbar(); updateScore();
      goNext();
    });
    document.getElementById('checkBtn').textContent = 'Volgende →';
  };

  const check = () => {
    if (state === 'wrong') { goNext(); return; }
    if (state !== 'answering') return;
    const typed = input.value.trim();
    if (!typed) { input.focus(); return; }
    // "de"/"het" may be left out, and a part between brackets is optional
    const a = normAnswer(typed, true);
    const b = normAnswer(answer, true);
    const bShort = normAnswer(answer.replace(/\s*\([^)]*\)/g, ''), true);
    if (a === b || (bShort && a === bShort)) {
      state = 'done';
      input.classList.add('is-right');
      feedback.innerHTML = `<div class="fb right"><b>${pickRandom(['Juist! 🎉', 'Super! ⭐', 'Helemaal goed! ✨', 'Knap! 👏'])}</b></div>`;
      actions.innerHTML = '';
      record(true);
      setTimeout(goNext, 900);
      return;
    }
    record(false);
    const close = editDistance(a, b) <= Math.max(1, Math.floor(b.length / 6));
    showWrong(typed, close ? 'Bijna! Let op de spelling.' : 'Niet juist.');
  };

  form.onsubmit = e => { e.preventDefault(); check(); };
  actions.onclick = e => {
    if (e.target.id === 'dontKnow' && state === 'answering') { record(false); showWrong('', 'Geen probleem, zo schrijf je het:'); }
  };
  keyHandler = e => {
    if (e.key === 'Escape') quitSession();
  };
}

/* ---------------------------------------------------------------- results */

const MESSAGES = {
  perfect: ['PERFECT! Je had alles juist! 🏆', 'Foutloos! Jij bent een ster! 🌟', '100%! Wat een knappe kop! 🔥'],
  3: ['Fantastisch! Jij kent dit echt!', 'Super! Bijna perfect!', 'Schitterend gedaan — top!'],
  2: ['Goed gedaan! Je bent goed op weg!', 'Mooi werk! Nog een beetje oefenen en je kent het!', 'Knap — doe zo verder!'],
  1: ['Goed geprobeerd! Oefen de foute kaarten en probeer opnieuw.', 'Je bent aan het leren! Elke keer word je sterker. 💪', 'Mooie start! Laten we de moeilijke oefenen.'],
  0: ['Elke kampioen is ooit begonnen. Probeer nog eens! 🌱', 'Leren vraagt oefening — jij kan dit!', 'Niet opgeven! Bekijk de kaarten en probeer opnieuw.'],
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
    st.sessions = [...st.sessions, { t: Date.now(), pct, right: s.right, total, mode: s.mode }].slice(-60);
    tries = scorePoints(st);
  }
  saveStore();
  updateTopbar();

  const trophy = perfect ? '🏆' : stars === 3 ? '🥇' : stars === 2 ? '🎉' : stars === 1 ? '💪' : '🌱';
  const headline = perfect ? 'Perfect!' : stars === 3 ? 'Super!' : stars === 2 ? 'Goed gedaan!' : stars === 1 ? 'Goed geprobeerd!' : 'Blijf oefenen!';
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
          <div class="center"><div><div class="pct" id="pctNum">0%</div><small>juist</small></div></div>
        </div>
        <div class="stat-list">
          <div class="stat"><span class="dot" style="background:var(--green)"></span><b>${s.right}</b><span>wist ik</span></div>
          <div class="stat"><span class="dot" style="background:var(--red)"></span><b>${s.wrong}</b><span>nog aan het leren</span></div>
          <div class="stat"><span class="dot" style="background:var(--blue)"></span><b>${total}</b><span>${total === 1 ? 'kaart' : 'kaarten'} geoefend</span></div>
          <div class="stat"><span class="dot" style="background:var(--gold)"></span><b>${currentStreak()}</b><span>${currentStreak() === 1 ? 'dag' : 'dagen'} op rij 🔥</span></div>
          ${newBest ? '<div><span class="badge-new">🎖️ Nieuw record!</span></div>' : ''}
        </div>
      </div>

      ${tries.length > 1 ? `
        <div class="history">
          <h3>📈 Je scores tot nu toe</h3>
          <div class="chart-box" id="resultChart"></div>
        </div>` : ''}

      ${missed.length ? `
        <div class="missed">
          <h3>📝 Deze nog oefenen (${missed.length})</h3>
          <ul>${missed.map(c => `<li><b>${c.image ? `<img src="${esc(c.image)}" alt="">` : ''}${esc(cardLabel(c))}</b><span>${s.spelling ? esc(c.sentence) : esc(c.back || '🖼️')}</span></li>`).join('')}</ul>
        </div>` : ''}

      <div class="result-actions">
        ${missed.length ? `<button class="btn red" id="practiceBtn">🔁 Oefen ${plural(missed.length, 'foute kaart', 'foute kaarten')}</button>` : ''}
        <button class="btn" id="againBtn">↻ Opnieuw</button>
        <button class="btn secondary" id="homeBtn2">← ${esc(s.backLabel || 'Terug naar de les')}</button>
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
  if (tries.length > 1) mountChart(document.getElementById('resultChart'), w => scoreLineChart(tries, w));

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
  document.getElementById('homeBtn2').addEventListener('click', leaveStudy);
  keyHandler = e => { if (e.key === 'Enter') document.getElementById(missed.length ? 'practiceBtn' : 'againBtn').click(); else if (e.key === 'Escape') leaveStudy(); };
}

/* ---------------------------------------------------------------- boot */

document.addEventListener('keydown', e => {
  if (e.target.matches?.('input, textarea, select')) { if (e.key !== 'Escape') return; }
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  keyHandler?.(e);
});

const goTo = hash => () => { if (confirmQuit()) navigate(hash); };
document.getElementById('homeBtn').addEventListener('click', goTo('#/'));
document.getElementById('statsBtn').addEventListener('click', goTo('#/voortgang'));
document.getElementById('streakPill').addEventListener('click', goTo('#/voortgang'));
document.getElementById('xpPill').addEventListener('click', goTo('#/voortgang'));
document.getElementById('soundBtn').addEventListener('click', () => {
  store.sound = !store.sound;
  saveStore();
  updateTopbar();
  sfx.right();
});

// The installed iPhone app can stay open for days: fetch new lessons when it comes back.
let hiddenAt = 0;
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > 10 * 60e3 && !session && !location.hash.startsWith('#/maken')) {
    await loadLessons();
    route();
  }
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

(async () => {
  updateTopbar();
  await loadLessons();
  route();
})();
