// Staff check-in on the board: name, 4-digit PIN, then start shift / break / back / finish.
// Loaded as a module, so very old iPads (which can't run modules) just don't show the button.
// The iPad signs in to Firebase anonymously; an editor registers it once by typing the code it shows.
// Check-ins are saved on the iPad first, so a Wi-Fi drop doesn't lose them.

const CFG = window.TG_FIREBASE || {};
const PREVIEW = /[?&]preview\b/.test(location.search);
const FB = 'https://www.gstatic.com/firebasejs/12.4.0/';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const IDLE_MS = 30000, DONE_MS = 4000, MAX_TRIES = 5, LOCK_MS = 60000;

let A, F, auth, db;
let uid = null, registered = false, deviceName = '', pairCode = '';
let staff = [], today = [], watchingDay = '', unwatch = [];
let who = null, pin = '', tries = {}, idleTimer = 0, doneTimer = 0;

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const time = t => new Date(t).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase();
const dur = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const greet = () => { const h = new Date().getHours(); return h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening'; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

if (!PREVIEW && CFG.apiKey && CFG.projectId) start();

async function start() {
  try {
    const mods = await Promise.all([import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js')]);
    A = mods[1];
    F = mods[2];
    const app = mods[0].initializeApp(CFG, 'checkin');
    auth = A.getAuth(app);
    db = F.initializeFirestore(app, { localCache: F.persistentLocalCache() });
  } catch (err) {
    setTimeout(start, 300000);  // probably offline: try again in 5 minutes
    return;
  }
  buildUI();
  A.onAuthStateChanged(auth, u => {
    if (u) { uid = u.uid; watchDevice(); return; }
    A.signInAnonymously(auth).catch(() => setTimeout(() => A.signInAnonymously(auth).catch(() => {}), 60000));
  });
  setInterval(() => {
    if (registered && dayKey(new Date()) !== watchingDay) watchToday();  // a new day
  }, 60000);
  setInterval(() => {
    if (registered) F.updateDoc(F.doc(db, 'devices', uid), { lastSeen: F.serverTimestamp() }).catch(() => {});
  }, 600000);
}

/* ---------- Firebase ---------- */
function watchDevice() {
  F.onSnapshot(F.doc(db, 'devices', uid), snap => {
    const was = registered;
    registered = snap.exists();
    deviceName = registered ? (snap.data().name || 'Shop iPad') : '';
    if (registered && !was) {
      watchStaff();
      F.updateDoc(F.doc(db, 'devices', uid), { lastSeen: F.serverTimestamp() }).catch(() => {});
      if (isOpen() && onStep('setup')) openWho();
    }
    if (!registered) {
      stopWatching();
      postCode();
      if (isOpen() && onStep('setup')) showSetup();
    }
  }, () => { registered = false; postCode(); });
}

// The code an editor types to register this iPad. It stays the same until the iPad's sign-in changes.
function postCode() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('tg-pair') || '{}'); } catch (e) {}
  if (saved.uid !== uid || !saved.code) {
    saved = { uid, code: Array.from(crypto.getRandomValues(new Uint8Array(6)), b => CODE_CHARS[b % CODE_CHARS.length]).join('') };
    try { localStorage.setItem('tg-pair', JSON.stringify(saved)); } catch (e) {}
  }
  pairCode = saved.code;
  F.setDoc(F.doc(db, 'pairing', pairCode), { uid, createdAt: F.serverTimestamp() }).catch(() => {});  // already posted is fine
}

function watchStaff() {
  stopWatching();
  unwatch.push(F.onSnapshot(F.query(F.collection(db, 'staff'), F.where('active', '==', true)), qs => {
    staff = qs.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (isOpen() && onStep('who')) renderWho();
  }, () => {}));
  watchToday();
}

function watchToday() {
  if (unwatch.length > 1) unwatch.pop()();
  watchingDay = dayKey(new Date());
  today = [];
  unwatch.push(F.onSnapshot(F.query(F.collection(db, 'events'), F.where('day', '==', watchingDay)), qs => {
    today = qs.docs.map(d => d.data()).filter(e => !e.void && e.at).map(e => ({ ...e, at: e.at.toMillis() })).sort((a, b) => a.at - b.at);
    if (isOpen() && onStep('who')) renderWho();
  }, () => {}));
}

