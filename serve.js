// Zero-dependency LAN server for the Rakija Contest (host page + judge page).
//   node serve.js                      -> http://<LAN-IP>:8080
//   ADMIN_PIN=1234 node serve.js
// Everything lives in state.json (read by both pages through this server).
//   Role picker : /
//   Host page   : /admin  (PIN protected API: x-admin-pin header)
//   Judge page  : /sudac
//   Viewer page : /gledatelj  (its API needs the viewer PIN: x-viewer-pin header)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 8080;
const DIR = __dirname;
const STATE = path.join(DIR, process.env.STATE_FILE || 'state.json');
const PIN_FILE = path.join(DIR, '.admin_pin');
const MAX_BODY = 256 * 1024;
const CATS = 4;
// shared logic (ranking, finaleView, ...) is the same file the pages load
const L = new Function(fs.readFileSync(path.join(DIR, 'logic.js'), 'utf8') + '; return { scoreOf, finaleView };')();

// ---- admin PIN: env > saved file > random (saved so a restart keeps it) ----
function loadPin() {
  if (process.env.ADMIN_PIN) return String(process.env.ADMIN_PIN);
  try { const p = fs.readFileSync(PIN_FILE, 'utf8').trim(); if (p) return p; } catch (e) {}
  const p = String(crypto.randomInt(1000, 10000));
  fs.writeFileSync(PIN_FILE, p + '\n', { mode: 0o600 });
  return p;
}
const PIN = loadPin();
const same = (a, b) => { a = Buffer.from(String(a || '')); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const pinOk = req => same(req.headers['x-admin-pin'], PIN);

// Viewer PIN: a second PIN for /gledatelj, handed out only to viewers (judges must not have it).
function loadViewerPin() {
  if (process.env.VIEWER_PIN) return String(process.env.VIEWER_PIN);
  const f = path.join(DIR, '.viewer_pin');
  try { const p = fs.readFileSync(f, 'utf8').trim(); if (p && p !== PIN) return p; } catch (e) {}
  let p; do { p = String(crypto.randomInt(1000, 10000)); } while (p === PIN);
  fs.writeFileSync(f, p + '\n', { mode: 0o600 });
  return p;
}
const VIEWER_PIN = loadViewerPin();
const viewerOk = req => same(req.headers['x-viewer-pin'], VIEWER_PIN) || pinOk(req);   // admin may also watch

// ---- state ----
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (!s || !Array.isArray(s.jurors)) return null;
    s.owners = s.owners || {}; s.scores = s.scores || {}; s.cats = s.cats || {}; s.claims = s.claims || {};
    s.locked = !!s.locked; s.open = Number.isInteger(s.open) ? s.open : -1;
    s.finale = s.finale && Number.isInteger(s.finale.step) ? { step: s.finale.step } : null;
    return s;
  } catch (e) { return null; }
}
function writeState(s) {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STATE);   // atomic
}
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const goodToken = t => typeof t === 'string' && /^[a-f0-9]{16,64}$/.test(t);
const claimOf = (st, token) => Object.keys(st.claims).find(k => st.claims[k] === token);

// Admin view: full state, but claim tokens are reduced to booleans.
function adminView(s) {
  const claims = {}; Object.keys(s.claims).forEach(k => { claims[k] = true; });
  return Object.assign({}, s, { claims, viewerPin: VIEWER_PIN });
}

// Admin writes only the fields it owns; judge-owned data (cats, claims) is kept from disk.
function mergeAdmin(cur, inc) {
  const ok = inc && Array.isArray(inc.jurors) && inc.jurors.length >= 1 && inc.jurors.length <= 20 &&
    inc.jurors.every(j => typeof j === 'string' && j.trim() && j.length <= 100) &&
    isInt(inc.n, 1, 20) && isInt(inc.open ?? -1, -1, inc.n) &&
    inc.owners && typeof inc.owners === 'object' && inc.scores && typeof inc.scores === 'object' &&
    (!inc.finale || isInt(inc.finale.step, 0, 100));
  if (!ok) return null;
  const jurorsChanged = cur && JSON.stringify(cur.jurors) !== JSON.stringify(inc.jurors);
  return {
    jurors: inc.jurors, n: inc.n, owners: inc.owners, scores: inc.scores,
    locked: !!inc.locked, open: inc.open ?? -1, finale: inc.finale ? { step: inc.finale.step } : null,
    cats: cur && !jurorsChanged ? cur.cats : {}, claims: cur && !jurorsChanged ? cur.claims : {},
  };
}

