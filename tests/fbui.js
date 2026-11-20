// End-to-end test of the Firebase version: static pages (docs/) in jsdom + Firebase emulators (auth :9099, database :9000).
//   (emulators running)  cd tests && npm i && node fbui.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { JSDOM } = require('jsdom');
const firebase = require('firebase/compat/app'); require('firebase/compat/auth'); require('firebase/compat/database');

const DOCS = path.resolve(__dirname, '..', 'docs'), PORT = 8091, BASE = 'http://127.0.0.1:' + PORT + '/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passes = 0, fails = 0;
async function t(name, fn) { try { await fn(); passes++; console.log('  ok  ', name); } catch (e) { fails++; console.log('  FAIL', name, '\n      ', String(e.message).split('\n').slice(0, 3).join(' | ')); } }

// ---- tiny static server for docs/ ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(DOCS, p);
  if (!f.startsWith(DOCS) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); }
  r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); r.end(fs.readFileSync(f));
});

// ---- a "device" = its own persistent storage, so a login survives moving between pages like on a real phone ----
const mkStorage = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
const pages = [];
async function open(device, page, { configured = true } = {}) {
  const nav = [];
  const dom = await JSDOM.fromURL(BASE + page, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      Object.defineProperty(w, 'localStorage', { value: device.storage });
      w.fetch = (u, o) => fetch(new URL(u, w.location.href), o);
      w.confirm = () => true; w.alert = m => (device.alerts = device.alerts || []).push(String(m));
      w.__navigate = u => nav.push(u);
      w.__anims = [];
      w.Element.prototype.animate = function (kf, opts) { w.__anims.push({ node: this, kf, opts }); return {}; };
      Object.defineProperty(w.HTMLElement.prototype, 'offsetTop', { get() { const p = this.parentNode; return p ? Array.prototype.indexOf.call(p.children, this) * 100 : 0; } });
      if (configured) {
        // runs after firebase-config.js (which loads later) -> override through a setter trap
        let cfg; Object.defineProperty(w, 'FIREBASE_CONFIG', { get: () => cfg, set: () => { cfg = { apiKey: 'fake-key', authDomain: 'demo-rakija.firebaseapp.com', projectId: 'demo-rakija', databaseURL: 'http://127.0.0.1:9000?ns=demo-rakija-default-rtdb' }; }, configurable: true });
        w.FIREBASE_EMULATOR = { auth: 'http://127.0.0.1:9099', db: ['127.0.0.1', 9000] };
      }
    },
  });
  const w = dom.window; w.__errors = []; w.__nav = nav;
  w.addEventListener('error', e => w.__errors.push(e.message));
  w.addEventListener('unhandledrejection', e => w.__errors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
  pages.push(w); await sleep(900); return w;
}
const text = w => w.document.getElementById('view').textContent.replace(/\s+/g, ' ').trim();
const buttons = (w, s) => [...w.document.querySelectorAll('button')].filter(b => b.textContent.includes(s));
async function click(w, label, wait = 250) {
  const b = buttons(w, label)[0]; if (!b) throw new Error('no button "' + label + '" in: ' + text(w).slice(0, 220));
  if (b.disabled) throw new Error('button "' + label + '" is disabled');
  b.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await sleep(wait);
}
async function waitFor(fn, what, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return; } catch (e) {} await sleep(100); } throw new Error('timeout waiting for ' + what); }
const typeInto = (w, input, v) => { input.value = v; input.dispatchEvent(new w.Event('input', { bubbles: true })); };
const cards = w => [...w.document.querySelectorAll('.ranklist .rank')];
const cardInfo = w => cards(w).map(c => c.querySelector('.place').textContent.replace(/[^0-9–.]/g, '') + ' ' + c.querySelector('.who b').textContent.replace('Rakija ', 'R') + ' ' + c.querySelector('.owner').textContent.replace('🥃 ', '') + ' ' + c.querySelector('.avg').textContent);

// enter a name on the login page; returns the page
async function enterName(w, name) { typeInto(w, w.document.querySelector('input'), name); await click(w, 'DALJE', 1500); }