function stopWatching() {
  unwatch.forEach(u => u());
  unwatch = [];
  staff = [];
  today = [];
}

async function pinHash(staffId, digits) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`tgnb:${staffId}:${digits}`));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

// Where a barber is up to today: out, in, break or done.
function stateOf(p) {
  const s = { st: 'out', since: 0, started: 0, breakMs: 0, brkFrom: 0 };
  today.filter(e => e.staffId === p.id).forEach(e => {
    if (e.type === 'start') Object.assign(s, { st: 'in', since: e.at, started: e.at, breakMs: 0, brkFrom: 0 });
    else if (e.type === 'break' && s.st === 'in') Object.assign(s, { st: 'break', since: e.at, brkFrom: e.at });
    else if (e.type === 'back' && s.st === 'break') Object.assign(s, { st: 'in', since: e.at, breakMs: s.breakMs + e.at - s.brkFrom, brkFrom: 0 });
    else if (e.type === 'finish' && (s.st === 'in' || s.st === 'break')) {
      if (s.st === 'break') s.breakMs += e.at - s.brkFrom;
      Object.assign(s, { st: 'done', since: e.at, brkFrom: 0 });
    }
  });
  return s;
}

/* ---------- Screens ---------- */
const CSS = `
.top .ci-btn { margin-left: auto; height: 2.65rem; padding: 0 1.1rem; border-radius: 1.4rem; border: 2px solid #E1000A; background: #000; color: #fff; display: flex; align-items: center; gap: .55rem; font-size: 1.05rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; cursor: pointer; touch-action: manipulation; }
.top .ci-btn svg { width: 1.3rem; height: 1.3rem; }
.top.ci-has .top-title { margin-left: 1.4rem; }
.ci-ov { position: absolute; top: 0; right: 0; bottom: 0; left: 0; z-index: 50; display: none; flex-direction: column; background: #080808; padding: 1.6rem 2.2rem 1.8rem; color: #fff; touch-action: manipulation; }
.ci-ov.on { display: flex; }
:where(.ci-ov) button { font: inherit; color: inherit; }
.ci-ov button { cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
.ci-ov [hidden] { display: none !important; }
.ci-head { display: flex; align-items: center; min-height: 3.4rem; }
.ci-back { height: 3rem; padding: 0 1.1rem 0 .8rem; border-radius: 1.5rem; border: 0; background: #1f1f1f; font-size: 1.05rem; font-weight: 700; margin-right: 1rem; }
.ci-title { font-size: 2.3rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; line-height: 1; }
.ci-sub { color: #9a9a9a; font-size: 1.05rem; margin-top: .35rem; }
.ci-x { margin-left: auto; width: 3.4rem; height: 3.4rem; border-radius: 50%; border: 0; background: #1f1f1f; font-size: 1.9rem; line-height: 1; }
.ci-step { display: none; flex: 1; min-height: 0; }
.ci-step.on { display: flex; }
.ci-who { flex: 1; display: grid; grid-auto-rows: 1fr; gap: 1rem; margin-top: 1.4rem; }
.ci-tile { border: 1px solid #2a2a2a; border-radius: 1rem; background: #161616; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .6rem; min-height: 0; padding: .5rem; }
.ci-tile:active { background: #222; }
.ci-av { width: 4.4rem; height: 4.4rem; border-radius: 50%; background: #2a2a2a; display: flex; align-items: center; justify-content: center; font-size: 1.7rem; font-weight: 800; }
.ci-nm { font-size: 1.6rem; font-weight: 800; }
.ci-st { font-size: .9rem; font-weight: 700; padding: .25rem .7rem; border-radius: 1rem; background: #262626; color: #a5a5a5; }
.ci-st.in { background: rgba(52, 199, 123, .16); color: #34c77b; }
.ci-st.brk { background: rgba(242, 169, 59, .16); color: #f2a93b; }
.ci-center { flex: 1; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.ci-dots { display: flex; gap: 1.1rem; margin: .4rem 0 1.4rem; }
.ci-dots i { width: 1.25rem; height: 1.25rem; border-radius: 50%; border: 2px solid #777; }
.ci-dots i.f { background: #fff; border-color: #fff; }
.ci-bad .ci-dots { animation: ci-shake .4s; }
.ci-bad .ci-dots i { border-color: #E1000A; }
@keyframes ci-shake { 20%, 60% { transform: translateX(-.7rem); } 40%, 80% { transform: translateX(.7rem); } }
.ci-msg { min-height: 1.4rem; color: #ff6b6b; font-weight: 700; margin-bottom: .6rem; }
.ci-pad { display: grid; grid-template-columns: repeat(3, 5.4rem); gap: .9rem 1.4rem; }
.ci-key { width: 5.4rem; height: 5.4rem; border-radius: 50%; border: 0; background: #1f1f1f; font-size: 2.1rem; font-weight: 600; }
.ci-key:active { background: #333; }
.ci-key.sm { background: transparent; font-size: 1.05rem; font-weight: 700; color: #bbb; }
.ci-now { font-size: 1.3rem; color: #cfcfcf; margin: .3rem 0 2rem; }
.ci-acts { display: flex; gap: 1.2rem; }
.ci-big { min-width: 15rem; height: 6.4rem; border-radius: 1.2rem; border: 0; font-size: 1.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
.ci-go { background: #1f9d5c; } .ci-brk { background: #c98110; } .ci-end { background: #E1000A; }
.ci-tick { width: 7rem; height: 7rem; border-radius: 50%; background: #1f9d5c; display: flex; align-items: center; justify-content: center; margin-bottom: 1.4rem; }
.ci-tick.err { background: #E1000A; }
.ci-tick svg { width: 3.6rem; height: 3.6rem; }
.ci-big-h { margin: 0; font-size: 2.8rem; font-weight: 800; text-transform: uppercase; }
.ci-p { font-size: 1.35rem; color: #cfcfcf; margin: .6rem 0 0; max-width: 40rem; line-height: 1.4; }
.ci-code { font-family: Menlo, Consolas, monospace; font-size: 4.4rem; font-weight: 700; letter-spacing: .3em; margin: 1.2rem 0 .4rem; padding-left: .3em; }
`;

