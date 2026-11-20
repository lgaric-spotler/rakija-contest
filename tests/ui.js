// End-to-end UI test: real server + jsdom pages (admin, 3 judges, 2 viewers). Verifies the whole contest flow.
const { spawn } = require('child_process');
const { JSDOM } = require('jsdom');
const assert = require('assert');
const fs = require('fs');
const DIR = require('path').resolve(__dirname, '..');
const PORT = 8096, BASE = 'http://127.0.0.1:' + PORT, ADMIN = '4321', VIEW = '7777';
const STATE = DIR + '/test_state_ui.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let srv, passes = 0, fails = 0;
const log = (ok, name, msg) => { ok ? passes++ : fails++; console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n       ' + msg)); };
async function t(name, fn) { try { await fn(); log(true, name); } catch (e) { log(false, name, e.message.split('\n').slice(0, 3).join(' | ')); } }

const alerts = [], pages = [];
async function open(path, pre) {
  const dom = await JSDOM.fromURL(BASE + path, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, w.location.href), o);
      w.confirm = () => true; w.alert = m => alerts.push(String(m));
      w.__anims = [];
      w.Element.prototype.animate = function (kf, opts) { w.__anims.push({ node: this, kf, opts }); return {}; };
      // jsdom has no layout: stack children 100px apart so the slide logic can be observed
      Object.defineProperty(w.HTMLElement.prototype, 'offsetTop', { get() { const p = this.parentNode; return p ? Array.prototype.indexOf.call(p.children, this) * 100 : 0; } });
      if (pre) pre(w);
    },
  });
  const w = dom.window; w.__errors = [];
  w.addEventListener('error', e => w.__errors.push(e.message));
  pages.push(w);
  await sleep(500);
  return w;
}
const text = w => w.document.getElementById('view').textContent.replace(/\s+/g, ' ').trim();
const buttons = (w, t) => [...w.document.querySelectorAll('button')].filter(b => b.textContent.includes(t));
async function click(w, label, wait = 150) {
  const b = buttons(w, label)[0]; if (!b) throw new Error('no button "' + label + '" in: ' + text(w).slice(0, 200));
  if (b.disabled) throw new Error('button "' + label + '" is disabled');
  b.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await sleep(wait);
}
const cards = w => [...w.document.querySelectorAll('.ranklist .rank')];
const cardInfo = w => cards(w).map(c => c.querySelector('.place').textContent.replace(/[^0-9–.]/g, '') + ' ' + c.querySelector('.who b').textContent.replace('Rakija ', 'R') + ' ' + c.querySelector('.owner').textContent.replace('🥃 ', '') + ' ' + c.querySelector('.avg').textContent);
const setVal = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };

