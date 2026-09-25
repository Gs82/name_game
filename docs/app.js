// Roll Call: website version (GitHub Pages + Firebase).
// Photos and names are encrypted in the organizer's browser with a key derived
// from the class passcode, so the database only ever holds ciphertext.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { FIREBASE_CONFIG, ORGANIZER_EMAILS } from './config.js';

// ================= Encryption =================
const enc = new TextEncoder(), dec = new TextDecoder();
const CHECK = 'roll-call-ok';
const PBKDF2_ITERATIONS = 250000;
let classKey = null, cryptoMeta = null;

function b64(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
const normPass = pass => pass.normalize('NFKC').trim().toLowerCase();

async function deriveKey(pass, saltB64, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normPass(pass)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// AES-GCM; stored as base64(iv || ciphertext)
async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64(out);
}
async function openSealed(key, str) {
  const u = unb64(str);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, key, u.subarray(12)));
}

// The passcode is remembered in this browser only, so players don't retype it
const passKey = () => 'rollcall-pass-' + (FIREBASE_CONFIG.projectId || '');
function rememberPass(v) { try { localStorage.setItem(passKey(), v); } catch {} }
function recallPass() { try { return localStorage.getItem(passKey()); } catch { return null; } }
function forgetPass() { try { localStorage.removeItem(passKey()); } catch {} }

  const $ = id => document.getElementById(id);
  const photoUrl = p => p.url;

  let db = null, auth = null, me = null;
  let myId = null, isAdmin = false;
  let roster = [];            // [{id, name, url}], decrypted in the browser
  let config = null;          // {startsAt, endsAt, prize}
  let scores = [];            // [{id, correct, total, ms, achievedAt, attempts}]
  let saveBlocked = false;

  // ================= Helpers =================
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function fmtTime(ms) {
    const t = Math.max(0, Math.round(ms / 100));
    const m = Math.floor(t / 600), s = Math.floor((t % 600) / 10), d = t % 10;
    return `${m}:${String(s).padStart(2, '0')}.${d}`;
  }
  const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function toLocalInput(ms) {
    const d = new Date(ms), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function nameFromFile(filename) {
    let n = filename.replace(/\.[^.]+$/, '');
    n = n.replace(/\s*\(\d+\)\s*$/, '').replace(/^\d+[\s._-]+/, '');
    n = n.replace(/[_.]+/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    if (n === n.toLowerCase() || n === n.toUpperCase()) n = n.toLowerCase().replace(/(^|\s|')\p{L}/gu, c => c.toUpperCase());
    return n;
  }
  function normalize(s) {
    return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function editDistance(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    return dp[a.length][b.length];
  }
  function checkGuess(guess, name) {
    const g = normalize(guess), t = normalize(name);
    if (!g) return false;
    if (g === t) return 'exact';
    const allowed = t.length <= 4 ? 0 : t.length <= 8 ? 1 : 2;
    return editDistance(g, t) <= allowed ? 'close' : false;
  }
  function show(section) {
    for (const s of ['gate', 'home', 'game', 'result']) $(s).hidden = s !== section;
    if (isAdmin) $('orgBar').hidden = section !== 'home';
    if (section !== 'game') { $('game').classList.remove('pulse', 'redline'); $('game').style.setProperty('--alt', 0); $('game').style.setProperty('--shake', 0); }
    window.scrollTo(0, 0);
  }
  // Better = higher accuracy, then faster, then earlier
  function better(a, b) {
    if (!b) return true;
    const pa = a.correct / a.total, pb = b.correct / b.total;
    if (pa !== pb) return pa > pb;
    if (a.ms !== b.ms) return a.ms < b.ms;
    return a.achievedAt < b.achievedAt;
  }
  function ranked() {
    return scores.filter(s => s.total > 0).slice().sort((a, b) => better(a, b) ? -1 : 1);
  }
  function windowState() {
    const now = Date.now();
    if (!config || !config.startsAt || !config.endsAt) return 'open';
    if (now < config.startsAt) return 'before';
    if (now > config.endsAt) return 'over';
    return 'open';
  }

  // ================= Rendering =================
  function renderWindow() {
    const st = windowState(), chip = $('windowChip');
    chip.classList.toggle('live', st === 'open');
    chip.classList.toggle('over', st === 'over');
    let text = 'Open';
    if (config && config.startsAt && config.endsAt) {
      if (st === 'before') text = 'Starts ' + dateFmt.format(config.startsAt);
      else if (st === 'over') text = 'Challenge over';
      else {
        const left = config.endsAt - Date.now();
        const d = Math.floor(left / 864e5), h = Math.floor(left % 864e5 / 36e5), m = Math.floor(left % 36e5 / 6e4);
        text = d > 0 ? `${d} day${d === 1 ? '' : 's'} ${h} hr left` : h > 0 ? `${h} hr ${m} min left` : `${m} min left`;
      }
    } else if (!db) {
      text = 'Offline';
    }
    $('windowText').textContent = text;
    const prize = config && config.prize;
    $('prizeLine').hidden = !prize;
    if (prize) {
      $('prizeLine').textContent = st === 'over' ? 'Winner takes ' : 'Prize: ';
      const s = document.createElement('strong');
      s.textContent = prize;
      $('prizeLine').append(s);
    }
    $('boardTitle').textContent = st === 'over' ? 'Final standings' : 'Standings';
    renderPlayCard();
  }

  function renderPlayCard() {
    const n = roster.length, st = windowState();
    $('factCount').textContent = n || '–';
    const mine = scores.find(s => s.id === myId);
    $('factBest').textContent = mine ? `${mine.correct}/${mine.total}` : '–';
    const idx = ranked().findIndex(s => s.id === myId);
    $('factRank').textContent = idx >= 0 ? '#' + (idx + 1) : '–';

    let hint = '';
    if (!db) hint = '';
    else if (n < 2) hint = 'Waiting for the organizer to add class photos.';
    else if (st === 'before') hint = 'Ranked runs open ' + dateFmt.format(config.startsAt) + '.';
    else if (st === 'over') hint = 'The challenge has ended. Practice is still open.';
    else if (mine) hint = `Best time ${fmtTime(mine.ms)} · ${mine.attempts || 1} run${(mine.attempts || 1) === 1 ? '' : 's'}`;
    $('rankedHint').textContent = hint;
    $('rankedBtn').disabled = !db || n < 2 || st !== 'open';
    $('practiceBtn').disabled = n < 2;
  }

  let boardToken = 0;
  async function renderBoard() {
    const token = ++boardToken;
    const list = ranked();
    if (token !== boardToken) return;
    const over = windowState() === 'over';
    const ol = $('board');
    ol.innerHTML = '';
    list.forEach((s, i) => {
      const p = { name: s.name, avatarUrl: s.photo };
      const li = document.createElement('li');
      if (s.id === myId) li.classList.add('me');
      if (i === 0) li.classList.add('first');

      const rank = document.createElement('span');
      rank.className = 'rank'; rank.textContent = i + 1;
      const img = document.createElement('img');
      img.alt = ''; img.referrerPolicy = 'no-referrer'; if (p.avatarUrl) img.src = p.avatarUrl; else img.style.visibility = 'hidden';
      const who = document.createElement('div');
      who.className = 'who';
      const n = document.createElement('div');
      n.className = 'n';
      n.textContent = (p.name || 'Classmate') + (s.id === myId ? ' (you)' : '');
      if (i === 0) {
        const b = document.createElement('span');
        b.className = 'badge'; b.textContent = over ? 'Winner' : 'Leading';
        n.append(b);
      }
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${s.attempts || 1} run${(s.attempts || 1) === 1 ? '' : 's'}`;
      who.append(n, sub);
      const sc = document.createElement('div');
      sc.className = 'score';
      const a = document.createElement('div'); a.className = 'a'; a.textContent = `${s.correct}/${s.total}`;
      const t = document.createElement('div'); t.className = 't'; t.textContent = fmtTime(s.ms);
      sc.append(a, t);
      li.append(rank, img, who, sc);
      ol.append(li);
    });
    $('boardEmpty').hidden = list.length > 0;
    $('boardCount').textContent = list.length ? `${list.length} player${list.length === 1 ? '' : 's'}` : '';
    renderPlayCard();
  }

  // ================= Organizer =================
  function renderRoster() {
    if (!isAdmin) return;
    const wrap = $('roster');
    const focused = document.activeElement && document.activeElement.dataset.personId;
    wrap.innerHTML = '';
    for (const p of roster) {
      const fig = document.createElement('div');
      fig.className = 'person';
      const img = document.createElement('img');
      img.src = photoUrl(p); img.alt = p.name; img.loading = 'lazy';
      const input = document.createElement('input');
      input.type = 'text'; input.value = p.name; input.id = 'name-' + p.id;
      input.dataset.personId = p.id;
      input.setAttribute('aria-label', 'Name');
      input.onchange = async () => {
        const v = input.value.trim();
        if (!v || v === p.name) { input.value = p.name; return; }
        try { await updateDoc(doc(db, 'roster', p.id), { name: await seal(classKey, enc.encode(v)) }); }
        catch (e) { input.value = p.name; $('uploadStatus').textContent = "Couldn't rename: " + e.message; }
      };
      const del = document.createElement('button');
      del.className = 'danger'; del.textContent = 'Remove';
      del.onclick = async () => {
        if (!del.classList.contains('armed')) {
          del.classList.add('armed'); del.textContent = 'Confirm remove';
          setTimeout(() => { del.classList.remove('armed'); del.textContent = 'Remove'; }, 4000);
          return;
        }
        del.disabled = true;
        try {
          await deleteDoc(doc(db, 'roster', p.id));
        } catch (e) { del.disabled = false; $('uploadStatus').textContent = "Couldn't remove: " + e.message; }
      };
      fig.append(img, input, del);
      wrap.append(fig);
    }
    if (focused) { const el = document.querySelector(`[data-person-id="${focused}"]`); if (el) el.focus(); }
  }

  async function resizeToJpeg(file) {
    const bmp = await createImageBitmap(file);
    const max = 640, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode failed')), 'image/jpeg', 0.82));
  }

  let uploading = false;
  async function uploadFiles(fileList) {
    if (!isAdmin || !db || !classKey) { $('uploadStatus').textContent = 'Only the organizer can add photos.'; return; }
    if (uploading) return;
    const files = [...fileList].filter(f => /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i.test(f.name) || (f.type || '').startsWith('image/'));
    if (!files.length) { $('uploadStatus').textContent = 'No photos found. Use JPG, PNG, WebP or HEIC files.'; return; }
    uploading = true;
    const existing = new Set(roster.map(p => normalize(p.name)));
    const skipped = [], failed = [];
    let done = 0;
    for (const f of files) {
      const name = nameFromFile(f.name);
      $('uploadStatus').textContent = `Uploading ${done + 1} of ${files.length}: ${name}`;
      if (!name || existing.has(normalize(name))) { skipped.push(name || f.name); done++; continue; }
      try {
        let blob;
        try { blob = await resizeToJpeg(f); }
        catch { throw new Error("this browser can't read this format. Save it as JPG and try again."); }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await addDoc(collection(db, 'roster'), {
          name: await seal(classKey, enc.encode(name)),
          img: await seal(classKey, bytes),
          addedAt: Date.now(),
        });
        existing.add(normalize(name));
      } catch (e) {
        failed.push(`${f.name} (${e.code === 'resource-exhausted' ? 'the free daily limit is used up, try again tomorrow' : e.message || e.code})`);
      }
      done++;
    }
    uploading = false;
    syncSize();
    const added = files.length - skipped.length - failed.length;
    let msg = `Added ${added} photo${added === 1 ? '' : 's'}.`;
    if (skipped.length) msg += ` Skipped ${skipped.length} already on the roster.`;
    if (failed.length) msg += ` Couldn't add: ${failed.join('; ')}.`;
    $('uploadStatus').textContent = msg;
  }

  async function readEntry(entry, out) {
    if (entry.isFile) await new Promise(res => entry.file(f => { out.push(f); res(); }, res));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise(res => reader.readEntries(res, () => res([])));
        for (const e of batch) await readEntry(e, out);
      } while (batch.length);
    }
  }

  function wireAdmin() {
    $('pickFolder').onclick = () => $('folderInput').click();
    $('pickFiles').onclick = () => $('filesInput').click();
    $('folderInput').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };
    $('filesInput').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };
    const drop = $('drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async e => {
      e.preventDefault(); drop.classList.remove('over');
      const entries = [...(e.dataTransfer.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
      if (entries.length) { const out = []; for (const en of entries) await readEntry(en, out); uploadFiles(out); }
      else uploadFiles(e.dataTransfer.files);
    });

    $('configForm').onsubmit = async e => {
      e.preventDefault();
      const s = new Date($('cfgStart').value).getTime(), en = new Date($('cfgEnd').value).getTime();
      if (!s || !en) { $('cfgStatus').textContent = 'Pick both a start and an end time.'; return; }
      if (en <= s) { $('cfgStatus').textContent = 'The end has to be after the start.'; return; }
      $('cfgStatus').textContent = 'Saving…';
      try {
        await setDoc(doc(db, 'meta', 'challenge'), { startsAt: s, endsAt: en, prize: $('cfgPrize').value.trim(), size: roster.length }, { merge: true });
        $('cfgStatus').textContent = 'Saved';
      } catch (err) { $('cfgStatus').textContent = "Couldn't save: " + err.message; }
    };

    const clr = $('clearBoardBtn');
    clr.onclick = async () => {
      if (!clr.classList.contains('armed')) {
        clr.classList.add('armed'); clr.textContent = `Delete ${scores.length} score${scores.length === 1 ? '' : 's'}`;
        setTimeout(() => { clr.classList.remove('armed'); clr.textContent = 'Clear leaderboard'; }, 4000);
        return;
      }
      clr.disabled = true;
      for (const s of scores.slice()) { try { await deleteDoc(doc(db, 'scores', s.id)); } catch {} }
      clr.disabled = false; clr.classList.remove('armed'); clr.textContent = 'Clear leaderboard';
    };
  }

  let playerView = false;
  function renderOrgBar() {
    if (!isAdmin) return;
    const n = roster.length;
    $('admin').hidden = playerView;
    $('orgJump').hidden = playerView;
    $('orgToggle').textContent = playerView ? 'Back to organizer view' : 'See what players see';
    $('orgText').textContent = playerView
      ? 'This is what players see: the game and the leaderboard. They can\'t add or change photos.'
      : n === 0
        ? 'You\'re the organizer. Start by adding the class photos below. Players can\'t upload anything; they only play with the photos you add.'
        : `You're the organizer. ${n} classmate${n === 1 ? '' : 's'} added so far. Players only see the game and leaderboard, never this section.`;
    $('orgJump').textContent = n === 0 ? 'Add class photos' : 'Manage photos';
  }
  $('orgToggle').onclick = () => { playerView = !playerView; renderOrgBar(); };
  $('orgJump').onclick = () => { $('admin').scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  function fillConfigForm() {
    if (!isAdmin || !config) return;
    if (document.activeElement && $('configForm').contains(document.activeElement)) return;
    if (config.startsAt) $('cfgStart').value = toLocalInput(config.startsAt);
    if (config.endsAt) $('cfgEnd').value = toLocalInput(config.endsAt);
    $('cfgPrize').value = config.prize || '';
  }

  // ================= Climb effects =================
  // The run is an Everest climb: each correct answer gains altitude from Base Camp to the summit.
  const BASE_M = 5364, TOP_M = 8849;
  const ZONES = [[5364, 'Base Camp'], [6065, 'Camp 1'], [6400, 'Camp 2'], [7162, 'Camp 3'], [7950, 'Camp 4'], [8000, 'Death zone'], [8849, 'Summit']];
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const zoneFor = m => ZONES.reduce((z, q) => m >= q[0] - 0.5 ? q : z, ZONES[0]);
  const fmtM = m => Math.round(m).toLocaleString('en-US') + ' m';
  const oxygen = m => Math.round(100 * Math.exp(-m / 7600));   // % of sea-level air pressure
  let shownM = BASE_M, altAnim = 0;

  function setAltitude(frac, announce) {
    const game = $('game');
    const m = BASE_M + frac * (TOP_M - BASE_M);
    game.style.setProperty('--alt', frac.toFixed(3));
    const shake = reduceMotion ? 0 : Math.max(0, (frac - .3) / .7) * 2.4 + (m >= 8000 ? 1 : 0);
    game.style.setProperty('--shake', shake.toFixed(2));
    game.style.setProperty('--beat', (1.2 - frac * .75).toFixed(2) + 's');
    game.classList.toggle('pulse', frac >= .2);
    const prev = zoneFor(shownM), z = zoneFor(m);
    const from = shownM, t0 = performance.now();
    cancelAnimationFrame(altAnim);
    const step = t => {
      const k = Math.min(1, (t - t0) / 500);
      $('altM').textContent = fmtM(from + (m - from) * k);
      if (k < 1) altAnim = requestAnimationFrame(step);
    };
    altAnim = requestAnimationFrame(step);
    shownM = m;
    $('altZone').textContent = `${z[1]} · O₂ ${oxygen(m)}%`;
    $('altZone').classList.toggle('danger', m >= 8000);
    if (announce && z[0] > prev[0]) zoneCall(z);
  }

  function zoneCall(z) {
    const el = $('zoneCall');
    el.className = 'zonecall';
    void el.offsetWidth;
    el.textContent = z[1] === 'Death zone' ? 'Death zone · thin air above 8,000 m'
      : z[1] === 'Summit' ? 'Summit · 8,849 m' : `${z[1]} · ${fmtM(z[0])}`;
    el.classList.add('on');
    if (z[1] === 'Death zone') el.classList.add('danger');
    if (z[1] === 'Summit') el.classList.add('summit');
  }

  function stumble() {
    const q = $('quake'), f = $('flash');
    q.classList.remove('jolt'); f.classList.remove('on');
    void q.offsetWidth;
    if (!reduceMotion) q.classList.add('jolt');
    f.classList.add('on');
    try { navigator.vibrate && navigator.vibrate([70, 40, 70]); } catch {}
  }

  // Confetti: a small canvas particle system
  const fx = $('fx'), fxCtx = fx.getContext('2d');
  let parts = [], fxFrame = 0;
  function fxColors() {
    const cs = getComputedStyle(document.documentElement);
    return ['--accent', '--marker', '--good', '--tag'].map(v => cs.getPropertyValue(v).trim() || '#2747D0');
  }
  function confetti({ x, y, count = 40, spread = 70, power = 9, angle = -90 }) {
    if (reduceMotion) count = Math.min(count, 10);
    const cols = fxColors();
    for (let i = 0; i < count; i++) {
      const a = (angle + (Math.random() - .5) * spread) * Math.PI / 180;
      const v = power * (.55 + Math.random() * .7);
      parts.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        r: Math.random() * Math.PI, vr: (Math.random() - .5) * .35,
        w: 6 + Math.random() * 5, h: 3 + Math.random() * 4,
        c: cols[i % cols.length], life: 0, ttl: 80 + Math.random() * 60,
      });
    }
    if (!fxFrame) fxFrame = requestAnimationFrame(tickFx);
  }
  function tickFx() {
    const dpr = window.devicePixelRatio || 1, W = innerWidth, H = innerHeight;
    if (fx.width !== Math.round(W * dpr) || fx.height !== Math.round(H * dpr)) { fx.width = Math.round(W * dpr); fx.height = Math.round(H * dpr); }
    fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fxCtx.clearRect(0, 0, W, H);
    parts = parts.filter(p => p.life < p.ttl && p.y < H + 40);
    for (const p of parts) {
      p.vy += .28; p.vx *= .985; p.vy *= .985;
      p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life++;
      fxCtx.save();
      fxCtx.globalAlpha = Math.min(1, (p.ttl - p.life) / 25);
      fxCtx.translate(p.x, p.y);
      fxCtx.rotate(p.r);
      fxCtx.scale(1, Math.cos(p.life * .18));
      fxCtx.fillStyle = p.c;
      fxCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      fxCtx.restore();
    }
    fxFrame = parts.length ? requestAnimationFrame(tickFx) : 0;
    if (!parts.length) fxCtx.clearRect(0, 0, W, H);
  }
  function burstFrom(el, count) {
    const r = el.getBoundingClientRect();
    confetti({ x: r.left + r.width / 2, y: r.top + r.height / 2, count });
  }
  function celebrate(big) {
    const n = big ? 6 : 2;
    for (let i = 0; i < n; i++) setTimeout(() => {
      const left = i % 2 === 0;
      confetti({ x: innerWidth * (left ? .08 : .92), y: innerHeight * .95, count: big ? 90 : 60, spread: 45, power: 19, angle: left ? -65 : -115 });
    }, i * 300);
  }

  // ================= Game engine =================
  let G = null;

  function preload(people) {
    return Promise.all(people.map(p => new Promise(r => {
      const i = new Image(); i.onload = i.onerror = () => r(); i.src = photoUrl(p);
    })));
  }

  async function startGame(mode) {
    const people = roster.slice();
    if (people.length < 2) return;
    G = {
      mode, ranked: mode === 'ranked',
      queue: shuffle(people.slice()),
      total: people.length,
      current: null, answered: false,
      correct: 0, missed: new Set(), seen: new Set(),
      ms: 0, qStart: 0, tick: null, advance: null,
    };
    show('game');
    $('gameLabel').textContent = G.ranked ? 'Ranked run' : 'Practice';
    $('clockBox').hidden = !G.ranked;
    $('clock').textContent = fmtTime(0);
    const top = ranked()[0];
    G.target = top ? top.ms : null;
    $('ghost').textContent = !top ? 'First finisher sets the pace'
      : top.id === myId ? `Your record ${fmtTime(top.ms)}` : `Top time ${fmtTime(top.ms)}`;
    $('ghost').classList.remove('beaten');
    $('game').classList.remove('redline');
    shownM = BASE_M;
    setAltitude(0, false);
    $('choiceArea').innerHTML = '';
    $('photo').removeAttribute('src');
    $('tagSlot').innerHTML = '';
    $('gameCounter').textContent = 'Loading photos…';
    $('feedback').textContent = '';
    for (const b of ['skipBtn', 'revealBtn', 'gotItBtn', 'missedItBtn', 'nextBtn']) $(b).hidden = true;
    if (G.ranked) await preload(people);
    if (!G || $('game').hidden) return;
    nextQuestion();
  }

  function setButtons(state) {
    $('skipBtn').hidden = !(state === 'asking' && !G.ranked);
    $('nextBtn').hidden = state !== 'answered' || G.ranked;
    $('revealBtn').hidden = state !== 'flash-hidden';
    $('gotItBtn').hidden = state !== 'flash-shown';
    $('missedItBtn').hidden = state !== 'flash-shown';
  }

  function showTag(name) {
    const slot = $('tagSlot');
    slot.innerHTML = '';
    const tag = document.createElement('div');
    tag.className = 'nametag';
    tag.innerHTML = '<div class="head"><div class="hello">HELLO</div><div class="mni">my name is</div></div><div class="nm"></div>';
    tag.querySelector('.nm').textContent = name;
    slot.append(tag);
  }

  function nextQuestion() {
    clearTimeout(G.advance);
    if (!G.queue.length) return finishGame();
    G.current = G.queue.shift();
    G.answered = false;
    const done = G.total - new Set(G.queue).size;
    $('gameCounter').textContent = `${done} of ${G.total}`;
    $('bar').style.width = ((done - 1) / G.total * 100) + '%';
    $('tagSlot').innerHTML = '';
    $('feedback').textContent = ''; $('feedback').className = 'feedback';

    const img = $('photo');
    img.onload = img.onerror = null;
    img.src = photoUrl(G.current);
    const mode = G.ranked ? 'choice' : G.mode;
    $('choiceArea').hidden = mode !== 'choice';
    $('typeArea').hidden = mode !== 'type';

    if (mode === 'choice') {
      const others = shuffle(roster.filter(p => p.id !== G.current.id && p.name !== G.current.name)).slice(0, 3);
      const area = $('choiceArea');
      area.innerHTML = '';
      shuffle([G.current, ...others]).forEach((p, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        const k = document.createElement('kbd'); k.textContent = i + 1;
        const s = document.createElement('span'); s.textContent = p.name;
        b.append(k, s);
        b.dataset.correct = p.id === G.current.id ? '1' : '';
        b.onclick = () => answerChoice(b);
        area.append(b);
      });
      $('keyHint').textContent = G.ranked ? 'Press 1–4 to answer.' : 'Press 1–4 to answer, Enter for the next photo.';
      setButtons('asking');
    } else if (mode === 'type') {
      $('guess').value = ''; $('guess').disabled = false;
      $('keyHint').textContent = 'Small typos are fine. Press Enter to check, and Enter again to continue.';
      setButtons('asking');
      setTimeout(() => $('guess').focus(), 0);
    } else {
      $('keyHint').textContent = 'Space shows the name. Y means you knew it, N means you didn\'t.';
      setButtons('flash-hidden');
    }

    if (G.ranked) {
      const begin = () => {
        if (!G || G.answered) return;
        G.qStart = performance.now();
        clearInterval(G.tick);
        G.tick = setInterval(() => {
          const cur = G.ms + performance.now() - G.qStart;
          $('clock').textContent = fmtTime(cur);
          if (G.target && cur > G.target && !$('game').classList.contains('redline')) {
            $('game').classList.add('redline');
            $('ghost').classList.add('beaten');
          }
        }, 100);
      };
      if (img.complete && img.naturalWidth) begin(); else { img.onload = begin; img.onerror = begin; }
    }
  }

  function record(correct) {
    G.answered = true;
    if (G.ranked) {
      clearInterval(G.tick);
      if (G.qStart) G.ms += performance.now() - G.qStart;
      G.qStart = 0;
      $('clock').textContent = fmtTime(G.ms);
    }
    const first = !G.seen.has(G.current.id);
    G.seen.add(G.current.id);
    if (correct) {
      if (first && !G.missed.has(G.current)) { G.correct++; setAltitude(G.correct / G.total, true); }
    }
    else {
      G.missed.add(G.current);
      if (!G.ranked) {
        const pos = Math.min(G.queue.length, 2 + Math.floor(Math.random() * 3));
        G.queue.splice(pos, 0, G.current);
      }
    }
  }

  function feedback(good, text) {
    $('feedback').textContent = text;
    $('feedback').className = 'feedback ' + (good ? 'good' : 'bad');
  }

  function answerChoice(btn) {
    if (!G || G.answered || (G.ranked && !G.qStart)) return;
    const correct = btn.dataset.correct === '1';
    for (const b of $('choiceArea').children) { b.disabled = true; if (b.dataset.correct) b.classList.add('correct'); }
    if (!correct) btn.classList.add('wrong');
    record(correct);
    if (correct) { feedback(true, 'Correct'); burstFrom(btn, 26 + Math.round(G.correct / G.total * 60)); }
    else { feedback(false, 'Not quite'); showTag(G.current.name); stumble(); }
    if (G.ranked) G.advance = setTimeout(nextQuestion, correct ? 450 : 1300);
    else { setButtons('answered'); $('nextBtn').focus(); }
  }

  $('typeArea').onsubmit = e => {
    e.preventDefault();
    if (!G) return;
    if (G.answered) return nextQuestion();
    const g = $('guess').value;
    if (!g.trim()) return;
    const res = checkGuess(g, G.current.name);
    record(!!res);
    $('guess').disabled = true;
    if (res === 'exact') feedback(true, 'Correct');
    else if (res === 'close') feedback(true, `Close enough. It's spelled ${G.current.name}.`);
    else { feedback(false, 'Not quite'); showTag(G.current.name); stumble(); }
    if (res) burstFrom($('guess'), 26 + Math.round(G.correct / G.total * 60));
    setButtons('answered');
    $('nextBtn').focus();
  };

  $('skipBtn').onclick = () => {
    if (!G || G.answered) return;
    for (const b of $('choiceArea').children) { b.disabled = true; if (b.dataset.correct) b.classList.add('correct'); }
    $('guess').disabled = true;
    record(false);
    showTag(G.current.name);
    setButtons('answered');
    $('nextBtn').focus();
  };
  $('revealBtn').onclick = () => { showTag(G.current.name); setButtons('flash-shown'); };
  $('gotItBtn').onclick = () => { record(true); burstFrom($('gotItBtn'), 30); nextQuestion(); };
  $('missedItBtn').onclick = () => { record(false); stumble(); nextQuestion(); };
  $('nextBtn').onclick = () => nextQuestion();
  $('quitBtn').onclick = () => {
    if (!G) return;
    clearInterval(G.tick); clearTimeout(G.advance);
    if (G.ranked) { G = null; show('home'); return; }
    finishGame();
  };

  document.addEventListener('keydown', e => {
    if (!G || $('game').hidden) return;
    const mode = G.ranked ? 'choice' : G.mode;
    if (e.target.tagName === 'INPUT' && !G.answered) return;
    if (mode === 'choice' && !G.answered && /^[1-4]$/.test(e.key)) {
      const b = $('choiceArea').children[+e.key - 1];
      if (b) b.click();
    } else if (mode === 'flash') {
      const k = e.key.toLowerCase();
      if ((k === ' ' || k === 'enter') && !$('revealBtn').hidden) { e.preventDefault(); $('revealBtn').click(); }
      else if (k === 'y' && !$('gotItBtn').hidden) $('gotItBtn').click();
      else if (k === 'n' && !$('missedItBtn').hidden) $('missedItBtn').click();
    } else if (G.answered && !G.ranked && e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
      e.preventDefault(); nextQuestion();
    }
  });

  async function finishGame() {
    const g = G;
    G = null;
    clearInterval(g.tick); clearTimeout(g.advance);
    const seenCount = g.seen.size;
    show('result');
    $('resLabel').textContent = g.ranked ? 'Ranked run' : 'Practice';
    $('resScore').textContent = g.ranked ? `${g.correct}/${g.total}` : `${g.correct}/${seenCount || 0}`;
    $('resTime').textContent = g.ranked ? fmtTime(g.ms) : 'correct on the first try';
    $('resTime').hidden = false;
    $('resNote').hidden = true;
    const reachedM = BASE_M + (g.total ? g.correct / g.total : 0) * (TOP_M - BASE_M);
    const rz = zoneFor(reachedM);
    $('resAlt').textContent = rz[1] === 'Summit' ? 'You reached the summit: 8,849 m.'
      : `You reached ${rz[1] === 'Death zone' ? 'the death zone' : rz[1]} at ${fmtM(reachedM)}.`;
    if (g.correct === g.total && g.total > 0) celebrate(true);
    else if (g.correct / Math.max(1, g.total) >= .6) celebrate(false);
    $('resVerdict').textContent = '';

    const missed = [...g.missed];
    $('resMissedWrap').hidden = missed.length === 0;
    const grid = $('resMissed');
    grid.innerHTML = '';
    for (const p of missed) {
      const fig = document.createElement('figure');
      fig.style.margin = '0';
      const img = document.createElement('img'); img.src = photoUrl(p); img.alt = p.name;
      const cap = document.createElement('figcaption'); cap.textContent = p.name;
      fig.append(img, cap);
      grid.append(fig);
    }
    $('againBtn').onclick = () => startGame(g.mode);
    $('againBtn').disabled = g.ranked && windowState() !== 'open';

    if (!g.ranked) {
      $('resVerdict').textContent = missed.length ? 'The ones below tripped you up.' : 'Clean sweep. Try a ranked run.';
      return;
    }
    await saveRanked({ correct: g.correct, total: g.total, ms: Math.round(g.ms), achievedAt: Date.now() });
  }

  async function saveRanked(run) {
    const note = $('resNote');
    if (windowState() !== 'open') {
      $('resVerdict').textContent = 'Nice run.';
      note.hidden = false; note.className = 'note';
      note.textContent = 'The challenge window is closed, so this run wasn\'t added to the leaderboard.';
      return;
    }
    if (!db || !myId || saveBlocked) {
      $('resVerdict').textContent = 'Nice run.';
      note.hidden = false; note.className = 'note warn';
      note.textContent = 'This run couldn\'t be saved. Reload the page and sign in again.';
      return;
    }
    const prev = scores.find(s => s.id === myId);
    const attempts = (prev && prev.attempts || 0) + 1;
    const improved = better(run, prev);
    const who = { name: me.displayName || '', photo: (me.photoURL || '').slice(0, 900) };
    const body = improved ? { ...run, attempts, lastPlayedAt: run.achievedAt, ...who }
      : { correct: prev.correct, total: prev.total, ms: prev.ms, achievedAt: prev.achievedAt, attempts, lastPlayedAt: run.achievedAt, ...who };
    $('resVerdict').textContent = 'Saving…';
    try {
      await setDoc(doc(db, 'scores', myId), body);
    } catch (e) {
      $('resVerdict').textContent = 'Nice run.';
      note.hidden = false; note.className = 'note warn';
      note.textContent = e.code === 'permission-denied'
        ? 'The leaderboard didn\'t accept this run. The challenge may have just closed, or the class list changed during your run. Reload and try again.'
        : 'This run couldn\'t be saved right now. Check your connection and try another run.';
      return;
    }
    // Local copy so the verdict reflects the new standing immediately
    const merged = { id: myId, ...body };
    scores = scores.filter(s => s.id !== myId).concat(merged);
    const rank = ranked().findIndex(s => s.id === myId) + 1;
    if (improved) {
      if (run.correct !== run.total) celebrate(true);
      $('resVerdict').textContent = prev ? `New personal best. You're #${rank}.` : `You're on the board at #${rank}.`;
    } else {
      $('resVerdict').textContent = `Your best is still ${prev.correct}/${prev.total} in ${fmtTime(prev.ms)} (#${rank}).`;
    }
    renderBoard();
  }

  $('rankedBtn').onclick = () => startGame('ranked');
  $('practiceBtn').onclick = () => startGame(document.querySelector('input[name=pmode]:checked').value);
  $('homeBtn').onclick = () => show('home');

  // ================= Boot =================
  renderWindow();
  renderPlayCard();
  setInterval(renderWindow, 30000);

  // ================= Boot =================
  function gate(which) {
    show('gate');
    for (const id of ['gateLoading', 'gateSetup', 'gateSignIn', 'gatePass', 'gateCreate', 'gateWait']) $(id).hidden = id !== which;
  }

  const configured = FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && !/PASTE/.test(FIREBASE_CONFIG.apiKey);
  if (!configured) {
    gate('gateSetup');
  } else {
    const app = initializeApp(FIREBASE_CONFIG);
    auth = getAuth(app);
    db = getFirestore(app);
    gate('gateLoading');

    $('signInBtn').onclick = async () => {
      $('signInErr').textContent = '';
      try { await signInWithPopup(auth, new GoogleAuthProvider()); }
      catch (e) {
        if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
        $('signInErr').textContent = e.code === 'auth/unauthorized-domain'
          ? 'This website address isn\'t allowed to sign in yet. The organizer needs to add it in Firebase under Authentication, Settings, Authorized domains.'
          : e.code === 'auth/popup-blocked' ? 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.'
          : 'Couldn\'t sign in: ' + (e.message || e.code);
      }
    };
    $('signOutBtn').onclick = async () => { forgetPass(); await signOut(auth); location.reload(); };

    onAuthStateChanged(auth, u => {
      if (!u) { $('account').hidden = true; gate('gateSignIn'); return; }
      if (me && me.uid === u.uid) return;
      me = u;
      startSession();
    });
  }

  async function startSession() {
    myId = me.uid;
    const email = (me.email || '').toLowerCase();
    isAdmin = ORGANIZER_EMAILS.map(e => String(e).toLowerCase()).includes(email);
    $('account').hidden = false;
    $('accountName').textContent = me.displayName || me.email || 'Signed in';
    if (me.photoURL) { $('accountImg').referrerPolicy = 'no-referrer'; $('accountImg').src = me.photoURL; }
    else $('accountImg').hidden = true;

    gate('gateLoading');
    let snap;
    try { snap = await getDoc(doc(db, 'meta', 'crypto')); }
    catch (e) {
      $('gateLoading').querySelector('p').textContent = e.code === 'permission-denied'
        ? 'The class database refused access. The organizer needs to publish the security rules from firestore.rules.'
        : 'Couldn\'t reach the class database. Check your connection and reload.';
      return;
    }
    if (!snap.exists()) { gate(isAdmin ? 'gateCreate' : 'gateWait'); return; }
    cryptoMeta = snap.data();
    const saved = recallPass();
    if (saved && await tryUnlock(saved)) return;
    if (saved) forgetPass();
    gate('gatePass');
    setTimeout(() => $('passInput').focus(), 0);
  }

  async function tryUnlock(pass) {
    try {
      const key = await deriveKey(pass, cryptoMeta.salt, cryptoMeta.iter);
      if (dec.decode(await openSealed(key, cryptoMeta.check)) !== CHECK) return false;
      classKey = key;
    } catch { return false; }
    rememberPass(pass);
    enterGame();
    return true;
  }

  $('passForm').onsubmit = async e => {
    e.preventDefault();
    const v = $('passInput').value;
    if (!v.trim()) return;
    $('passErr').textContent = 'Checking…';
    if (!(await tryUnlock(v))) $('passErr').textContent = 'That passcode didn\'t work. Check it with your organizer.';
  };

  async function newCrypto(pass) {
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    const key = await deriveKey(pass, salt, PBKDF2_ITERATIONS);
    return { key, meta: { salt, iter: PBKDF2_ITERATIONS, check: await seal(key, enc.encode(CHECK)) } };
  }

  $('createForm').onsubmit = async e => {
    e.preventDefault();
    const v = $('createInput').value.trim();
    if (normPass(v).length < 6) { $('createErr').textContent = 'Use at least 6 characters.'; return; }
    $('createErr').textContent = 'Setting up…';
    const { key, meta } = await newCrypto(v);
    try {
      await setDoc(doc(db, 'meta', 'crypto'), meta);
      const now = Date.now();
      await setDoc(doc(db, 'meta', 'challenge'), { startsAt: now, endsAt: now + 7 * 864e5, prize: '', size: 0 });
    } catch (err) {
      $('createErr').textContent = err.code === 'permission-denied'
        ? 'Firebase refused the change. Check that your Google email is in firestore.rules and that the rules are published.'
        : 'Couldn\'t save: ' + (err.message || err.code);
      return;
    }
    cryptoMeta = meta; classKey = key;
    rememberPass(v);
    enterGame();
  };

  // ---------- After unlocking ----------
  const plain = new Map();     // roster id -> decrypted entry, reused while its ciphertext is unchanged
  let rosterToken = 0, rosterComplete = false, changingPass = false, entered = false;

  function enterGame() {
    if (entered) return;
    entered = true;
    show('home');
    $('windowChip').hidden = false;
    if (isAdmin) {
      $('admin').hidden = false;
      $('orgBar').hidden = false;
      wireAdmin();
      renderOrgBar();
    }
    onSnapshot(collection(db, 'roster'), handleRoster, err => console.warn('roster', err));
    onSnapshot(doc(db, 'meta', 'challenge'), snap => {
      config = snap.exists() ? snap.data() : null;
      renderWindow(); fillConfigForm(); renderBoard(); syncSize();
    }, err => console.warn('challenge', err));
    onSnapshot(doc(db, 'meta', 'crypto'), snap => {
      // The organizer changed the passcode: ask for the new one
      if (!changingPass && snap.exists() && snap.data().check !== cryptoMeta.check) { forgetPass(); location.reload(); }
    }, () => {});
    onSnapshot(collection(db, 'scores'), snap => {
      scores = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => typeof s.correct === 'number' && typeof s.total === 'number' && typeof s.ms === 'number');
      renderBoard();
    }, err => console.warn('scores', err));
  }

  async function handleRoster(snap) {
    if (changingPass) return;
    const token = ++rosterToken;
    const next = [];
    let failed = 0;
    for (const d of snap.docs) {
      const data = d.data();
      let p = plain.get(d.id);
      try {
        if (!p || p.imgCt !== data.img) {
          const bytes = await openSealed(classKey, data.img);
          if (p) URL.revokeObjectURL(p.url);
          p = { id: d.id, imgCt: data.img, nameCt: null, name: '', bytes: isAdmin ? bytes : null,
                url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })) };
          plain.set(d.id, p);
        }
        if (p.nameCt !== data.name) { p.name = dec.decode(await openSealed(classKey, data.name)); p.nameCt = data.name; }
        next.push(p);
      } catch { failed++; }
      if (token !== rosterToken) return;
    }
    const live = new Set(snap.docs.map(d => d.id));
    for (const [id, p] of plain) if (!live.has(id)) { URL.revokeObjectURL(p.url); plain.delete(id); }
    roster = next.sort((a, b) => a.name.localeCompare(b.name));
    rosterComplete = failed === 0;
    renderPlayCard(); renderRoster(); renderOrgBar(); syncSize();
  }

  // Keep the class size in the challenge settings so the security rules can check each score's total
  let sizeWriting = false;
  async function syncSize() {
    if (!isAdmin || !config || !rosterComplete || uploading || sizeWriting || config.size === roster.length) return;
    sizeWriting = true;
    try { await updateDoc(doc(db, 'meta', 'challenge'), { size: roster.length }); } catch (e) { console.warn('size', e); }
    sizeWriting = false;
  }

  $('changePassForm').onsubmit = async e => {
    e.preventDefault();
    if (!isAdmin) return;
    const v = $('newPass').value.trim(), st = $('changePassStatus');
    if (normPass(v).length < 6) { st.textContent = 'Use at least 6 characters.'; return; }
    if (!rosterComplete || roster.some(p => !p.bytes)) { st.textContent = 'Wait for every photo to finish loading, then try again.'; return; }
    changingPass = true;
    const { key, meta } = await newCrypto(v);
    try {
      let i = 0;
      for (const p of roster) {
        st.textContent = `Re-encrypting ${++i} of ${roster.length}…`;
        const upd = { name: await seal(key, enc.encode(p.name)), img: await seal(key, p.bytes) };
        await updateDoc(doc(db, 'roster', p.id), upd);
        p.nameCt = upd.name; p.imgCt = upd.img;
      }
      await setDoc(doc(db, 'meta', 'crypto'), meta);
      cryptoMeta = meta; classKey = key;
      rememberPass(v);
      $('newPass').value = '';
      st.textContent = 'Passcode changed. Send the new one to your classmates.';
    } catch (err) {
      st.textContent = 'Couldn\'t finish: ' + (err.message || err.code) + '. Try again; photos already done keep working with the new passcode once it saves.';
    }
    changingPass = false;
  };