function buildUI() {
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  const top = document.querySelector('.top');
  const btn = document.createElement('button');
  btn.className = 'ci-btn cond';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/></svg>Staff check-in';
  top.insertBefore(btn, top.querySelector('.top-title'));
  top.classList.add('ci-has');
  btn.addEventListener('click', () => (registered ? openWho() : (showSetup(), show())));

  const ov = document.createElement('div');
  ov.className = 'ci-ov';
  ov.id = 'ci-ov';
  ov.innerHTML = `
    <div class="ci-head">
      <button class="ci-back" id="ci-back" hidden>&lsaquo; Back</button>
      <div><div class="ci-title cond" id="ci-title"></div><div class="ci-sub" id="ci-sub"></div></div>
      <button class="ci-x" id="ci-close" aria-label="Close">&times;</button>
    </div>
    <div class="ci-step" id="ci-who-step"><div class="ci-who" id="ci-who"></div></div>
    <div class="ci-step ci-center" id="ci-pin-step">
      <div class="ci-dots" id="ci-dots"><i></i><i></i><i></i><i></i></div>
      <div class="ci-msg" id="ci-msg"></div>
      <div class="ci-pad" id="ci-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 'Clear', 0, 'Delete'].map(k => `<button class="ci-key${typeof k === 'string' ? ' sm' : ''}" data-k="${k}">${k}</button>`).join('')}</div>
    </div>
    <div class="ci-step ci-center" id="ci-act-step"><div class="ci-now" id="ci-now"></div><div class="ci-acts" id="ci-acts"></div></div>
    <div class="ci-step ci-center" id="ci-done-step">
      <div class="ci-tick" id="ci-tick"></div>
      <h2 class="ci-big-h cond" id="ci-done-h"></h2>
      <p class="ci-p" id="ci-done-p"></p>
    </div>
    <div class="ci-step ci-center" id="ci-setup-step"><div id="ci-setup"></div></div>`;
  document.body.appendChild(ov);

  $('ci-close').addEventListener('click', close);
  $('ci-back').addEventListener('click', () => (onStep('act') ? showPin() : openWho()));
  $('ci-who').addEventListener('click', e => {
    const t = e.target.closest('[data-id]');
    if (!t) return;
    who = staff.find(p => p.id === t.dataset.id);
    if (who) showPin();
  });
  $('ci-pad').addEventListener('click', e => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (k != null) key(k);
  });
  $('ci-acts').addEventListener('click', e => {
    const t = e.target.closest('[data-type]');
    if (t) record(t.dataset.type);
  });
  ov.addEventListener('click', poke);

  // Holding the clock for 5 seconds shows this iPad's registration details.
  const clock = document.querySelector('.col-info .panel');
  let hold = 0;
  const startHold = () => { clearTimeout(hold); hold = setTimeout(() => { showSetup(); show(); }, 5000); };
  const endHold = () => clearTimeout(hold);
  ['touchstart', 'mousedown'].forEach(ev => clock.addEventListener(ev, startHold, { passive: true }));
  ['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(ev => clock.addEventListener(ev, endHold));
}