(async () => {
  try { fs.unlinkSync(STATE); } catch (e) {}
  srv = spawn('node', ['serve.js'], { cwd: DIR, env: Object.assign({}, process.env, { PORT, ADMIN_PIN: ADMIN, VIEWER_PIN: VIEW, STATE_FILE: 'test_state_ui.json' }) });
  srv.stderr.on('data', d => console.log('SERVER ERR', String(d)));
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/'); break; } catch (e) { await sleep(100); } }

  // ---- role picker ----
  const idx = await open('/');
  await t('role picker: 3 roles + title link', () => {
    const hrefs = [...idx.document.querySelectorAll('.roles a')].map(a => a.getAttribute('href')).sort();
    assert.deepStrictEqual(hrefs, ['/admin', '/gledatelj', '/sudac']);
  });
  for (const p of ['/admin', '/sudac', '/gledatelj']) await t('title links back to / on ' + p, async () => {
    const w = await open(p); assert.strictEqual(w.document.querySelector('h1 a').getAttribute('href'), '/');
  });

  // ---- viewer: PIN ----
  const viewer = await open('/gledatelj');
  await t('viewer: asks for PIN, rejects wrong, accepts right', async () => {
    assert.ok(text(viewer).includes('PIN za gledatelje'));
    const pin = viewer.document.querySelector('input'); pin.value = '0000'; await click(viewer, 'Ulaz', 400);
    assert.ok(text(viewer).includes('Pogrešan PIN'), text(viewer));
    viewer.document.querySelector('input').value = VIEW; await click(viewer, 'Ulaz', 500);
    assert.ok(text(viewer).includes('Uskoro počinje'), text(viewer));
  });

  // ---- admin: login + setup ----
  const admin = await open('/admin');
  await t('admin: login wrong then right', async () => {
    assert.ok(text(admin).includes('Prijava točitelja'));
    admin.document.querySelector('input').value = '1111'; await click(admin, 'Prijava', 500);
    assert.ok(text(admin).includes('Pogrešan PIN'), text(admin));
    admin.document.querySelector('input').value = ADMIN; await click(admin, 'Prijava', 600);
    assert.ok(text(admin).includes('Žiri'), text(admin).slice(0, 200));
  });
  const judgeA = await open('/sudac'), judgeB = await open('/sudac'), judgeC = await open('/sudac');
  await t('judge: waits while settings are not locked', () => assert.ok(text(judgeA).includes('Još malo')));
  await t('admin: duplicate names / empty names rejected', async () => {
    alerts.length = 0;
    const ta = admin.document.querySelector('textarea');
    ta.value = 'Ana\nana'; await click(admin, 'Spremi'); assert.ok(alerts.some(a => a.includes('različita')), alerts.join());
    ta.value = '  \n '; await click(admin, 'Spremi'); assert.ok(alerts.some(a => a.includes('barem jedan')), alerts.join());
  });
  await t('admin: incomplete key blocks locking', async () => {
    alerts.length = 0;
    admin.document.querySelector('textarea').value = 'Ana Horvat\nBob Kos\nCleo Čurić';
    setVal(admin, admin.document.querySelector('input[type=number]'), '4');
    await click(admin, 'Spremi', 300);
    await click(admin, 'Zaključi postavke', 300);
    assert.ok(alerts.some(a => a.includes('Ključ nije potpun')), alerts.join());
    assert.ok(!text(admin).includes('zaključano'));
  });
  await t('admin: fill key and lock settings', async () => {
    const inputs = [...admin.document.querySelectorAll('input[placeholder^="Čija je rakija"]')]; assert.strictEqual(inputs.length, 4);
    ['Vlasnik W', 'Vlasnik X', 'Vlasnik Y', 'Vlasnik Z'].forEach((v, i) => setVal(admin, inputs[i], v));
    await sleep(500);
    await click(admin, 'Zaključi postavke', 400);
    assert.ok(text(admin).includes('zaključano'), text(admin).slice(0, 300));
    assert.ok(text(admin).includes(VIEW), 'viewer PIN card');
  });

  // ---- judges pick names ----
  for (const w of [judgeA, judgeB, judgeC]) await w.refresh();
  await t('judge: sees name list and picks (no popup)', async () => {
    assert.ok(text(judgeA).includes('Tko si ti?'), text(judgeA));
    alerts.length = 0;
    await click(judgeA, 'Ana Horvat', 300);
    assert.strictEqual(alerts.length, 0);
    assert.ok(text(judgeA).includes('ANA HORVAT') && text(judgeA).includes('DALJE'), text(judgeA));
  });
  await t('judge: taken name is disabled for others', async () => {
    await judgeB.refresh();
    const b = buttons(judgeB, 'Ana Horvat')[0]; assert.ok(b.disabled && b.textContent.includes('zauzeto'));
  });
  await t('judge: caps name incl. diacritics, "Nisam ja" frees it', async () => {
    await click(judgeB, 'Cleo Čurić', 300); assert.ok(text(judgeB).includes('CLEO ČURIĆ'), text(judgeB));
    await click(judgeB, 'Nisam ja', 300); assert.ok(text(judgeB).includes('Tko si ti?'));
    await click(judgeB, 'Bob Kos', 300); assert.ok(text(judgeB).includes('BOB KOS'));
    await click(judgeC, 'Cleo Čurić', 300);
    for (const w of [judgeA, judgeB, judgeC]) await click(w, 'DALJE', 200);
    assert.ok(text(judgeA).includes('Čekaj točitelja'), text(judgeA));
  });
  await t('admin: shows claimed judges', async () => {
    await admin.pull(); assert.strictEqual((text(admin).match(/prijavljen/g) || []).length >= 3, true, text(admin).slice(0, 600));
  });

  // ---- rounds ----
  const J = [judgeA, judgeB, judgeC];
  const openRound = async label => { await click(admin, 'Ocjene', 100); admin.document.querySelector('[data-tab=score]').click(); await sleep(100); await click(admin, label, 400); for (const w of J) await w.refresh(); await sleep(100); };
  const rate = async (w, vals) => {
    const gr = [...w.document.querySelectorAll('.cat .grid')]; assert.strictEqual(gr.length, 4);
    for (let k = 0; k < 4; k++) { const b = [...gr[k].querySelectorAll('button')].find(x => x.textContent === String(vals[k])); b.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await sleep(30); if (k < 3) assert.ok(w.document.querySelector('.stickyavg .val')); }
  };

  await t('round 0 (calibration): empty form shows "-" and lock is disabled until 4 categories', async () => {
    admin.document.querySelector('[data-tab=score]').click(); await sleep(100);
    await click(admin, 'Otvori Kalibracija', 400);
    for (const w of J) await w.refresh();
    assert.ok(text(judgeA).includes('Kalibracija') && text(judgeA).includes('Miris') && text(judgeA).includes('Balans'));
    assert.strictEqual(judgeA.document.querySelector('.stickyavg .val').textContent, '-');
    const lock = () => buttons(judgeA, 'Zaključi ocjenu')[0];
    assert.ok(lock().disabled);
    const gr = () => [...judgeA.document.querySelectorAll('.cat .grid')];
    const tap = async (k, v) => { [...gr()[k].querySelectorAll('button')].find(x => x.textContent === String(v)).dispatchEvent(new judgeA.MouseEvent('click', { bubbles: true })); await sleep(60); };
    await tap(2, 10); assert.strictEqual(judgeA.document.querySelector('.stickyavg .val').textContent, '10.00');
    assert.ok(lock().disabled); assert.ok(text(judgeA).includes('Ocijeni još: Miris, Okus, Balans'), text(judgeA));
    await tap(2, 10); assert.strictEqual(judgeA.document.querySelector('.stickyavg .val').textContent, '-');   // tap again clears
    for (const [k, v] of [[0, 8], [1, 6], [2, 9], [3, 7]]) await tap(k, v);
    assert.strictEqual(judgeA.document.querySelector('.stickyavg .val').textContent, '7.50'); assert.ok(!lock().disabled);
  });
  await t('draft survives page reload (server side)', async () => {
    const again = await open('/sudac', w => w.localStorage.setItem('rakija-judge-token', judgeA.localStorage.getItem('rakija-judge-token')));
    assert.ok(text(again).includes('ANA HORVAT') || text(again).includes('Kalibracija'), text(again));
    await click(again, 'DALJE', 200).catch(() => {});
    assert.ok([...again.document.querySelectorAll('.cat .grid button.sel')].map(b => b.textContent).join() === '8,6,9,7', text(again));
  });
  await t('judge: lock -> interim average -> DALJE -> wait', async () => {
    await click(judgeA, 'Zaključi ocjenu', 300);
    assert.ok(text(judgeA).includes('Ocjena zaključena') && text(judgeA).includes('7.50'), text(judgeA));
    await click(judgeA, 'DALJE', 200); assert.ok(text(judgeA).includes('Čekaj točitelja') && text(judgeA).includes('Rakija 1'), text(judgeA));
  });
  await t('viewer: calibration hidden until all judges locked, then table shown', async () => {
    await sleep(1200); assert.ok(text(viewer).includes('Ocjenjivanje u tijeku') || text(viewer).includes('1 / 3'), text(viewer));
    assert.ok(!text(viewer).includes('7.50'));
    for (const w of [judgeB, judgeC]) { await rate(w, [5, 5, 5, 5]); await click(w, 'Zaključi ocjenu', 200); await click(w, 'DALJE', 100); }
    await sleep(1300); assert.ok(text(viewer).includes('7.50') && text(viewer).includes('5.00') && text(viewer).includes('Ana Horvat'), text(viewer));
    assert.ok(!/Vlasnik/.test(text(viewer)), 'owner leaked to viewer');
  });
  await t('admin sees judges as locked', async () => { await admin.poll(); admin.document.querySelector('[data-tab=score]').click(); await sleep(100); assert.ok((text(admin).match(/zaključio/g) || []).length >= 3, text(admin).slice(0, 700)); });

  // rakije 1..4: R1 all 9, R2 all 7, R3 all 7, R4 all 3  -> places 1,2,2,4
  const vals = { 1: 9, 2: 7, 3: 7, 4: 3 };
  for (let r = 1; r <= 4; r++) {
    await t('round ' + r + ': open, all judges rate + lock', async () => {
      admin.document.querySelector('[data-tab=score]').click(); await sleep(100);
      await click(admin, 'Otvori Rakija ' + r, 400);
      for (const w of J) await w.refresh();
      for (const w of J) { assert.ok(text(w).includes('Rakija ' + r), text(w)); await rate(w, [vals[r], vals[r], vals[r], vals[r]]); await click(w, 'Zaključi ocjenu', 200); await click(w, 'DALJE', 100); }
    });
  }
  await t('judges see personal stats at the end (only theirs)', async () => {
    const s = text(judgeA);
    assert.ok(s.includes('Tvoja statistika') && s.includes('ANA'.length ? 'Ana Horvat' : ''), s.slice(0, 300));
    assert.ok(s.includes('Tvoj prosjek') && s.includes('6.50'), s);   // (9+7+7+3)/4 = 6.5
    assert.ok(/Tvoja favoritkinja\s*Rakija 1/.test(s), s); assert.ok(/Najslabije ocijenjena\s*Rakija 4/.test(s), s);
    assert.ok(!/Vlasnik/.test(s) && !s.includes('Bob'), 'leak in judge stats');
  });
  await t('viewer sees every locked round, newest first, no averages of rakije / owners', async () => {
    await sleep(1200);
    const s = text(viewer); for (const r of ['Rakija 1', 'Rakija 2', 'Rakija 3', 'Rakija 4']) assert.ok(s.includes(r), r);
    assert.ok(s.indexOf('Rakija 4') < s.indexOf('Rakija 1')); assert.ok(!/Vlasnik/.test(s));
    assert.ok(!viewer.document.querySelector('.ranklist'));
  });
  await t('admin: score tab is blind (no ranking before finale)', async () => {
    admin.document.querySelector('[data-tab=score]').click(); await sleep(100);
    assert.ok(!admin.document.querySelector('.rank')); assert.ok(!/Vlasnik/.test(text(admin).replace(/Čija je rakija/g, '')));
  });

  // ---- finale ----
  admin.document.querySelector('[data-tab=finale]').click(); await sleep(150);
  const everyone = [admin, judgeA, judgeB, judgeC, viewer];
  const sync = async () => sleep(1300);
  await t('finale start: nobody sees results yet', async () => {
    await click(admin, 'Pokreni finale', 300); await sync();
    for (const w of everyone) { assert.ok(text(w).includes('Počinje od zadnjeg mjesta'), text(w).slice(0, 200)); assert.strictEqual(cards(w).length, 0); }
    for (const w of [judgeA, viewer]) w.__anims.length = 0;
  });
  let r4node;
  await t('step 1: worst rakija appears (score only, owner ???) with pop animation', async () => {
    await click(admin, 'Otkrij rezultat', 300); await sync();
    for (const w of everyone) assert.deepStrictEqual(cardInfo(w), ['4. R4 vlasnik: ??? 3.00'], w.document.title);
    r4node = cards(judgeA)[0];
    const pops = judgeA.__anims.filter(a => a.opts.delay === 220); assert.strictEqual(pops.length, 1, JSON.stringify(judgeA.__anims.map(a => a.opts)));
    assert.ok(viewer.__anims.length >= 1);
  });
  await t('step 2: owner revealed in the same card (node reused)', async () => {
    judgeA.__anims.length = 0;
    await click(admin, 'Otkrij vlasnika', 300); await sync();
    for (const w of everyone) assert.deepStrictEqual(cardInfo(w), ['4. R4 Vlasnik Z 3.00']);
    assert.ok(cards(judgeA)[0] === r4node, 'card was recreated');
    assert.strictEqual(judgeA.__anims.length, 1);   // subtle owner fade only
  });
  await t('step 3: the TWO tied rakije appear together; old card slides down, new ones pop in', async () => {
    judgeA.__anims.length = 0;
    await click(admin, 'Otkrij rezultat', 300); await sync();
    for (const w of everyone) assert.deepStrictEqual(cardInfo(w), ['2. R2 vlasnik: ??? 7.00', '2. R3 vlasnik: ??? 7.00', '4. R4 Vlasnik Z 3.00'], 'page');
    assert.ok(cards(judgeA)[2] === r4node, 'old card must be the same node');
    const slide = judgeA.__anims.find(a => a.node === r4node); assert.ok(slide, 'old card has no slide animation');
    assert.strictEqual(slide.kf[0].transform, 'translateY(-200px)');   // moved down by the 2 new cards
    assert.strictEqual(judgeA.__anims.filter(a => a.opts.delay === 220).length, 2);
  });
  await t('step 4: both tied owners revealed together', async () => {
    await click(admin, 'Otkrij vlasnika', 300); await sync();
    for (const w of everyone) assert.deepStrictEqual(cardInfo(w), ['2. R2 Vlasnik X 7.00', '2. R3 Vlasnik Y 7.00', '4. R4 Vlasnik Z 3.00']);
  });
  await t('late joiner mid-finale sees the cards without any animation', async () => {
    const late = await open('/gledatelj', w => w.localStorage.setItem('rakija-viewer-pin', VIEW)); await sleep(500);
    assert.deepStrictEqual(cardInfo(late), ['2. R2 Vlasnik X 7.00', '2. R3 Vlasnik Y 7.00', '4. R4 Vlasnik Z 3.00']);
    assert.strictEqual(late.__anims.length, 0);
  });
  await t('step 5/6: winner with medal, then done (no tie warning)', async () => {
    await click(admin, 'Otkrij rezultat', 300); await sync();
    for (const w of everyone) assert.ok(cardInfo(w)[0].startsWith('1. R1 vlasnik: ???'), cardInfo(w)[0]);
    await click(admin, 'Otkrij vlasnika', 300); await sync();
    for (const w of everyone) { assert.deepStrictEqual(cardInfo(w), ['1. R1 Vlasnik W 9.00', '2. R2 Vlasnik X 7.00', '2. R3 Vlasnik Y 7.00', '4. R4 Vlasnik Z 3.00']); assert.ok(text(w).includes('Gotovo')); assert.ok(!text(w).includes('blind dvoboj')); }
    assert.ok(cards(judgeA)[0].classList.contains('p1') && cards(judgeA)[0].textContent.includes('🥇'));
    assert.ok(cards(judgeA)[1].textContent.includes('🥈') && cards(judgeA)[2].textContent.includes('🥈'));
  });
  await t('"Natrag" closes finale for everyone; restart begins from scratch', async () => {
    await click(admin, 'Natrag', 300); await sync();
    assert.ok(text(judgeA).includes('Tvoja statistika')); assert.ok(!viewer.document.querySelector('.ranklist .rank') || viewer.document.querySelector('.ranklist .rank') === null);
    assert.ok(text(viewer).includes('Rakija 1'));
    await click(admin, 'Pokreni finale', 300); await sync();
    for (const w of everyone) assert.strictEqual(cards(w).length, 0, 'stale cards after restart');
    await click(admin, 'Otkrij rezultat', 300); await sync();
    assert.deepStrictEqual(cardInfo(judgeA), ['4. R4 vlasnik: ??? 3.00']);
  });
  await t('"Prikaži sve" reveals everything; all new cards animate, in best-first order', async () => {
    judgeA.__anims.length = 0;
    await click(admin, 'Prikaži sve', 300); await sync();
    for (const w of everyone) assert.deepStrictEqual(cardInfo(w), ['1. R1 Vlasnik W 9.00', '2. R2 Vlasnik X 7.00', '2. R3 Vlasnik Y 7.00', '4. R4 Vlasnik Z 3.00']);
    assert.strictEqual(judgeA.__anims.filter(a => a.opts.delay === 220).length, 3);
    await click(admin, 'Natrag', 300);
  });

  // ---- reopen / release / unlock / reset on admin ----
  await t('admin: reopen a locked score -> judge can edit again', async () => {
    admin.document.querySelector('[data-tab=score]').click(); await sleep(100);
    const chip = [...admin.document.querySelectorAll('.chips button')].find(b => b.textContent === '4'); chip.click(); await sleep(100);
    await click(admin, 'Otključaj', 400);
    const info = await (await fetch(BASE + '/api/j/info', { headers: { 'x-token': judgeA.localStorage.getItem('rakija-judge-token') } })).json();
    assert.strictEqual(info.mine[4].locked, false);
  });
  await t('admin: unlock settings keeps data; reset clears all and viewer PIN card returns', async () => {
    admin.document.querySelector('[data-tab=setup]').click(); await sleep(100);
    await click(admin, 'Otključaj postavke', 400); assert.ok(!text(admin).includes('🔓 Otključaj'), 'still locked');
    await click(admin, 'Reset svega', 600); await sleep(3300);
    assert.ok(text(admin).includes('Žiri')); assert.ok(text(admin).includes(VIEW), 'viewer PIN card missing after reset: ' + text(admin).slice(0, 200));
    const s = await (await fetch(BASE + '/api/state', { headers: { 'x-admin-pin': ADMIN } })).json();
    assert.strictEqual(s.locked, false); assert.deepStrictEqual(s.cats, {}); assert.deepStrictEqual(s.claims, {});
    await click(judgeA, 'DALJE', 100).catch(() => {}); await judgeA.refresh(); assert.ok(text(judgeA).includes('Još malo'), text(judgeA));
  });
  await t('no JS errors on any page', () => {
    const errs = pages.flatMap(w => w.__errors); assert.deepStrictEqual(errs, []);
  });

  pages.forEach(w => w.close()); srv.kill(); try { fs.unlinkSync(STATE); } catch (e) {}
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); try { srv.kill(); } catch (x) {} process.exit(2); });
