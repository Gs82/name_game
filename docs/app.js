// Roll Call: website version (GitHub Pages + Firebase).
// Players sign in with their school email and a password. Only emails on the
// organizer's class list can read the photos or post scores; firestore.rules enforces it.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { FIREBASE_CONFIG, EMAIL_DOMAIN } from './config.js';

function b64(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

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
    if (section !== 'game') { $('game').classList.remove('pulse', 'redline'); $('game').style.setProperty('--alt', 0); }
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

  function initialsAvatar(name) {
    const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
    let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" fill="hsl(${h % 360} 45% 52%)"/>` +
      `<text x="36" y="45" font-family="system-ui,sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${letters.replace(/[<&>]/g, '')}</text></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
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
      img.alt = ''; img.referrerPolicy = 'no-referrer';
      img.src = p.avatarUrl || initialsAvatar(p.name || '?');
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
        try { await updateDoc(doc(db, 'roster', p.id), { name: v }); }
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
    if (!isAdmin || !db) { $('uploadStatus').textContent = 'Only the organizer can add photos.'; return; }
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
          name,
          img: b64(bytes),
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

  // ================= Finish screen =================
  // "TYPE SHIT" stamped all over the screen while Tim the Beaver flies around it.
  let finaleFrame = 0, finaleTimer = 0;
  function finale(sub) {
    const el = $('finale'), words = $('finaleWords');
    $('finaleSub').textContent = sub;
    words.innerHTML = '';
    const W = innerWidth, H = innerHeight;
    const colors = ['#FFE14A', '#FFFFFF', '#A31F34', '#8EA3FF', '#5BD08A', '#FF8A3D'];
    const cols = W < 600 ? 3 : 5, rows = Math.max(5, Math.round(H / 110));
    let i = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const w = document.createElement('span');
      w.className = 'word';
      w.textContent = 'TYPE SHIT';
      w.style.left = ((c + .5) / cols * 100 + (Math.random() - .5) * (60 / cols)) + '%';
      w.style.top = ((r + .5) / rows * 100 + (Math.random() - .5) * (50 / rows)) + '%';
      w.style.fontSize = (W < 600 ? 14 + Math.random() * 16 : 18 + Math.random() * 30) + 'px';
      w.style.color = colors[i % colors.length];
      w.style.setProperty('--r', (Math.random() * 50 - 25).toFixed(1) + 'deg');
      w.style.setProperty('--d', (80 + Math.random() * 900).toFixed(0) + 'ms');
      words.append(w);
      i++;
    }
    el.classList.remove('out');
    el.hidden = false;

    // Tim bounces around the screen like an arcade sprite
    const tim = $('tim');
    const size = tim.getBoundingClientRect();
    const tw = size.width || 130, th = size.height || tw * 487 / 360;
    let x = -tw, y = H * .25, vx = W / 90 + 4, vy = 2.2, t = 0, frame = 0;
    cancelAnimationFrame(finaleFrame);
    const fly = () => {
      t += 1; frame++;
      x += vx; y += vy + Math.sin(t / 9) * 2.4;
      if (x > W - tw && vx > 0 && t > 20) vx = -vx;
      if (x < 0 && vx < 0) vx = -vx;
      if (y < 0) { y = 0; vy = Math.abs(vy); }
      if (y > H - th) { y = H - th; vy = -Math.abs(vy); }
      if (frame % 90 === 0) vy = (Math.random() - .5) * 7;   // change altitude now and then
      const flip = vx < 0 ? -1 : 1;
      // The photo faces the viewer, so lean into the flight instead of mirroring (mirroring would flip the MIT shirt)
      const tilt = flip * 16 + Math.sin(t / 7) * 6 + vy * 1.5;
      tim.style.transform = `translate(${x}px, ${y}px) rotate(${tilt}deg)`;
      if (frame % 4 === 0) confetti({ x: x + tw / 2 - flip * tw * .35, y: y + th * .75, count: 3, spread: 120, power: 3, angle: flip > 0 ? 180 : 0 });
      finaleFrame = requestAnimationFrame(fly);
    };
    if (reduceMotion) tim.style.transform = `translate(${W - tw - 16}px, ${H - th - 60}px)`;
    else finaleFrame = requestAnimationFrame(fly);

    clearTimeout(finaleTimer);
    finaleTimer = setTimeout(closeFinale, 6500);
  }
  function closeFinale() {
    const el = $('finale');
    if (el.hidden || el.classList.contains('out')) return;
    clearTimeout(finaleTimer);
    el.classList.add('out');
    setTimeout(() => { el.hidden = true; el.classList.remove('out'); cancelAnimationFrame(finaleFrame); }, 450);
  }
  $('finale').onclick = closeFinale;
  document.addEventListener('keydown', e => { if (!$('finale').hidden && (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); closeFinale(); } });

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
    else { feedback(false, 'Not quite'); showTag(G.current.name); }
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
    else { feedback(false, 'Not quite'); showTag(G.current.name); }
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
  $('missedItBtn').onclick = () => { record(false); nextQuestion(); };
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
    finale(g.ranked ? `${g.correct}/${g.total} · ${fmtTime(g.ms)}` : `${g.correct}/${seenCount || 0} first try`);
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
    const who = { name: (me.displayName || me.email.split('@')[0]).slice(0, 60), photo: '' };
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

  // ================= Sign-in =================
  // Players join with their school email, a password and the class code from the
  // organizer's invite link. No confirmation email: the class list plus the code,
  // both checked by firestore.rules, decide who gets in.
  const GATES = ['gateLoading', 'gateSetup', 'gateSignIn', 'gateJoin', 'gateVerify', 'gateNotListed'];
  function gate(which) {
    show('gate');
    for (const id of GATES) $(id).hidden = id !== which;
  }
  const lowerEmail = e => String(e || '').trim().toLowerCase();
  const DOMAIN = String(EMAIL_DOMAIN || '').toLowerCase().replace(/^@/, '');
  const inDomain = e => !DOMAIN || e.endsWith('@' + DOMAIN);
  const normCode = c => String(c || '').trim().toLowerCase().replace(/\s+/g, '');

  // The invite link carries the code as #join-CODE; remember it for this visit
  const CODE_KEY = 'rollcall-join-code';
  function codeFromLink() {
    const m = location.hash.match(/^#join-([A-Za-z0-9_-]{3,40})$/);
    if (m) { try { sessionStorage.setItem(CODE_KEY, normCode(m[1])); } catch {} return normCode(m[1]); }
    try { return sessionStorage.getItem(CODE_KEY) || ''; } catch { return ''; }
  }
  const linkCode = codeFromLink();

  let authMode = /^#join-/.test(location.hash) ? 'signup' : 'signin';
  function setAuthMode(m) {
    authMode = m;
    const up = m === 'signup';
    $('nameField').hidden = !up;
    $('codeField').hidden = !up;
    $('authTitle').textContent = up ? 'Join the class' : 'Sign in with your school email';
    $('authSubmit').textContent = up ? 'Join' : 'Sign in';
    $('authToggle').textContent = up ? 'I already have an account' : 'First time here? Join the class';
    $('pwInput').autocomplete = up ? 'new-password' : 'current-password';
    $('pwLabel').textContent = up ? 'Choose a password (6+ characters)' : 'Password';
    $('forgotBtn').hidden = up;
    $('authErr').textContent = '';
  }

  function authMessage(e) {
    switch (e.code) {
      case 'auth/invalid-credential': case 'auth/wrong-password': case 'auth/user-not-found':
        return 'That email and password don\'t match. First time here? Join the class.';
      case 'auth/email-already-in-use': return 'There\'s already an account for this email. Sign in instead, or reset your password. If you never made one, tell the organizer.';
      case 'auth/weak-password': return 'Use a password with at least 6 characters.';
      case 'auth/invalid-email': return 'That doesn\'t look like an email address.';
      case 'auth/too-many-requests': return 'Too many tries. Wait a few minutes and try again.';
      case 'auth/network-request-failed': return 'Couldn\'t connect. Check your internet and try again.';
      case 'auth/operation-not-allowed': return 'Email sign-in isn\'t switched on yet. The organizer needs to enable Email/Password in Firebase.';
      default: return 'Something went wrong: ' + (e.message || e.code);
    }
  }
  // After clicking the email link, Firebase shows a Continue button that returns here
  const linkSettings = () => ({ url: location.origin + location.pathname });

  // Join the class: write members/<uid>; the rules accept it only with the right code
  // for an email on the class list. Returns 'ok', 'not-listed' or 'bad-code'.
  async function claimMembership(code) {
    try {
      await setDoc(doc(db, 'members', me.uid), { email: lowerEmail(me.email), code: normCode(code), joinedAt: Date.now() });
      try { sessionStorage.setItem(CODE_KEY, normCode(code)); } catch {}
      return 'ok';
    } catch {
      let listed = false;
      try { listed = (await getDoc(doc(db, 'allowed', lowerEmail(me.email)))).exists(); } catch {}
      return listed ? 'bad-code' : 'not-listed';
    }
  }
  let pendingCode = '';

  const configured = FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey && !/PASTE/.test(FIREBASE_CONFIG.apiKey);
  if (!configured) {
    gate('gateSetup');
  } else {
    const app = initializeApp(FIREBASE_CONFIG);
    auth = getAuth(app);
    db = getFirestore(app);
    gate('gateLoading');
    setAuthMode(authMode);
    if (linkCode) $('codeInput').value = linkCode;

    $('authToggle').onclick = () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
    $('authForm').onsubmit = async e => {
      e.preventDefault();
      const email = lowerEmail($('emailInput').value), pw = $('pwInput').value, name = $('nameInput').value.trim();
      const code = normCode($('codeInput').value);
      if (!email || !pw) { $('authErr').textContent = 'Enter your school email and a password.'; return; }
      if (!inDomain(email)) { $('authErr').textContent = `Use your @${DOMAIN} email address.`; return; }
      if (authMode === 'signup' && !name) { $('authErr').textContent = 'Add your name. It\'s what the leaderboard shows.'; return; }
      $('authErr').textContent = authMode === 'signup' ? 'Joining…' : 'Signing in…';
      try {
        if (authMode === 'signup') {
          pendingCode = code;
          const cred = await createUserWithEmailAndPassword(auth, email, pw);
          await updateProfile(cred.user, { displayName: name.slice(0, 60) });
          startSession();
        } else {
          await signInWithEmailAndPassword(auth, email, pw);
        }
        $('authErr').textContent = '';
      } catch (err) { $('authErr').textContent = authMessage(err); }
    };
    $('forgotBtn').onclick = async () => {
      const email = lowerEmail($('emailInput').value);
      if (!email) { $('authErr').textContent = 'Type your school email above first.'; return; }
      try {
        await sendPasswordResetEmail(auth, email);
        $('authErr').textContent = `If there's an account for ${email}, a reset link is on its way. Check Junk too.`;
      } catch (err) { $('authErr').textContent = authMessage(err); }
    };

    // Signed in but not a member yet (e.g. the account predates the class code)
    $('joinForm').onsubmit = async e => {
      e.preventDefault();
      const code = normCode($('joinInput').value);
      if (!code) return;
      $('joinErr').textContent = 'Checking…';
      const r = await claimMembership(code);
      if (r === 'ok') { $('joinErr').textContent = ''; enterGame(); }
      else if (r === 'bad-code') $('joinErr').textContent = 'That code didn\'t work. Check the invite link from your organizer.';
      else { $('notListedEmail').textContent = me.email; gate('gateNotListed'); }
    };

    // The organizer's account still needs a confirmed email (see firestore.rules)
    $('orgVerifyBtn').onclick = async () => {
      try { await sendEmailVerification(auth.currentUser, linkSettings()).catch(() => sendEmailVerification(auth.currentUser)); } catch {}
      $('verifyEmail').textContent = me.email;
      $('verifyMsg').textContent = '';
      gate('gateVerify');
    };
    $('verifyContinue').onclick = async () => {
      const u = auth.currentUser;
      if (!u) return gate('gateSignIn');
      $('verifyMsg').textContent = 'Checking…';
      await u.reload();
      if (!auth.currentUser.emailVerified) { $('verifyMsg').textContent = 'Not confirmed yet. Open the link in the email first, then come back.'; return; }
      $('verifyMsg').textContent = '';
      me = auth.currentUser;
      startSession();
    };
    $('verifyResend').onclick = async () => {
      try {
        await sendEmailVerification(auth.currentUser, linkSettings()).catch(() => sendEmailVerification(auth.currentUser));
        $('verifyMsg').textContent = 'Sent again. It can take a minute, and it may land in Junk.';
      } catch (err) { $('verifyMsg').textContent = authMessage(err); }
    };
    // Sign out back to the plain address, so the page opens on "Sign in" rather than the invite's "Join"
    for (const id of ['signOutBtn', 'verifyOut', 'notListedOut', 'joinOut']) $(id).onclick = async () => { await signOut(auth); location.replace(location.pathname); };

    onAuthStateChanged(auth, u => {
      if (!u) { $('account').hidden = true; gate('gateSignIn'); return; }
      if (me && me.uid === u.uid) return;
      me = u;
      startSession();
    });
  }

  // Sign-up and the auth listener can both start a session at once; run it only once at a time
  let sessionRun = null;
  function startSession() {
    if (entered) return;
    if (!sessionRun) sessionRun = runSession().finally(() => { sessionRun = null; });
    return sessionRun;
  }
  async function runSession() {
    myId = me.uid;
    $('account').hidden = false;
    $('accountName').textContent = me.displayName || me.email;
    $('accountImg').src = initialsAvatar(me.displayName || me.email || '?');
    gate('gateLoading');
    // Fresh token, so a just-confirmed organizer email counts right away
    try { await me.getIdToken(true); } catch {}
    // Only organizers may read admin/*, so a successful read means this is the organizer.
    // This keeps organizer emails out of the public site code.
    try { await getDoc(doc(db, 'admin', 'probe')); isAdmin = true; } catch { isAdmin = false; }
    if (isAdmin) return enterGame();

    let member = false;
    try { member = (await getDoc(doc(db, 'members', me.uid))).exists(); } catch {}
    if (member) {
      let listed = false;
      try { listed = (await getDoc(doc(db, 'allowed', lowerEmail(me.email)))).exists(); } catch {}
      if (listed) return enterGame();
      $('notListedEmail').textContent = me.email;
      return gate('gateNotListed');
    }
    const code = pendingCode || linkCode;
    pendingCode = '';
    if (code) {
      const r = await claimMembership(code);
      if (r === 'ok') return enterGame();
      if (r === 'not-listed') { $('notListedEmail').textContent = me.email; return gate('gateNotListed'); }
      $('joinErr').textContent = 'That class code didn\'t work. Check the invite link from your organizer.';
    }
    $('joinInput').value = code || '';
    gate('gateJoin');
  }

  // ---------- After signing in ----------
  let entered = false, rosterComplete = false, allowed = [], joined = new Set(), classCode = '';

  async function enterGame() {
    if (entered) return;
    entered = true;
    show('home');
    $('windowChip').hidden = false;
    if (isAdmin) {
      $('admin').hidden = false;
      $('orgBar').hidden = false;
      wireAdmin();
      renderOrgBar();
      const ch = await getDoc(doc(db, 'meta', 'challenge')).catch(() => null);
      if (ch && !ch.exists()) {
        const now = Date.now();
        await setDoc(doc(db, 'meta', 'challenge'), { startsAt: now, endsAt: now + 7 * 864e5, prize: '', size: 0 }).catch(e => console.warn(e));
      }
      onSnapshot(collection(db, 'allowed'), snap => { allowed = snap.docs.map(d => d.id).sort(); renderAllowed(); }, err => console.warn('allowed', err));
      onSnapshot(collection(db, 'members'), snap => { joined = new Set(snap.docs.map(d => d.data().email)); renderAllowed(); }, err => console.warn('members', err));
      onSnapshot(doc(db, 'secret', 'code'), async snap => {
        if (!snap.exists()) { await newClassCode(); return; }
        classCode = snap.data().code || '';
        renderInvite();
      }, err => console.warn('code', err));
    }
    onSnapshot(collection(db, 'roster'), snap => {
      roster = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(p => typeof p.name === 'string' && typeof p.img === 'string')
        .map(p => ({ id: p.id, name: p.name, url: 'data:image/jpeg;base64,' + p.img }))
        .sort((a, b) => a.name.localeCompare(b.name));
      rosterComplete = !snap.metadata || !snap.metadata.fromCache;
      renderPlayCard(); renderRoster(); renderOrgBar(); syncSize();
    }, err => console.warn('roster', err));
    onSnapshot(doc(db, 'meta', 'challenge'), snap => {
      config = snap.exists() ? snap.data() : null;
      renderWindow(); fillConfigForm(); renderBoard(); syncSize();
    }, err => console.warn('challenge', err));
    onSnapshot(collection(db, 'scores'), snap => {
      scores = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => typeof s.correct === 'number' && typeof s.total === 'number' && typeof s.ms === 'number');
      renderBoard();
    }, err => console.warn('scores', err));
  }

  // Keep the class size in the challenge settings so the security rules can check each score's total
  let sizeWriting = false;
  async function syncSize() {
    if (!isAdmin || !config || !rosterComplete || uploading || sizeWriting || config.size === roster.length) return;
    sizeWriting = true;
    try { await updateDoc(doc(db, 'meta', 'challenge'), { size: roster.length }); } catch (e) { console.warn('size', e); }
    sizeWriting = false;
  }

  // ---------- Organizer: class code and invite link ----------
  const CODE_WORDS = ['beaver', 'dome', 'charles', 'kendall', 'sloan', 'infinite', 'baltic', 'tim', 'brass', 'killian'];
  async function newClassCode() {
    const n = crypto.getRandomValues(new Uint32Array(2));
    const code = CODE_WORDS[n[0] % CODE_WORDS.length] + '-' + String(1000 + n[1] % 9000);
    try { await setDoc(doc(db, 'secret', 'code'), { code, createdAt: Date.now() }); }
    catch (e) { $('inviteStatus').textContent = 'Couldn\'t make a code: ' + (e.message || e.code); }
  }
  const inviteLink = () => location.origin + location.pathname + '#join-' + classCode;
  function renderInvite() {
    $('inviteLink').value = classCode ? inviteLink() : '';
    $('inviteCode').textContent = classCode || '…';
  }
  $('copyInvite').onclick = async () => {
    const text = inviteLink();
    try { await navigator.clipboard.writeText(text); $('inviteStatus').textContent = 'Link copied. Paste it into your message to the class.'; }
    catch { $('inviteLink').select(); $('inviteStatus').textContent = 'Press Cmd+C (or Ctrl+C) to copy.'; }
  };
  $('newCodeBtn').onclick = async () => {
    const b = $('newCodeBtn');
    if (!b.classList.contains('armed')) {
      b.classList.add('armed'); b.textContent = 'Confirm new code';
      setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Make a new code'; }, 4000);
      return;
    }
    b.classList.remove('armed'); b.textContent = 'Make a new code';
    await newClassCode();
    $('inviteStatus').textContent = 'New code made. The old link stops working for new sign-ups; people who already joined keep playing.';
  };

  // ---------- Organizer: class list ----------
  function renderAllowed() {
    const ul = $('allowList');
    ul.innerHTML = '';
    for (const email of allowed) {
      const li = document.createElement('li');
      const span = document.createElement('span'); span.textContent = (joined.has(email) ? '✓ ' : '') + email;
      if (joined.has(email)) li.classList.add('joined');
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'danger'; del.textContent = 'Remove';
      del.setAttribute('aria-label', 'Remove ' + email);
      del.onclick = async () => {
        del.disabled = true;
        try { await deleteDoc(doc(db, 'allowed', email)); }
        catch (e) { del.disabled = false; $('allowStatus').textContent = 'Couldn\'t remove: ' + (e.message || e.code); }
      };
      li.append(span, del);
      ul.append(li);
    }
    const nJoined = allowed.filter(e => joined.has(e)).length;
    $('allowCount').textContent = allowed.length ? `${allowed.length} email${allowed.length === 1 ? '' : 's'} on the list · ${nJoined} joined (✓)` : 'Nobody on the list yet';
  }
  $('allowForm').onsubmit = async e => {
    e.preventDefault();
    if (!isAdmin) return;
    const found = ($('allowInput').value.match(/[^\s,;<>"'()]+@[^\s,;<>"'()]+\.[^\s,;<>"'()]+/g) || []).map(lowerEmail);
    const outside = [...new Set(found.filter(x => !inDomain(x)))];
    const fresh = [...new Set(found)].filter(x => inDomain(x) && !allowed.includes(x));
    const skipNote = outside.length ? ` Skipped ${outside.length} that aren't @${DOMAIN}: ${outside.slice(0, 3).join(', ')}${outside.length > 3 ? '…' : ''}` : '';
    if (!found.length) { $('allowStatus').textContent = 'No email addresses found. Paste one per line.'; return; }
    if (!fresh.length) { $('allowStatus').textContent = (outside.length ? 'Nothing added.' : 'Those are already on the list.') + skipNote; return; }
    $('allowStatus').textContent = 'Adding…';
    try {
      for (let i = 0; i < fresh.length; i += 400) {
        const batch = writeBatch(db);
        for (const addr of fresh.slice(i, i + 400)) batch.set(doc(db, 'allowed', addr), { addedAt: Date.now() });
        await batch.commit();
      }
      $('allowInput').value = '';
      $('allowStatus').textContent = `Added ${fresh.length}. They can now join with the invite link.` + skipNote;
    } catch (err) { $('allowStatus').textContent = 'Couldn\'t add: ' + (err.message || err.code); }
  };