const isOpen = () => $('ci-ov').classList.contains('on');
const onStep = name => $(`ci-${name}-step`).classList.contains('on');

function step(name, title, sub) {
  document.querySelectorAll('.ci-step').forEach(s => s.classList.toggle('on', s.id === `ci-${name}-step`));
  $('ci-title').textContent = title;
  $('ci-sub').textContent = sub || '';
  $('ci-back').hidden = !(name === 'pin' || name === 'act');
  poke();
}
function show() { $('ci-ov').classList.add('on'); poke(); }
function close() { clearTimeout(idleTimer); clearTimeout(doneTimer); $('ci-ov').classList.remove('on'); who = null; pin = ''; }
// Back to the board after 30 seconds without a tap.
function poke() { clearTimeout(idleTimer); idleTimer = setTimeout(close, IDLE_MS); }

function showSetup() {
  if (registered) {
    $('ci-setup').innerHTML = `<p class="ci-p">This iPad is registered for staff check-in as <b>${esc(deviceName)}</b>.</p>
      <p class="ci-p">Barbers and their PINs are managed in the editor, under Shifts.</p>`;
    step('setup', 'Check-in is set up', '');
  } else {
    $('ci-setup').innerHTML = `<p class="ci-p">Staff check-in isn't switched on for this iPad yet. In the editor, open <b>Shifts</b>, then under <b>Shop iPad</b> type this code:</p>
      <div class="ci-code">${esc(pairCode || '······')}</div>
      <p class="ci-p">This screen changes by itself once it's done.</p>`;
    step('setup', 'Set up check-in', 'For the shop manager');
  }
}

function openWho() {
  who = null;
  renderWho();
  step('who', "Who's checking in?", staff.length ? 'Tap your name' : '');
  show();
}

function renderWho() {
  const n = staff.length, cols = n <= 4 ? 2 : n <= 6 ? 3 : n <= 12 ? 4 : 5;
  $('ci-who').style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  $('ci-sub').textContent = n ? 'Tap your name' : '';
  if (!n) {
    $('ci-who').innerHTML = '<p class="ci-p">No barbers yet. The manager adds them in the editor, under Shifts.</p>';
    return;
  }
  $('ci-who').innerHTML = staff.map(p => {
    const s = stateOf(p);
    const [cls, txt] = s.st === 'in' ? ['in', `In since ${time(s.since)}`] : s.st === 'break' ? ['brk', `On break since ${time(s.since)}`] : s.st === 'done' ? ['', `Finished ${time(s.since)}`] : ['', 'Not in'];
    return `<button class="ci-tile" data-id="${esc(p.id)}"><span class="ci-av">${esc((p.name || '?').charAt(0).toUpperCase())}</span><span class="ci-nm cond">${esc(p.name)}</span><span class="ci-st ${cls}">${txt}</span></button>`;
  }).join('');
}

function showPin() {
  pin = '';
  drawDots();
  $('ci-msg').textContent = who.pinHash ? '' : `${who.name} doesn't have a PIN yet. Ask the manager to set one in the editor.`;
  $('ci-pad').style.visibility = who.pinHash ? '' : 'hidden';
  step('pin', `Hi ${who.name}`, who.pinHash ? 'Enter your 4-digit PIN' : '');
}