// ---- judge API ----
function judgeInfo(token) {
  const st = readState();
  if (!st) return { locked: false, n: 0, open: -1, jurors: [], me: null, name: null, mine: {} };
  const me = goodToken(token) ? claimOf(st, token) : undefined;
  const mine = {};
  if (me !== undefined) Object.keys(st.cats).forEach(r => { const c = st.cats[r][me]; if (c) mine[r] = c; });
  return {
    locked: st.locked, n: st.n, open: st.open,
    jurors: st.locked ? st.jurors.map((name, i) => ({ name, taken: !!st.claims[i] && st.claims[i] !== token })) : [],
    me: me === undefined ? null : Number(me), name: me === undefined ? null : st.jurors[me], mine,
  };
}

function judgeAction(action, body) {
  const st = readState();
  if (!st || !st.locked) return [403, 'postavke nisu zaključane'];
  if (!goodToken(body.token)) return [400, 'bad token'];
  const mine = claimOf(st, body.token);
  if (action === 'claim') {
    if (!isInt(body.juror, 0, st.jurors.length - 1)) return [400, 'bad juror'];
    if (mine !== undefined && Number(mine) !== body.juror) return [409, 'već si prijavljen'];
    if (st.claims[body.juror] && st.claims[body.juror] !== body.token) return [409, 'zauzeto'];
    st.claims[body.juror] = body.token;
  } else if (action === 'release') {   // judge undoes a mis-tap, only before locking any score
    if (mine === undefined) return [403, 'nisi prijavljen'];
    const locked = Object.keys(st.cats).some(r => st.cats[r][mine] && st.cats[r][mine].locked);
    if (locked) return [409, 'već si zaključio ocjenu'];
    delete st.claims[mine];
  } else if (action === 'score') {
    if (mine === undefined) return [403, 'nisi prijavljen'];
    if (!isInt(body.round, 0, st.n) || body.round > st.open) return [403, 'runda nije otvorena'];
    const c = body.c;
    if (!Array.isArray(c) || c.length !== CATS || !c.every(v => v === null || isInt(v, 1, 10))) return [400, 'bad scores'];
    const cur = (st.cats[body.round] || {})[mine];
    if (cur && cur.locked) return [409, 'ocjena je već zaključena'];
    if (body.lock && c.some(v => v === null)) return [400, 'ocijeni sve kategorije'];
    st.cats[body.round] = st.cats[body.round] || {};
    st.cats[body.round][mine] = { c, locked: !!body.lock };
  } else return [404, 'unknown'];
  writeState(st);
  return [200, null];
}

// ---- viewer API ----
// Locked ratings of every judge for every opened rakija. A round's ratings appear only once ALL judges
// have a score for it (so nobody can peek while still rating). No averages/ranking/owners before the finale.
function viewerInfo() {
  const st = readState();
  if (!st) return { locked: false, n: 0, open: -1, rounds: [], finale: null };
  const rounds = [];
  for (let r = 0; r <= Math.min(st.open, st.n); r++) {
    const ratings = st.jurors.map((name, i) => {
      const cell = (st.cats[r] || {})[i];
      return { name, c: cell && cell.locked ? cell.c : null, avg: L.scoreOf(st, r, i) };
    });
    const done = ratings.filter(x => x.avg !== null).length;
    rounds.push({ round: r, done, total: st.jurors.length, ratings: done === st.jurors.length ? ratings : null });
  }
  return { locked: st.locked, n: st.n, open: st.open, rounds, finale: L.finaleView(st) };
}

