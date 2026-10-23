// Staff check-in on the board: name, 4-digit PIN, then start shift / break / back / finish.
// Plain ES5 with web requests (no Firebase library), so it runs on the same old iPads as the board.
// The iPad signs up to Firebase anonymously; an editor registers it once by typing the code it shows.
// Check-ins are saved on the iPad first and sent when the Wi-Fi allows, so a drop doesn't lose them.
(function () {
  "use strict";

  var CFG = window.TG_FIREBASE || {};
  var PREVIEW = /[?&]preview\b/.test(location.search);
  var KEY = encodeURIComponent(CFG.apiKey || "");
  var DB = "projects/" + CFG.projectId + "/databases/(default)/documents";
  var API = "https://firestore.googleapis.com/v1/" + DB;
  var CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var IDLE_MS = 30000, DONE_MS = 4000, MAX_TRIES = 5, LOCK_MS = 60000;
  var DAYS3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  var session = load("tg-session") || {};       // { uid, idToken, refreshToken, expires }
  var pending = load("tg-pending") || [];        // check-ins not yet sent
  var staff = load("tg-staff") || [], today = [];
  var registered = false, deviceName = "", pairCode = "";
  // loading | ready | failed. lastError is shown on screen, so a problem on the iPad can be read out.
  var state = "loading", lastError = "";
  var who = null, pin = "", tries = {}, idleTimer = 0, doneTimer = 0, regTimer = 0, flushing = false;
  window.TG_CHECKIN = "started";

  function $(id) { return document.getElementById(id); }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function dayKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function time(t) { var d = new Date(t), h = d.getHours(); return (h % 12 || 12) + ":" + pad(d.getMinutes()) + (h < 12 ? "am" : "pm"); }
  function dur(ms) { var m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m"; }
  function greet() { var h = new Date().getHours(); return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening"; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function randomString(chars, n) {
    var bytes = new Uint8Array(n), out = "", i;
    window.crypto.getRandomValues(bytes);
    for (i = 0; i < n; i++) out += chars.charAt(bytes[i] % chars.length);
    return out;
  }
  // Nearest ancestor (or self) with the attribute, for tap handling.
  function up(el, attr) {
    while (el && el.getAttribute) { if (el.getAttribute(attr) != null) return el; el = el.parentNode; }
    return null;
  }

  // SHA-256 as hex, for checking PINs (must match the editor's crypto.subtle hash). Public-domain compact version.
  function sha256(ascii) {
    function rr(v, n) { return (v >>> n) | (v << (32 - n)); }
    var maxWord = Math.pow(2, 32), result = "", words = [], bitLength = ascii.length * 8;
    var hash = [], k = [], primes = 0, composite = {}, i, j, c;
    for (c = 2; primes < 64; c++) {
      if (!composite[c]) {
        for (i = 0; i < 313; i += c) composite[i] = c;
        hash[primes] = (Math.pow(c, 0.5) * maxWord) | 0;
        k[primes++] = (Math.pow(c, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += "\x80";
    while (ascii.length % 64 - 56) ascii += "\x00";
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return "";
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (bitLength / maxWord) | 0;
    words[words.length] = bitLength;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16), old = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4];
        var t1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[i] +
          (w[i] = i < 16 ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        var t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(t1 + t2) | 0].concat(hash);
        hash[4] = (hash[4] + t1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + old[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) { c = (hash[i] >> (j * 8)) & 255; result += (c < 16 ? "0" : "") + c.toString(16); }
    }
    return result;
  }
  function pinHash(staffId, digits) { return sha256("tgnb:" + staffId + ":" + digits); }

  /* ---------- Web requests to Firebase ---------- */

  // done(err, data). err.status is the HTTP status, or 0 when there was no answer.
  function request(method, url, body, withAuth, done) {
    var x = new XMLHttpRequest();
    x.open(method, url);
    x.timeout = 20000;
    if (withAuth) x.setRequestHeader("Authorization", "Bearer " + session.idToken);
    if (typeof body === "string") x.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
    else if (body) x.setRequestHeader("Content-Type", "application/json");
    x.onload = function () {
      var data = null;
      try { data = JSON.parse(x.responseText); } catch (e) {}
      if (x.status >= 200 && x.status < 300) { done(null, data); return; }
      var er = data && (data.error && data.error.message ? data.error : data[0] && data[0].error);
      done({ status: x.status, message: (er && (er.message || er.status)) || "HTTP " + x.status });
    };
    x.onerror = x.ontimeout = function () { done({ status: 0, message: "no connection" }); };
    x.send(body == null ? null : typeof body === "string" ? body : JSON.stringify(body));
  }

  function setSession(uid, idToken, refreshToken, expiresIn) {
    session = { uid: uid, idToken: idToken, refreshToken: refreshToken, expires: Date.now() + (+expiresIn || 3600) * 1000 };
    save("tg-session", session);
  }

  // Calls fn(err) once there's a fresh sign-in token, signing this iPad up the first time.
  function withToken(fn) {
    if (session.idToken && session.expires > Date.now() + 60000) { fn(null); return; }
    if (session.refreshToken) {
      request("POST", "https://securetoken.googleapis.com/v1/token?key=" + KEY,
        "grant_type=refresh_token&refresh_token=" + encodeURIComponent(session.refreshToken), false, function (err, d) {
          if (err && err.status === 400) {  // this iPad's sign-in was removed: start again (it will need registering)
            session = {};
            save("tg-session", session);
            withToken(fn);
            return;
          }
          if (err) { fn(err); return; }
          setSession(d.user_id, d.id_token, d.refresh_token, d.expires_in);
          fn(null);
        });
      return;
    }
    request("POST", "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + KEY, { returnSecureToken: true }, false, function (err, d) {
      if (err) { fn(err); return; }
      setSession(d.localId, d.idToken, d.refreshToken, d.expiresIn);
      fn(null);
    });
  }

  // A signed-in request to the database. path starts with "/" or ":".
  function api(method, path, body, done) {
    withToken(function (err) {
      if (err) { done(err); return; }
      var url = API + path + (path.indexOf("?") < 0 ? "?" : "&") + "key=" + KEY;
      request(method, url, body, true, function (err2, d) {
        if (err2 && err2.status === 401) {  // token went stale: get a new one and try once more
          session.expires = 0;
          withToken(function (err3) { if (err3) done(err3); else request(method, url, body, true, done); });
          return;
        }
        done(err2, d);
      });
    });
  }

  function value(v) {
    if ("stringValue" in v) return v.stringValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("integerValue" in v) return +v.integerValue;
    if ("doubleValue" in v) return v.doubleValue;
    if ("timestampValue" in v) return new Date(v.timestampValue.replace(/(\.\d{3})\d+/, "$1")).getTime();
    if ("mapValue" in v) return plain(v.mapValue.fields);
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(value);
    return null;
  }
  function plain(fields) {
    var out = {}, k;
    for (k in fields || {}) { if (fields.hasOwnProperty(k)) out[k] = value(fields[k]); }
    return out;
  }

  // Documents in a collection matching one field: done(err, [{ id, ...fields }]).
  function query(collection, field, val, done) {
    var where = { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: val } };
    api("POST", ":runQuery", { structuredQuery: { from: [{ collectionId: collection }], where: where } }, function (err, rows) {
      if (err) { done(err); return; }
      var docs = [];
      (rows || []).forEach(function (r) {
        if (!r.document) return;
        var d = plain(r.document.fields);
        d.id = r.document.name.split("/").pop();
        docs.push(d);
      });
      done(null, docs);
    });
  }

  // One write, with a server-time field and a precondition, through the commit call.
  function commit(path, fields, timeField, mustExist, done) {
    var write = { update: { name: DB + "/" + path, fields: fields }, currentDocument: { exists: mustExist } };
    if (timeField) write.updateTransforms = [{ fieldPath: timeField, setToServerValue: "REQUEST_TIME" }];
    if (mustExist) write.updateMask = { fieldPaths: Object.keys(fields) };
    api("POST", ":commit", { writes: [write] }, done);
  }

  /* ---------- This iPad ---------- */

  function start() {
    state = "loading";
    withToken(function (err) {
      if (err) {
        state = "failed";
        lastError = "Signing in: " + err.message;
        setTimeout(start, 60000);  // perhaps offline: try again in a minute
        return;
      }
      state = "ready";
      lastError = "";
      checkDevice();
    });
  }

  function checkDevice(done) {
    api("GET", "/devices/" + session.uid, null, function (err, d) {
      var was = registered;
      if (!err) {
        registered = true;
        deviceName = plain(d.fields).name || "Shop iPad";
      } else if (err.status === 404) {
        registered = false;
      } else {
        lastError = "Checking registration: " + err.message;  // keep the last answer
      }
      if (registered && !was) { refresh(); heartbeat(); flush(); }
      if (!registered && !err) postCode();
      if (!registered && err && err.status === 404) postCode();
      if (done) done();
    });
  }

  // The code an editor types to register this iPad. It stays the same until the iPad's sign-in changes.
  function postCode() {
    var saved = load("tg-pair") || {};
    if (saved.uid !== session.uid || !saved.code) {
      saved = { uid: session.uid, code: randomString(CODE_CHARS, 6) };
      save("tg-pair", saved);
    }
    pairCode = saved.code;
    // Refused when this code was already posted, which is fine; anything else is worth showing.
    commit("pairing/" + pairCode, { uid: { stringValue: session.uid } }, "createdAt", false, function (err) {
      if (err && err.status !== 400 && err.status !== 403 && err.status !== 409) lastError = "Posting the code: " + err.message;
    });
    if (isOpen() && onStep("setup")) showSetup();
  }

  function heartbeat() {
    commit("devices/" + session.uid, {}, "lastSeen", true, function () {});
  }

  // Fresh names and today's check-ins. Read when the check-in screen opens, to keep database reads low.
  function refresh(done) {
    var left = 2;
    function one(err, what) {
      if (err) lastError = what + ": " + err.message;
      if (--left === 0) {
        if (isOpen() && onStep("who")) renderWho();
        if (done) done();
      }
    }
    query("staff", "active", { booleanValue: true }, function (err, docs) {
      if (!err) {
        staff = docs.sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); });
        save("tg-staff", staff);
      }
      one(err, "Loading names");
    });
    query("events", "day", { stringValue: dayKey(new Date()) }, function (err, docs) {
      if (!err) today = docs.filter(function (e) { return !e.void && e.at; });
      one(err, "Loading today's check-ins");
    });
  }

  // Sends saved check-ins, oldest first. One the database refuses (say this iPad was unregistered) is dropped
  // and reported; with no connection they wait for the next try.
  function flush(done) {
    if (flushing || !pending.length) { if (done) done(false); return; }
    flushing = true;
    var ev = pending[0];
    commit("events/" + ev.id, {
      staffId: { stringValue: ev.staffId }, name: { stringValue: ev.name }, type: { stringValue: ev.type },
      at: { timestampValue: new Date(ev.at).toISOString() }, day: { stringValue: ev.day }, device: { stringValue: session.uid }
    }, "savedAt", false, function (err) {
      flushing = false;
      if (err && err.status === 0) { if (done) done(false); return; }
      pending.shift();
      save("tg-pending", pending);
      if (!err) today.push(ev);
      if (err && !/precondition|already exists/i.test(err.message)) {  // "already exists" means an earlier try got through
        lastError = "Saving a check-in: " + err.message;
        if (done) done(true);
        flush();
        return;
      }
      flush(done);
    });
  }

  // Where a barber is up to today: out, in, break or done. Includes check-ins still waiting to send.
  function stateOf(p) {
    var s = { st: "out", since: 0, started: 0, breakMs: 0, brkFrom: 0 }, key = dayKey(new Date());
    today.concat(pending.filter(function (e) { return e.day === key; }))
      .filter(function (e) { return e.staffId === p.id; })
      .sort(function (a, b) { return a.at - b.at; })
      .forEach(function (e) {
        if (e.type === "start") { s.st = "in"; s.since = s.started = e.at; s.breakMs = 0; s.brkFrom = 0; }
        else if (e.type === "break" && s.st === "in") { s.st = "break"; s.since = s.brkFrom = e.at; }
        else if (e.type === "back" && s.st === "break") { s.st = "in"; s.breakMs += e.at - s.brkFrom; s.since = e.at; s.brkFrom = 0; }
        else if (e.type === "finish" && (s.st === "in" || s.st === "break")) {
          if (s.st === "break") s.breakMs += e.at - s.brkFrom;
          s.st = "done";
          s.since = e.at;
          s.brkFrom = 0;
        }
      });
    return s;
  }

  /* ---------- Screens ---------- */

  var CSS = [
    ".top .ci-btn { margin-left: auto; height: 2.65rem; padding: 0 1.1rem; border-radius: 1.4rem; border: 2px solid #E1000A; background: #000; color: #fff; display: flex; align-items: center; font-size: 1.05rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; cursor: pointer; touch-action: manipulation; }",
    ".top .ci-btn svg { width: 1.3rem; height: 1.3rem; margin-right: .55rem; }",
    ".top.ci-has .top-title { margin-left: 1.4rem; }",
    ".ci-ov { position: absolute; top: 0; right: 0; bottom: 0; left: 0; z-index: 50; display: none; flex-direction: column; background: #080808; padding: 1.6rem 2.2rem 1.8rem; color: #fff; touch-action: manipulation; }",
    ".ci-ov.on { display: flex; }",
    ".ci-ov button { font-family: -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #fff; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: rgba(0,0,0,0); }",
    ".ci-ov button.cond { font-family: 'Avenir Next Condensed', 'Bahnschrift SemiCondensed', 'Arial Narrow', sans-serif; }",
    ".ci-ov [hidden] { display: none !important; }",
    ".ci-head { display: flex; align-items: center; min-height: 3.4rem; }",
    ".ci-ov .ci-back { height: 3rem; padding: 0 1.1rem 0 .8rem; border-radius: 1.5rem; border: 0; background: #1f1f1f; font-size: 1.05rem; font-weight: 700; margin-right: 1rem; }",
    ".ci-title { font-size: 2.3rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; line-height: 1; }",
    ".ci-sub { color: #9a9a9a; font-size: 1.05rem; margin-top: .35rem; }",
    ".ci-ov .ci-x { margin-left: auto; width: 3.4rem; height: 3.4rem; border-radius: 50%; border: 0; background: #1f1f1f; font-size: 1.9rem; line-height: 1; padding: 0; }",
    ".ci-step { display: none; flex: 1; min-height: 0; }",
    ".ci-step.on { display: flex; }",
    ".ci-who { flex: 1; display: flex; flex-wrap: wrap; align-content: flex-start; margin: .9rem -.5rem 0; }",
    ".ci-ov .ci-tile { margin: .5rem; border: 1px solid #2a2a2a; border-radius: 1rem; background: #161616; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: .5rem; }",
    ".ci-ov .ci-tile:active { background: #222; }",
    ".ci-av { width: 4.4rem; height: 4.4rem; border-radius: 50%; background: #2a2a2a; display: flex; align-items: center; justify-content: center; font-size: 1.7rem; font-weight: 800; }",
    ".ci-nm { font-size: 1.6rem; font-weight: 800; margin: .5rem 0; }",
    ".ci-st { font-size: .9rem; font-weight: 700; padding: .25rem .7rem; border-radius: 1rem; background: #262626; color: #a5a5a5; }",
    ".ci-st.in { background: rgba(52, 199, 123, .16); color: #34c77b; }",
    ".ci-st.brk { background: rgba(242, 169, 59, .16); color: #f2a93b; }",
    ".ci-center { flex: 1; flex-direction: column; align-items: center; justify-content: center; text-align: center; }",
    ".ci-dots { display: flex; margin: .4rem 0 1.4rem; }",
    ".ci-dots i { width: 1.25rem; height: 1.25rem; border-radius: 50%; border: 2px solid #777; margin: 0 .55rem; }",
    ".ci-dots i.f { background: #fff; border-color: #fff; }",
    ".ci-bad .ci-dots { -webkit-animation: ci-shake .4s; animation: ci-shake .4s; }",
    ".ci-bad .ci-dots i { border-color: #E1000A; }",
    "@-webkit-keyframes ci-shake { 20%, 60% { -webkit-transform: translateX(-.7rem); } 40%, 80% { -webkit-transform: translateX(.7rem); } }",
    "@keyframes ci-shake { 20%, 60% { transform: translateX(-.7rem); } 40%, 80% { transform: translateX(.7rem); } }",
    ".ci-msg { min-height: 1.4rem; color: #ff6b6b; font-weight: 700; margin-bottom: .6rem; }",
    ".ci-pad { width: 20.4rem; text-align: center; font-size: 0; }",
    ".ci-ov .ci-key { display: inline-block; vertical-align: top; width: 5.4rem; height: 5.4rem; margin: .45rem .7rem; border-radius: 50%; border: 0; background: #1f1f1f; font-size: 2.1rem; font-weight: 600; padding: 0; }",
    ".ci-ov .ci-key:active { background: #333; }",
    ".ci-ov .ci-key.sm { background: transparent; font-size: 1.05rem; font-weight: 700; color: #bbb; }",
    ".ci-now { font-size: 1.3rem; color: #cfcfcf; margin: .3rem 0 2rem; }",
    ".ci-acts { display: flex; }",
    ".ci-ov .ci-big { min-width: 15rem; height: 6.4rem; margin: 0 .6rem; border-radius: 1.2rem; border: 0; font-size: 1.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 0 1.2rem; }",
    ".ci-go { background: #1f9d5c; } .ci-brk { background: #c98110; } .ci-end { background: #E1000A; }",
    ".ci-tick { width: 7rem; height: 7rem; border-radius: 50%; background: #1f9d5c; display: flex; align-items: center; justify-content: center; margin-bottom: 1.4rem; }",
    ".ci-tick.err { background: #E1000A; }",
    ".ci-tick svg { width: 3.6rem; height: 3.6rem; }",
    ".ci-big-h { margin: 0; font-size: 2.8rem; font-weight: 800; text-transform: uppercase; }",
    ".ci-p { font-size: 1.35rem; color: #cfcfcf; margin: .6rem 0 0; max-width: 40rem; line-height: 1.4; }",
    ".ci-code { font-family: Menlo, Consolas, monospace; font-size: 4.4rem; font-weight: 700; letter-spacing: .3em; margin: 1.2rem 0 .4rem; padding-left: .3em; }"
  ].join("\n");

  var TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var BANG = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M12 6v8M12 18v.5"/></svg>';

  function buildUI() {
    var st = document.createElement("style");
    st.appendChild(document.createTextNode(CSS));
    document.getElementsByTagName("head")[0].appendChild(st);

    var top = document.querySelector(".top"), btn = document.createElement("button");
    btn.className = "ci-btn cond";
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/></svg>Staff check-in';
    top.insertBefore(btn, top.querySelector(".top-title"));
    top.className += " ci-has";
    btn.addEventListener("click", function () {
      if (registered) { openWho(); return; }
      showSetup();
      show();
      // It may have been registered since the last check: look now rather than wait.
      if (state === "ready") checkDevice(function () { if (registered && isOpen() && onStep("setup")) openWho(); });
    });

    var keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, "Clear", 0, "Delete"].map(function (k) {
      return '<button class="ci-key' + (typeof k === "string" ? " sm" : "") + '" data-k="' + k + '">' + k + "</button>";
    }).join("");
    var ov = document.createElement("div");
    ov.className = "ci-ov";
    ov.id = "ci-ov";
    ov.innerHTML =
      '<div class="ci-head">' +
        '<button class="ci-back" id="ci-back" hidden>&lsaquo; Back</button>' +
        '<div><div class="ci-title cond" id="ci-title"></div><div class="ci-sub" id="ci-sub"></div></div>' +
        '<button class="ci-x" id="ci-close" aria-label="Close">&times;</button>' +
      "</div>" +
      '<div class="ci-step" id="ci-who-step"><div class="ci-who" id="ci-who"></div></div>' +
      '<div class="ci-step ci-center" id="ci-pin-step">' +
        '<div class="ci-dots" id="ci-dots"><i></i><i></i><i></i><i></i></div>' +
        '<div class="ci-msg" id="ci-msg"></div>' +
        '<div class="ci-pad" id="ci-pad">' + keys + "</div>" +
      "</div>" +
      '<div class="ci-step ci-center" id="ci-act-step"><div class="ci-now" id="ci-now"></div><div class="ci-acts" id="ci-acts"></div></div>' +
      '<div class="ci-step ci-center" id="ci-done-step">' +
        '<div class="ci-tick" id="ci-tick"></div><h2 class="ci-big-h cond" id="ci-done-h"></h2><p class="ci-p" id="ci-done-p"></p>' +
      "</div>" +
      '<div class="ci-step ci-center" id="ci-setup-step"><div id="ci-setup"></div></div>';
    document.body.appendChild(ov);

    $("ci-close").addEventListener("click", close);
    $("ci-back").addEventListener("click", function () { if (onStep("act")) showPin(); else openWho(); });
    $("ci-who").addEventListener("click", function (e) {
      var t = up(e.target, "data-id"), i;
      if (!t) return;
      for (i = 0; i < staff.length; i++) if (staff[i].id === t.getAttribute("data-id")) who = staff[i];
      if (who) showPin();
    });
    $("ci-pad").addEventListener("click", function (e) {
      var t = up(e.target, "data-k");
      if (t) key(t.getAttribute("data-k"));
    });
    $("ci-acts").addEventListener("click", function (e) {
      var t = up(e.target, "data-type");
      if (t) record(t.getAttribute("data-type"));
    });
    ov.addEventListener("click", poke);

    // Holding the clock for 5 seconds shows this iPad's registration details.
    var clock = document.querySelector(".col-info .panel"), hold = 0;
    function startHold() { clearTimeout(hold); hold = setTimeout(function () { showSetup(); show(); }, 5000); }
    function endHold() { clearTimeout(hold); }
    ["touchstart", "mousedown"].forEach(function (ev) { clock.addEventListener(ev, startHold, false); });
    ["touchend", "touchcancel", "mouseup", "mouseleave"].forEach(function (ev) { clock.addEventListener(ev, endHold, false); });
    window.TG_CHECKIN = "shown";
  }

  function isOpen() { return !!$("ci-ov") && $("ci-ov").className.indexOf(" on") >= 0; }
  function onStep(name) { return $("ci-" + name + "-step").className.indexOf(" on") >= 0; }

  function step(name, title, sub) {
    var steps = document.querySelectorAll(".ci-step"), i;
    for (i = 0; i < steps.length; i++) {
      steps[i].className = steps[i].className.replace(/ on\b/g, "") + (steps[i].id === "ci-" + name + "-step" ? " on" : "");
    }
    $("ci-title").textContent = title;
    $("ci-sub").textContent = sub || "";
    $("ci-back").hidden = !(name === "pin" || name === "act");
    poke();
    // While the set-up code is showing, check every few seconds whether an editor has registered this iPad.
    clearInterval(regTimer);
    if (name === "setup" && state === "ready" && !registered) {
      regTimer = setInterval(function () {
        checkDevice(function () { if (registered && isOpen() && onStep("setup")) openWho(); });
      }, 4000);
    }
  }
  function show() { if (!isOpen()) $("ci-ov").className += " on"; poke(); }
  function close() {
    clearTimeout(idleTimer);
    clearTimeout(doneTimer);
    clearInterval(regTimer);
    $("ci-ov").className = $("ci-ov").className.replace(/ on\b/g, "");
    who = null;
    pin = "";
  }
  // Back to the board after 30 seconds without a tap.
  function poke() { clearTimeout(idleTimer); idleTimer = setTimeout(close, IDLE_MS); }

  function showSetup() {
    var problem = lastError ? '<p class="ci-p" style="color:#ff8a8a;font-size:1.05rem">Problem: ' + esc(lastError) + "</p>" : "";
    var build = '<p class="ci-p" style="color:#666;font-size:.9rem">Board version ' + esc(window.TG_BUILD || "?") + "</p>";
    if (state !== "ready") {
      $("ci-setup").innerHTML = (state === "failed"
        ? "<p class=\"ci-p\">Staff check-in couldn't start on this iPad. It keeps trying every minute.</p>"
        : '<p class="ci-p">Staff check-in is still starting. Try again in a moment.</p>') + problem + build;
      step("setup", "Check-in", state === "failed" ? "Not working yet" : "Starting up");
    } else if (registered) {
      $("ci-setup").innerHTML = '<p class="ci-p">This iPad is registered for staff check-in as <b>' + esc(deviceName) + "</b>.</p>" +
        '<p class="ci-p">Barbers and their PINs are managed in the editor, under Shifts.</p>' +
        (pending.length ? '<p class="ci-p">' + pending.length + " check-in(s) waiting to send.</p>" : "") + problem + build;
      step("setup", "Check-in is set up", "");
    } else {
      $("ci-setup").innerHTML = "<p class=\"ci-p\">Staff check-in isn't switched on for this iPad yet. In the editor, open <b>Shifts</b>, then under <b>Shop iPad</b> type this code:</p>" +
        '<div class="ci-code">' + esc(pairCode || "······") + "</div>" +
        "<p class=\"ci-p\">This screen changes by itself once it's done.</p>" + problem + build;
      step("setup", "Set up check-in", "For the shop manager");
    }
  }

  function openWho() {
    who = null;
    renderWho();
    step("who", "Who's checking in?", staff.length ? "Tap your name" : "");
    show();
    refresh();
  }

  function renderWho() {
    var n = staff.length, cols = n <= 4 ? 2 : n <= 6 ? 3 : n <= 12 ? 4 : 5, rows = Math.max(1, Math.ceil(n / cols));
    var w = "calc(" + (100 / cols).toFixed(3) + "% - 1rem)", h = Math.min(16, (36 - rows) / rows).toFixed(2) + "rem";
    $("ci-sub").textContent = n ? "Tap your name" : "";
    if (!n) {
      $("ci-who").innerHTML = '<p class="ci-p" style="margin:.5rem">No barbers yet. The manager adds them in the editor, under Shifts.</p>';
      return;
    }
    $("ci-who").innerHTML = staff.map(function (p) {
      var s = stateOf(p);
      var cls = s.st === "in" ? "in" : s.st === "break" ? "brk" : "";
      var txt = s.st === "in" ? "In since " + time(s.since) : s.st === "break" ? "On break since " + time(s.since) : s.st === "done" ? "Finished " + time(s.since) : "Not in";
      return '<button class="ci-tile" style="width:' + w + ";height:" + h + '" data-id="' + esc(p.id) + '"><span class="ci-av">' +
        esc((p.name || "?").charAt(0).toUpperCase()) + '</span><span class="ci-nm cond">' + esc(p.name) + '</span><span class="ci-st ' + cls + '">' + txt + "</span></button>";
    }).join("");
  }

  function showPin() {
    pin = "";
    drawDots();
    $("ci-msg").textContent = who.pinHash ? "" : who.name + " doesn't have a PIN yet. Ask the manager to set one in the editor.";
    $("ci-pad").style.visibility = who.pinHash ? "" : "hidden";
    step("pin", "Hi " + who.name, who.pinHash ? "Enter your 4-digit PIN" : "");
  }

  function drawDots() {
    var dots = $("ci-dots").children, i;
    for (i = 0; i < dots.length; i++) dots[i].className = i < pin.length ? "f" : "";
  }

  function key(k) {
    var lock = tries[who.id];
    if (lock && lock.until > Date.now()) return;
    $("ci-pin-step").className = $("ci-pin-step").className.replace(/ ci-bad\b/g, "");
    $("ci-msg").textContent = "";
    if (k === "Clear") pin = "";
    else if (k === "Delete") pin = pin.slice(0, -1);
    else if (pin.length < 4) pin += k;
    drawDots();
    if (pin.length === 4) checkPin();
  }

  function checkPin() {
    var p = who, t;
    if (pinHash(p.id, pin) === p.pinHash) {
      delete tries[p.id];
      showActions();
      return;
    }
    t = tries[p.id] = { n: ((tries[p.id] && tries[p.id].n) || 0) + 1, until: 0 };
    void $("ci-pin-step").offsetWidth;  // restart the shake
    $("ci-pin-step").className += " ci-bad";
    pin = "";
    drawDots();
    if (t.n >= MAX_TRIES) {
      t.until = Date.now() + LOCK_MS;
      t.n = 0;
      $("ci-msg").textContent = "Too many wrong tries. Wait a minute, then try again.";
    } else {
      $("ci-msg").textContent = "That PIN didn't match. Try again.";
    }
  }

  function showActions() {
    var s = stateOf(who), now = Date.now(), text, btns;
    if (s.st === "in") {
      text = "Shift started " + time(s.started) + " · " + dur(now - s.started - s.breakMs) + " worked so far";
      btns = [["break", "ci-brk", "Start break"], ["finish", "ci-end", "Finish shift"]];
    } else if (s.st === "break") {
      text = "On break since " + time(s.since) + " · " + dur(now - s.since);
      btns = [["back", "ci-go", "End break"], ["finish", "ci-end", "Finish shift"]];
    } else if (s.st === "done") {
      text = "You finished at " + time(s.since) + " today";
      btns = [["start", "ci-go", "Start shift"]];
    } else {
      text = "Not checked in yet today";
      btns = [["start", "ci-go", "Start shift"]];
    }
    $("ci-now").textContent = text;
    $("ci-acts").innerHTML = btns.map(function (b) {
      return '<button class="ci-big cond ' + b[1] + '" data-type="' + b[0] + '">' + b[2] + "</button>";
    }).join("");
    step("act", greet() + " " + who.name, "");
  }

  function record(type) {
    var p = who, before = stateOf(p), at = new Date(), t = time(at);
    pending.push({ id: randomString(ID_CHARS, 20), staffId: p.id, name: p.name, type: type, at: at.getTime(), day: dayKey(at) });
    save("tg-pending", pending);
    var msg = {
      start: ["Shift started", t + " · Have a good one, " + p.name],
      "break": ["Break started", t + " · Enjoy, " + p.name],
      back: ["Welcome back", t + " · Break was " + dur(at - before.since)],
      finish: ["Shift finished", t + " · " + dur(at - before.started - before.breakMs - (before.st === "break" ? at - before.since : 0)) + " worked today. See ya, " + p.name]
    }[type];
    showDone(true, msg[0], msg[1] + (navigator.onLine === false ? ". Saved on this iPad; it'll send when the Wi-Fi's back." : ""));
    flush(function (refused) {
      if (refused) {
        showDone(false, "That didn't save", "Please tell the manager, so they can add it in the editor.");
        show();
      }
    });
  }

  function showDone(ok, h, p) {
    $("ci-tick").className = ok ? "ci-tick" : "ci-tick err";
    $("ci-tick").innerHTML = ok ? TICK : BANG;
    $("ci-done-h").textContent = h;
    $("ci-done-p").textContent = p;
    step("done", ok ? "All done" : "Something went wrong", "");
    clearTimeout(doneTimer);
    if (ok) doneTimer = setTimeout(close, DONE_MS);
  }

  // Started last, once everything above is defined. The button shows straight away; sign-in happens behind it.
  if (!PREVIEW && CFG.apiKey && CFG.projectId) {
    buildUI();
    start();
    setInterval(function () { if (state === "ready") flush(); }, 30000);           // send anything still waiting
    setInterval(function () { if (state === "ready") checkDevice(); }, 300000);    // notice registration changes
    setInterval(function () { if (registered) heartbeat(); }, 600000);             // tell the editor this iPad is alive
    window.addEventListener("online", function () { if (state === "ready") flush(); });
  }
})();