function drawDots() {
  Array.from($('ci-dots').children).forEach((d, i) => d.classList.toggle('f', i < pin.length));
}

function key(k) {
  const lock = tries[who.id];
  if (lock && lock.until > Date.now()) return;
  $('ci-pin-step').classList.remove('ci-bad');
  $('ci-msg').textContent = '';
  if (k === 'Clear') pin = '';
  else if (k === 'Delete') pin = pin.slice(0, -1);
  else if (pin.length < 4) pin += k;
  drawDots();
  if (pin.length === 4) checkPin();
}

async function checkPin() {
  const p = who, entered = pin;
  if (await pinHash(p.id, entered) === p.pinHash) {
    delete tries[p.id];
    showActions();
    return;
  }
  const t = tries[p.id] = { n: ((tries[p.id] && tries[p.id].n) || 0) + 1, until: 0 };
  void $('ci-pin-step').offsetWidth;
  $('ci-pin-step').classList.add('ci-bad');
  pin = '';
  drawDots();
  if (t.n >= MAX_TRIES) {
    t.until = Date.now() + LOCK_MS;
    t.n = 0;
    $('ci-msg').textContent = 'Too many wrong tries. Wait a minute, then try again.';
  } else {
    $('ci-msg').textContent = "That PIN didn't match. Try again.";
  }
}

function showActions() {
  const s = stateOf(who), now = Date.now();
  let text, btns;
  if (s.st === 'in') {
    text = `Shift started ${time(s.started)} · ${dur(now - s.started - s.breakMs)} worked so far`;
    btns = [['break', 'ci-brk', 'Start break'], ['finish', 'ci-end', 'Finish shift']];
  } else if (s.st === 'break') {
    text = `On break since ${time(s.since)} · ${dur(now - s.since)}`;
    btns = [['back', 'ci-go', 'End break'], ['finish', 'ci-end', 'Finish shift']];
  } else if (s.st === 'done') {
    text = `You finished at ${time(s.since)} today`;
    btns = [['start', 'ci-go', 'Start shift']];
  } else {
    text = 'Not checked in yet today';
    btns = [['start', 'ci-go', 'Start shift']];
  }
  $('ci-now').textContent = text;
  $('ci-acts').innerHTML = btns.map(([type, cls, label]) => `<button class="ci-big cond ${cls}" data-type="${type}">${label}</button>`).join('');
  step('act', `${greet()} ${who.name}`, '');
}

async function record(type) {
  const p = who, before = stateOf(p), at = new Date();
  const write = F.addDoc(F.collection(db, 'events'), {
    staffId: p.id, name: p.name, type, at: F.Timestamp.fromDate(at), day: dayKey(at), device: uid, savedAt: F.serverTimestamp(),
  });
  const t = time(at);
  const msg = {
    start: ['Shift started', `${t} · Have a good one, ${p.name}`],
    break: ['Break started', `${t} · Enjoy, ${p.name}`],
    back: ['Welcome back', `${t} · Break was ${dur(at - before.since)}`],
    finish: ['Shift finished', `${t} · ${dur(at - before.started - before.breakMs - (before.st === 'break' ? at - before.since : 0))} worked today. See ya, ${p.name}`],
  }[type];
  showDone(true, msg[0], msg[1] + (navigator.onLine ? '' : ". Saved on this iPad; it'll send when the Wi-Fi's back."));
  // A refusal (for example, this iPad was unregistered) comes back quickly; offline saves just wait.
  const result = await Promise.race([write.then(() => 'ok', err => err), new Promise(r => setTimeout(() => r('waiting'), 5000))]);
  if (result instanceof Error) {
    showDone(false, "That didn't save", 'Please tell the manager, so they can add it in the editor.');
    show();
  }
}

function showDone(ok, h, p) {
  $('ci-tick').className = ok ? 'ci-tick' : 'ci-tick err';
  $('ci-tick').innerHTML = ok
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M12 6v8M12 18v.5"/></svg>';
  $('ci-done-h').textContent = h;
  $('ci-done-p').textContent = p;
  step('done', ok ? 'All done' : 'Something went wrong', '');
  clearTimeout(doneTimer);
  if (ok) doneTimer = setTimeout(close, DONE_MS);
}