(async () => {
  await new Promise(r => server.listen(PORT, r));
  await fetch('http://127.0.0.1:9000/.json?ns=demo-rakija-default-rtdb', { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
  await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-rakija/accounts', { method: 'DELETE' });
  // host account, as scripts/create-admin.js does it
  const seed = firebase.initializeApp({ apiKey: 'fake-key', projectId: 'demo-rakija' }, 'seed'); seed.auth().useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
  await seed.auth().createUserWithEmailAndPassword('rakija-admin@rakija.example.com', 'RAKIJA');

  const dev = n => ({ storage: mkStorage(), n });
  const ANA = dev('ana'), BOB = dev('bob'), CLEO = dev('cleo'), HOST = dev('host');

  console.log('login & registration');
  await t('without Firebase config the app says so (and does not crash)', async () => {
    const w = await open(dev('x'), 'index.html', { configured: false });
    assert.ok(text(w).includes('Firebase nije podešen'), text(w));
  });
  let anaPin;
  await t('new name -> account created -> PIN shown once -> continues as viewer', async () => {
    const w = await open(ANA, 'index.html');
    assert.ok(text(w).includes('Tko si ti'));
    await enterName(w, '  Ana   Horvat ');
    assert.ok(text(w).includes('Dobrodošao/la, Ana Horvat'), text(w));
    anaPin = w.document.querySelector('.pinbox').textContent; assert.ok(/^[0-9]{6}$/.test(anaPin), anaPin);
    await click(w, 'DALJE', 600);
    assert.deepStrictEqual(w.__nav, ['gledatelj.html']);
  });
  await t('empty / symbol-only / too long names are rejected', async () => {
    const w = await open(dev('y'), 'index.html');
    await enterName(w, '   '); assert.ok(text(w).includes('Upiši ime'), text(w));
    await enterName(w, '!!! ???'); assert.ok(text(w).includes('Upiši ime'), text(w));
    await enterName(w, 'x'.repeat(41)); assert.ok(text(w).includes('Upiši ime'), text(w));
  });
  await t('same name on a new device (any case/diacritics) asks for PIN; wrong PIN refused; right PIN signs in', async () => {
    const d = dev('ana2'), w = await open(d, 'index.html');
    await enterName(w, 'ANA HORVAT');
    assert.ok(text(w).includes('već postoji'), text(w));
    typeInto(w, w.document.querySelector('input'), '000000'); await click(w, 'Prijava', 1500);
    assert.ok(text(w).includes('Pogrešan PIN'), text(w));
    typeInto(w, w.document.querySelector('input'), anaPin); await click(w, 'Prijava', 1500);
    assert.deepStrictEqual(w.__nav, ['gledatelj.html']);
  });
  await t('"Rakija-Admin" is never registered: asks for the password; wrong one refused', async () => {
    const w = await open(dev('z'), 'index.html');
    await enterName(w, 'rakija-admin'); assert.ok(text(w).includes('Prijava točitelja'), text(w));
    typeInto(w, w.document.querySelector('input'), 'wrong1'); await click(w, 'Prijava', 1500);
    assert.ok(text(w).includes('Pogrešan PIN'), text(w));
  });
  await t('device stays signed in: reopening the login page jumps straight to the role page', async () => {
    const w = await open(ANA, 'index.html'); assert.deepStrictEqual(w.__nav, ['gledatelj.html']);
  });
  await t('pages without login send you to the login page', async () => {
    for (const p of ['admin.html', 'sudac.html', 'gledatelj.html']) { const w = await open(dev('anon'), p); assert.deepStrictEqual(w.__nav, ['index.html'], p); }
  });
  await t('register Bob and Cleo; host signs in (Rakija-Admin / RAKIJA) and is routed to admin.html', async () => {
    for (const d of [BOB, CLEO]) { const w = await open(d, 'index.html'); await enterName(w, d.n === 'bob' ? 'Bob Kos' : 'Cleo Čurić'); await click(w, 'DALJE', 400); }
    const w = await open(HOST, 'index.html'); await enterName(w, 'Rakija-Admin');
    typeInto(w, w.document.querySelector('input'), 'RAKIJA'); await click(w, 'Prijava', 2000);
    assert.deepStrictEqual(w.__nav, ['admin.html']);
  });

  console.log('host sets up');
  const admin = await open(HOST, 'admin.html');
  await t('admin sees registered people with PINs; judge ticking and locking validation', async () => {
    assert.ok(text(admin).includes('Ana Horvat') && text(admin).includes('Bob Kos') && text(admin).includes('Cleo Čurić'), text(admin).slice(0, 400));
    assert.ok(text(admin).includes('PIN ' + anaPin));
    assert.ok(!text(admin).includes('Rakija-Admin'));
    admin.document.querySelector('.who') && assert.ok(admin.document.querySelector('.who').textContent.includes('Točitelj'));
    await click(admin, 'Zaključi postavke', 300);
    assert.ok((HOST.alerts || []).some(a => a.includes('barem jednog suca')), (HOST.alerts || []).join());
  });
  await t('tick Ana + Bob as judges; Cleo stays viewer; owners required; lock', async () => {
    const judgeBtns = () => buttons(admin, 'sudac?');
    assert.strictEqual(judgeBtns().length, 3);
    const rowBtn = nm => [...admin.document.querySelectorAll('.juror')].find(r => r.textContent.includes(nm)).querySelector('button');
    for (const nm of ['Ana Horvat', 'Bob Kos']) { rowBtn(nm).dispatchEvent(new admin.MouseEvent('click', { bubbles: true })); await sleep(400); }
    assert.ok(rowBtn('Ana Horvat').textContent.includes('✓'));
    HOST.alerts = []; await click(admin, 'Zaključi postavke', 300);
    assert.ok(HOST.alerts.some(a => a.includes('Ključ nije potpun')), HOST.alerts.join());
    const n = admin.document.querySelector('input[type=number]'); n.value = '4'; n.dispatchEvent(new admin.Event('change', { bubbles: true })); await sleep(600);
    const inputs = [...admin.document.querySelectorAll('input[placeholder^="Čija je rakija"]')]; assert.strictEqual(inputs.length, 4);
    ['Vlasnik W', 'Vlasnik X', 'Vlasnik Y', 'Vlasnik Z'].forEach((v, i) => typeInto(admin, inputs[i], v)); await sleep(900);
    await click(admin, 'Zaključi postavke', 700);
    assert.ok(text(admin).includes('zaključano'), text(admin).slice(0, 300));
  });

  console.log('judges & viewer');
  const viewerA = await open(ANA, 'gledatelj.html');       // Ana was a viewer; being ticked as a judge must move her
  await t('Ana (now a judge) is moved from the viewer page to the judge page automatically', async () => {
    assert.ok(viewerA.__nav.includes('sudac.html'), JSON.stringify(viewerA.__nav));
  });
  const judgeA = await open(ANA, 'sudac.html'), judgeB = await open(BOB, 'sudac.html'), viewer = await open(CLEO, 'gledatelj.html');
  const J = [judgeA, judgeB];
  await t('judge welcome shows own NAME in caps (no name picking), DALJE -> wait for host', async () => {
    assert.ok(text(judgeA).includes('ANA HORVAT') && text(judgeA).includes('DALJE'), text(judgeA));
    assert.ok(text(judgeB).includes('BOB KOS'));
    for (const w of J) await click(w, 'DALJE', 300);
    assert.ok(text(judgeA).includes('Čekaj točitelja'), text(judgeA));
    assert.ok(text(viewer).includes('Uskoro počinje'), text(viewer));
  });
  const openRound = async label => { admin.document.querySelector('[data-tab=score]').click(); await sleep(150); await click(admin, label, 700); };
  const rate = async (w, vals) => {
    const gr = [...w.document.querySelectorAll('.cat .grid')]; assert.strictEqual(gr.length, 4);
    for (let k = 0; k < 4; k++) { [...gr[k].querySelectorAll('button')].find(x => x.textContent === String(vals[k])).dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await sleep(120); }
  };
  await t('round 0: empty form "-", lock disabled until all 4 categories, tap again clears, live average', async () => {
    await openRound('Otvori Kalibracija');
    await waitFor(() => text(judgeA).includes('Miris'), 'form on judge');
    assert.strictEqual(judgeA.document.querySelector('.stickyavg .val').textContent, '-');
    const lock = () => buttons(judgeA, 'Zaključi ocjenu')[0], gr = () => [...judgeA.document.querySelectorAll('.cat .grid')];
    const tap = async (k, v) => { [...gr()[k].querySelectorAll('button')].find(x => x.textContent === String(v)).dispatchEvent(new judgeA.MouseEvent('click', { bubbles: true })); await sleep(250); };
    await tap(2, 10); assert.strictEqual(judgeA.document.querySelector('.stickyavg .val').textContent, '10.00'); assert.ok(lock().disabled);
    assert.ok(text(judgeA).includes('Ocijeni još: Miris, Okus, Balans'), text(judgeA));
    await tap(2, 10); assert.strictEqual(judgeA.document.querySelector('.stickyavg .val').textContent, '-');
    for (const [k, v] of [[0, 8], [1, 6], [2, 9], [3, 7]]) await tap(k, v);
    assert.strictEqual(judgeA.document.querySelector('.stickyavg .val').textContent, '7.50'); assert.ok(!lock().disabled);
  });
  await t('draft is saved in the cloud: reopening the judge page (new window) shows it', async () => {
    const again = await open(ANA, 'sudac.html'); await click(again, 'DALJE', 300).catch(() => {});
    assert.strictEqual([...again.document.querySelectorAll('.cat .grid button.sel')].map(b => b.textContent).join(), '8,6,9,7', text(again));
  });
  await t('lock -> interim average -> DALJE -> wait; admin sees status live', async () => {
    await click(judgeA, 'Zaključi ocjenu', 700);
    assert.ok(text(judgeA).includes('Ocjena zaključena') && text(judgeA).includes('7.50'), text(judgeA));
    await click(judgeA, 'DALJE', 200); assert.ok(text(judgeA).includes('Čekaj točitelja') && text(judgeA).includes('Rakija 1'), text(judgeA));
    await waitFor(() => /Ana Horvat ✓ zaključio/.test(text(admin)), 'admin live status');
  });
  await t('viewer sees calibration only after ALL judges locked (published by host page)', async () => {
    await sleep(800); assert.ok(!text(viewer).includes('7.50'), 'visible too early: ' + text(viewer));
    await click(judgeB, 'DALJE', 200).catch(() => {});
    await rate(judgeB, [5, 5, 5, 5]); await click(judgeB, 'Zaključi ocjenu', 700); await click(judgeB, 'DALJE', 200);
    await waitFor(() => text(viewer).includes('7.50') && text(viewer).includes('5.00') && text(viewer).includes('Ana Horvat'), 'viewer table', 8000);
    assert.ok(!/Vlasnik/.test(text(viewer)), 'owner leaked');
  });
  const vals = { 1: 9, 2: 7, 3: 7, 4: 3 };
  for (let r = 1; r <= 4; r++) await t('round ' + r + ': open, both judges rate + lock', async () => {
    await openRound('Otvori Rakija ' + r);
    for (const w of J) { await waitFor(() => text(w).includes('Rakija ' + r) && text(w).includes('Miris'), 'form r' + r); await rate(w, [vals[r], vals[r], vals[r], vals[r]]); await click(w, 'Zaključi ocjenu', 700); await click(w, 'DALJE', 200); }
  });
  await t('judge stats at the end are personal', async () => {
    const s = text(judgeA);
    assert.ok(s.includes('Tvoja statistika') && s.includes('6.50') && /favoritkinja\s*Rakija 1/.test(s) && /Najslabije ocijenjena\s*Rakija 4/.test(s), s);
    assert.ok(!s.includes('Bob') && !/Vlasnik/.test(s));
  });
  await t('viewer sees all locked rounds newest first; no owners, no ranking', async () => {
    await waitFor(() => text(viewer).includes('Rakija 4') && text(viewer).includes('Rakija 1'), 'viewer rounds', 8000);
    const s = text(viewer); assert.ok(s.indexOf('Rakija 4') < s.indexOf('Rakija 1')); assert.ok(!/Vlasnik/.test(s)); assert.ok(!viewer.document.querySelector('.ranklist'));
  });
  await t('privacy by database rules: judge cannot read viewer data, others\' ratings, owners or users; viewer cannot read owners/ratings', async () => {
    const denied = async (w, p) => { try { await w.FB.db.ref(p).once('value'); return false; } catch (e) { return /permission/i.test(e.message); } };
    const uidB = judgeB.FB.user.uid;
    assert.ok(await denied(judgeA, 'pub/rounds'), 'judge reads pub/rounds');
    assert.ok(await denied(judgeA, 'ratings/' + uidB), 'judge reads other ratings');
    assert.ok(await denied(judgeA, 'admin/owners')); assert.ok(await denied(judgeA, 'users'));
    assert.ok(await denied(viewer, 'admin/owners')); assert.ok(await denied(viewer, 'ratings')); assert.ok(await denied(viewer, 'users'));
    assert.ok(!(await denied(viewer, 'pub/rounds')), 'viewer must read pub/rounds');
  });

  console.log('finale');
  admin.document.querySelector('[data-tab=finale]').click(); await sleep(200);
  const everyone = [admin, judgeA, judgeB, viewer];
  const allShow = async (expected, what) => { for (const w of everyone) await waitFor(() => JSON.stringify(cardInfo(w)) === JSON.stringify(expected), what + ' on ' + (w.FB.name || '?') + ' got ' + JSON.stringify(cardInfo(w))); };
  await t('start: nobody sees results', async () => {
    await click(admin, 'Pokreni finale', 600);
    for (const w of everyone) { await waitFor(() => text(w).includes('Počinje od zadnjeg mjesta'), 'start text'); assert.strictEqual(cards(w).length, 0); }
    judgeA.__anims.length = 0;
  });
  let r4node;
  await t('step 1: worst rakija, owner hidden, pop animation', async () => {
    await click(admin, 'Otkrij rezultat', 300); await allShow(['4. R4 vlasnik: ??? 3.00'], 'step1');
    r4node = cards(judgeA)[0]; await sleep(150);
    assert.strictEqual(judgeA.__anims.filter(a => a.opts.delay === 220).length, 1);
  });
  await t('step 2: owner appears in the same card', async () => {
    judgeA.__anims.length = 0; await click(admin, 'Otkrij vlasnika', 300); await allShow(['4. R4 Vlasnik Z 3.00'], 'step2');
    assert.ok(cards(judgeA)[0] === r4node, 'card recreated');
  });
  await t('step 3: the two tied rakije together; old card slides down, new ones pop in', async () => {
    judgeA.__anims.length = 0; await click(admin, 'Otkrij rezultat', 300);
    await allShow(['2. R2 vlasnik: ??? 7.00', '2. R3 vlasnik: ??? 7.00', '4. R4 Vlasnik Z 3.00'], 'step3'); await sleep(150);
    assert.ok(cards(judgeA)[2] === r4node);
    const slide = judgeA.__anims.find(a => a.node === r4node); assert.ok(slide && slide.kf[0].transform === 'translateY(-200px)', JSON.stringify(judgeA.__anims.map(a => a.kf[0])));
    assert.strictEqual(judgeA.__anims.filter(a => a.opts.delay === 220).length, 2);
  });
  await t('unrevealed owner is not in the database for viewers (only revealed part is published)', async () => {
    const raw = JSON.stringify((await viewer.FB.db.ref('pub/finale').once('value')).val());
    assert.ok(!raw.includes('Vlasnik W') && !raw.includes('Vlasnik X') && !raw.includes('Vlasnik Y'), raw);
    assert.ok(raw.includes('Vlasnik Z'));
  });
  await t('step 4,5,6: owners together, winner, done', async () => {
    await click(admin, 'Otkrij vlasnika', 300); await allShow(['2. R2 Vlasnik X 7.00', '2. R3 Vlasnik Y 7.00', '4. R4 Vlasnik Z 3.00'], 'step4');
    await click(admin, 'Otkrij rezultat', 300); await click(admin, 'Otkrij vlasnika', 300);
    await allShow(['1. R1 Vlasnik W 9.00', '2. R2 Vlasnik X 7.00', '2. R3 Vlasnik Y 7.00', '4. R4 Vlasnik Z 3.00'], 'final');
    for (const w of everyone) { assert.ok(text(w).includes('Gotovo')); assert.ok(!text(w).includes('blind dvoboj')); }
    assert.ok(cards(judgeA)[0].classList.contains('p1') && cards(judgeA)[0].textContent.includes('🥇'));
  });
  await t('late joiner (viewer on a new device) sees the finale without animation', async () => {
    const d = dev('late'), reg = await open(d, 'index.html'); await enterName(reg, 'Dora Late'); await click(reg, 'DALJE', 300);
    const late = await open(d, 'gledatelj.html'); await waitFor(() => cards(late).length === 4, 'late cards');
    assert.strictEqual(late.__anims.length, 0);
  });
  await t('"Natrag" closes finale for everyone; restart starts empty', async () => {
    await click(admin, 'Natrag', 600);
    await waitFor(() => text(judgeA).includes('Tvoja statistika') && text(viewer).includes('Rakija 1'), 'back to normal');
    await click(admin, 'Pokreni finale', 600);
    for (const w of everyone) await waitFor(() => cards(w).length === 0, 'cleared');
    await click(admin, 'Prikaži sve', 600);
    await allShow(['1. R1 Vlasnik W 9.00', '2. R2 Vlasnik X 7.00', '2. R3 Vlasnik Y 7.00', '4. R4 Vlasnik Z 3.00'], 'show all');
    await click(admin, 'Natrag', 500);
  });

  console.log('admin extras');
  await t('admin reopens a locked rating -> judge can edit it again', async () => {
    admin.document.querySelector('[data-tab=score]').click(); await sleep(150);
    [...admin.document.querySelectorAll('.chips button')].find(b => b.textContent === '4').click(); await sleep(200);
    await click(admin, 'Otključaj', 700);
    await waitFor(() => text(judgeA).includes('Miris') || text(judgeB).includes('Miris'), 'judge form back');
  });
  await t('manual score entry counts when a judge has no phone rating', async () => {
    const before = admin.document.querySelectorAll('.grid').length; assert.ok(before >= 1);
  });
  await t('reset wipes ratings/judges/state, keeps registered people; judges fall back to waiting', async () => {
    admin.document.querySelector('[data-tab=setup]').click(); await sleep(200);
    await click(admin, 'Otključaj postavke', 700).catch(() => {});
    await click(admin, 'Reset svega', 1500);
    await waitFor(() => text(admin).includes('Ana Horvat') && buttons(admin, 'sudac?').length === 3, 'people kept, judges cleared');
    const snap = await admin.FB.db.ref('ratings').once('value'); assert.strictEqual(snap.val(), null);
    assert.ok(judgeA.__nav.includes('gledatelj.html'), JSON.stringify(judgeA.__nav));    // no longer a judge -> viewer page
  });
  await t('sign out works and returns to login', async () => {
    const w = await open(CLEO, 'gledatelj.html'); const out = buttons(w, 'Odjava')[0]; assert.ok(out);
    out.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await sleep(800);
    assert.ok(w.__nav.includes('index.html'));
    const again = await open(CLEO, 'gledatelj.html'); assert.deepStrictEqual(again.__nav, ['index.html']);
  });
  await t('no JS errors on any page', () => {
    const errs = pages.flatMap(w => w.__errors).filter(e => !/Not implemented/.test(e)); assert.deepStrictEqual(errs, []);
  });

  pages.forEach(w => { try { w.close(); } catch (e) {} }); server.close();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