// ---- http ----
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json');
const FILES = { '/style.css': ['style.css', 'text/css; charset=utf-8'], '/logic.js': ['logic.js', 'text/javascript; charset=utf-8'], '/common.js': ['common.js', 'text/javascript; charset=utf-8'] };
const page = (res, f) => send(res, 200, fs.readFileSync(path.join(DIR, f)), 'text/html; charset=utf-8');

function readBody(req, res, cb) {
  const chunks = []; let size = 0, tooBig = false;
  req.on('data', c => { size += c.length; if (size > MAX_BODY) tooBig = true; else chunks.push(c); });
  req.on('end', () => {
    if (tooBig) return send(res, 413, 'too large');
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { send(res, 400, 'bad request'); }
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET') {
    if (url === '/' || url === '/index.html') return page(res, 'index.html');
    if (url === '/admin') return page(res, 'ocjenjivanje.html');
    if (url === '/sudac') return page(res, 'sudac.html');
    if (url === '/gledatelj') return page(res, 'gledatelj.html');
    if (FILES[url]) return send(res, 200, fs.readFileSync(path.join(DIR, FILES[url][0])), FILES[url][1]);
  }

  // public, read-only: what the host has revealed in the finale (nothing unrevealed is included)
  if (url === '/api/finale' && req.method === 'GET') { const st = readState(); return sendJson(res, 200, st ? L.finaleView(st) : null); }
  if (url === '/api/v/info' && req.method === 'GET') return viewerOk(req) ? sendJson(res, 200, viewerInfo()) : send(res, 401, 'pin');

  // judge API (no PIN): sees only its own data
  if (url === '/api/j/info' && req.method === 'GET') return sendJson(res, 200, judgeInfo(req.headers['x-token']));
  const m = url.match(/^\/api\/j\/(claim|release|score)$/);
  if (m && req.method === 'POST') {
    return readBody(req, res, body => {
      const [code, err] = judgeAction(m[1], body);
      err ? send(res, code, err) : sendJson(res, 200, judgeInfo(body.token));
    });
  }

  // admin API (PIN)
  if (url.startsWith('/api/')) {
    if (!pinOk(req)) return send(res, 401, 'pin');
    if (url === '/api/state' && req.method === 'GET') { const s = readState(); return sendJson(res, 200, s ? adminView(s) : null); }
    if (url === '/api/state' && req.method === 'PUT') {
      return readBody(req, res, body => {
        const merged = mergeAdmin(readState(), body);
        if (!merged) return send(res, 400, 'bad request');
        writeState(merged); send(res, 204, '');
      });
    }
    if (url === '/api/admin/release' && req.method === 'POST') {
      return readBody(req, res, body => {
        const st = readState(); if (!st) return send(res, 404, 'no state');
        delete st.claims[body.juror]; writeState(st); send(res, 204, '');
      });
    }
    if (url === '/api/admin/reopen' && req.method === 'POST') {   // let a judge redo a locked score
      return readBody(req, res, body => {
        const st = readState(); const cell = st && ((st.cats[body.round] || {})[body.juror]);
        if (!cell) return send(res, 404, 'no such score');
        cell.locked = false; writeState(st); send(res, 204, '');
      });
    }
    if (url === '/api/admin/reset' && req.method === 'POST') {
      try { fs.unlinkSync(STATE); } catch (e) {}
      return send(res, 204, '');
    }
  }
  send(res, 404, 'not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  const urls = p => ips.map(a => 'http://' + a + ':' + PORT + p).join('   ');
  console.log('Rakija Contest server running.\n');
  console.log('  ADMIN PIN: ' + PIN + '   VIEWER PIN: ' + VIEWER_PIN + '\n');
  console.log('  Host (admin) : ' + urls('/admin'));
  console.log('  Judges       : ' + urls('/sudac'));
  console.log('  Viewers      : ' + urls('/gledatelj'));
});
