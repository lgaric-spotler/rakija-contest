// API-level tests against a real server instance (temp state file, own port).
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const DIR = require('path').resolve(__dirname, '..');
const PORT = 8097, BASE = 'http://127.0.0.1:' + PORT, ADMIN = '4321', VIEW = '7777';
const STATE = DIR + '/test_state.json';
let srv, fails = 0, passes = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tok = n => String(n).padStart(32, 'a');
async function start() {
  srv = spawn('node', ['serve.js'], { cwd: DIR, env: Object.assign({}, process.env, { PORT, ADMIN_PIN: ADMIN, VIEWER_PIN: VIEW, STATE_FILE: 'test_state.json' }) });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/'); return; } catch (e) { await sleep(100); } }
  throw new Error('server did not start');
}
async function stop() { srv.kill(); await sleep(200); }
const adm = (p, o = {}) => fetch(BASE + p, Object.assign({}, o, { headers: Object.assign({ 'x-admin-pin': ADMIN, 'Content-Type': 'application/json' }, o.headers) }));
const put = body => adm('/api/state', { method: 'PUT', body: JSON.stringify(body) });
const jpost = (a, body) => fetch(BASE + '/api/j/' + a, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const jinfo = t => fetch(BASE + '/api/j/info', { headers: { 'x-token': t } }).then(r => r.json());
const vinfo = (pin = VIEW) => fetch(BASE + '/api/v/info', { headers: { 'x-viewer-pin': pin } });
async function t(name, fn) { try { await fn(); passes++; console.log('  ok  ', name); } catch (e) { fails++; console.log('  FAIL', name, '\n      ', e.message.split('\n')[0]); } }

const base = (o = {}) => Object.assign({ jurors: ['Ana', 'Bob', 'Cleo'], n: 3, owners: { 1: 'A', 2: 'B', 3: 'C' }, scores: {}, locked: true, open: -1, finale: null }, o);

(async () => {
  try { fs.unlinkSync(STATE); } catch (e) {}
  await start();

  console.log('routes & auth');
  await t('pages 200', async () => { for (const p of ['/', '/admin', '/sudac', '/gledatelj', '/style.css', '/logic.js', '/common.js']) assert.strictEqual((await fetch(BASE + p)).status, 200, p); });
  await t('unknown 404', async () => { assert.strictEqual((await fetch(BASE + '/nope')).status, 404); assert.strictEqual((await fetch(BASE + '/state.json')).status, 404); assert.strictEqual((await fetch(BASE + '/serve.js')).status, 404); assert.strictEqual((await fetch(BASE + '/../serve.js')).status, 404); });
  await t('admin api needs PIN', async () => {
    assert.strictEqual((await fetch(BASE + '/api/state')).status, 401);
    assert.strictEqual((await fetch(BASE + '/api/state', { headers: { 'x-admin-pin': 'wrong' } })).status, 401);
    assert.strictEqual((await fetch(BASE + '/api/state', { headers: { 'x-admin-pin': VIEW } })).status, 401);   // viewer PIN is not admin
    assert.strictEqual((await fetch(BASE + '/api/admin/reset', { method: 'POST' })).status, 401);
    assert.strictEqual((await fetch(BASE + '/api/state', { method: 'PUT', body: '{}' })).status, 401);
  });
  await t('empty server: GET state null', async () => { assert.strictEqual(await (await adm('/api/state')).json(), null); });
  await t('empty server: judge/viewer/finale safe', async () => {
    const j = await jinfo(tok(1)); assert.strictEqual(j.locked, false); assert.deepStrictEqual(j.jurors, []);
    assert.strictEqual((await vinfo()).status, 200); assert.strictEqual(await (await fetch(BASE + '/api/finale')).json(), null);
  });
  await t('viewer api PIN', async () => {
    assert.strictEqual((await vinfo('')).status, 401); assert.strictEqual((await vinfo('1886')).status, 401);
    assert.strictEqual((await vinfo(VIEW)).status, 200); assert.strictEqual((await vinfo(ADMIN)).status, 401);   // admin PIN only via x-admin-pin
    assert.strictEqual((await fetch(BASE + '/api/v/info', { headers: { 'x-admin-pin': ADMIN } })).status, 200);
  });

  console.log('PUT validation');
  const bad = [
    ['no jurors', base({ jurors: [] })], ['juror non-string', base({ jurors: ['A', 5] })], ['blank juror', base({ jurors: ['A', '  '] })],
    ['21 jurors', base({ jurors: Array.from({ length: 21 }, (_, i) => 'J' + i) })], ['n=0', base({ n: 0 })], ['n=21', base({ n: 21 })], ['n float', base({ n: 2.5 })],
    ['open>n', base({ open: 4 })], ['open<-1', base({ open: -2 })], ['finale step -1', base({ finale: { step: -1 } })], ['finale step 101', base({ finale: { step: 101 } })],
    ['no owners', Object.assign(base(), { owners: null })], ['null body', null], ['long name', base({ jurors: ['x'.repeat(101)] })],
  ];
  for (const [name, b] of bad) await t('rejects ' + name, async () => assert.strictEqual((await put(b)).status, 400));
  await t('rejects invalid JSON', async () => assert.strictEqual((await adm('/api/state', { method: 'PUT', body: '{nope' })).status, 400));
  await t('rejects oversized body', async () => assert.strictEqual((await adm('/api/state', { method: 'PUT', body: JSON.stringify(base({ owners: { 1: 'x'.repeat(300000) } })) })).status, 413));
  await t('nothing written by bad requests', async () => assert.strictEqual(await (await adm('/api/state')).json(), null));

  console.log('judge flow');
  await t('PUT unlocked state; judges get 403', async () => {
    assert.strictEqual((await put(base({ locked: false }))).status, 204);
    assert.strictEqual((await jpost('claim', { token: tok(1), juror: 0 })).status, 403);
    const j = await jinfo(tok(1)); assert.deepStrictEqual(j.jurors, []);   // names hidden until locked
  });
  await t('lock settings; claim', async () => {
    await put(base({ locked: true }));
    const r = await jpost('claim', { token: tok(1), juror: 0 }); assert.strictEqual(r.status, 200);
    const j = await r.json(); assert.strictEqual(j.me, 0); assert.strictEqual(j.name, 'Ana');
  });
  await t('claim: bad token / bad juror / missing', async () => {
    assert.strictEqual((await jpost('claim', { token: 'x', juror: 1 })).status, 400);
    assert.strictEqual((await jpost('claim', { token: tok(2), juror: 9 })).status, 400);
    assert.strictEqual((await jpost('claim', { token: tok(2), juror: -1 })).status, 400);
    assert.strictEqual((await jpost('claim', { token: tok(2), juror: '1' })).status, 400);
    assert.strictEqual((await jpost('claim', { token: tok(2) })).status, 400);
    assert.strictEqual((await jpost('claim', { token: 'ZZ'.repeat(10), juror: 1 })).status, 400);
  });
  await t('claim: taken by other / second name / idempotent', async () => {
    assert.strictEqual((await jpost('claim', { token: tok(2), juror: 0 })).status, 409);
    assert.strictEqual((await jpost('claim', { token: tok(1), juror: 1 })).status, 409);
    assert.strictEqual((await jpost('claim', { token: tok(1), juror: 0 })).status, 200);
    const other = await jinfo(tok(2)); assert.strictEqual(other.jurors[0].taken, true); assert.strictEqual(other.me, null);
    const me = await jinfo(tok(1)); assert.strictEqual(me.jurors[0].taken, false);
  });
  await t('claim race: only one token wins', async () => {
    const rs = await Promise.all([3, 4, 5, 6, 7, 8].map(n => jpost('claim', { token: tok(n), juror: 2 })));
    const codes = rs.map(r => r.status).sort(); assert.deepStrictEqual(codes, [200, 409, 409, 409, 409, 409]);
  });
  await t('score: round not open', async () => {
    assert.strictEqual((await jpost('score', { token: tok(1), round: 0, c: [5, 5, 5, 5], lock: false })).status, 403);
  });
  await t('score: not claimed', async () => {
    await put(base({ open: 0 }));
    assert.strictEqual((await jpost('score', { token: tok(2), round: 0, c: [5, 5, 5, 5], lock: false })).status, 403);
  });
  await t('score validation', async () => {
    const s = c => jpost('score', { token: tok(1), round: 0, c, lock: false }).then(r => r.status);
    assert.strictEqual(await s([5, 5, 5]), 400); assert.strictEqual(await s([5, 5, 5, 5, 5]), 400); assert.strictEqual(await s([0, 5, 5, 5]), 400);
    assert.strictEqual(await s([11, 5, 5, 5]), 400); assert.strictEqual(await s([5.5, 5, 5, 5]), 400); assert.strictEqual(await s(['5', 5, 5, 5]), 400);
    assert.strictEqual(await s('abc'), 400); assert.strictEqual(await s(null), 400); assert.strictEqual(await s([null, null, null, null]), 200);
    assert.strictEqual((await jpost('score', { token: tok(1), round: 9, c: [5, 5, 5, 5] })).status, 403);
    assert.strictEqual((await jpost('score', { token: tok(1), round: -1, c: [5, 5, 5, 5] })).status, 403);
    assert.strictEqual((await jpost('score', { token: tok(1), round: 'a', c: [5, 5, 5, 5] })).status, 403);
  });
  await t('lock needs all 4 categories', async () => {
    assert.strictEqual((await jpost('score', { token: tok(1), round: 0, c: [10, null, null, null], lock: true })).status, 400);
    assert.strictEqual((await jpost('score', { token: tok(1), round: 0, c: [null, null, null, null], lock: true })).status, 400);
    const j = await jinfo(tok(1)); assert.ok(!j.mine[0] || j.mine[0].locked === false);
  });
  await t('draft saved and returned; lock works; relock refused', async () => {
    let r = await jpost('score', { token: tok(1), round: 0, c: [8, 7, null, null], lock: false }); assert.strictEqual(r.status, 200);
    assert.deepStrictEqual((await r.json()).mine[0], { c: [8, 7, null, null], locked: false });
    r = await jpost('score', { token: tok(1), round: 0, c: [8, 7, 9, 10], lock: true }); assert.strictEqual(r.status, 200);
    assert.deepStrictEqual((await r.json()).mine[0], { c: [8, 7, 9, 10], locked: true });
    assert.strictEqual((await jpost('score', { token: tok(1), round: 0, c: [1, 1, 1, 1], lock: false })).status, 409);
    assert.strictEqual((await jpost('score', { token: tok(1), round: 0, c: [1, 1, 1, 1], lock: true })).status, 409);
  });
  await t('release refused after locking; allowed before', async () => {
    assert.strictEqual((await jpost('release', { token: tok(1) })).status, 409);
    assert.strictEqual((await jpost('release', { token: tok(2) })).status, 403);
    assert.strictEqual((await jpost('release', { token: tok(3) })).status, 200);   // winner of the race had no locked score
    assert.strictEqual((await jinfo(tok(3))).me, null);
  });
  await t('judge sees only own data, no tokens', async () => {
    await jpost('claim', { token: tok(2), juror: 1 });
    await jpost('score', { token: tok(2), round: 0, c: [1, 2, 3, 4], lock: false });
    const a = await jinfo(tok(1)), b = await jinfo(tok(2));
    assert.deepStrictEqual(a.mine[0].c, [8, 7, 9, 10]); assert.deepStrictEqual(b.mine[0].c, [1, 2, 3, 4]);
    const raw = JSON.stringify([a, b]); assert.ok(!raw.includes(tok(1)) && !raw.includes(tok(2)));
    assert.ok(!('owners' in a) && !('scores' in a));
    const adminRaw = await (await adm('/api/state')).text(); assert.ok(!adminRaw.includes(tok(1)), 'admin view leaks tokens');
    const s = JSON.parse(adminRaw); assert.strictEqual(s.claims[0], true); assert.strictEqual(s.viewerPin, VIEW);
  });
  await t('unknown judge action / bad json', async () => {
    assert.strictEqual((await jpost('nope', {})).status, 401);   // unknown /api path falls under admin PIN
    assert.strictEqual((await fetch(BASE + '/api/j/score', { method: 'POST', body: '{bad' })).status, 400);
    assert.strictEqual((await fetch(BASE + '/api/j/score')).status, 401);
  });

  console.log('viewer privacy');
  await t('viewer: round hidden until all judges scored', async () => {
    let v = await (await vinfo()).json(); assert.strictEqual(v.rounds.length, 1); assert.strictEqual(v.rounds[0].ratings, null); assert.strictEqual(v.rounds[0].done, 1);
    assert.ok(!JSON.stringify(v).includes('"owner'));
    assert.strictEqual(v.finale, null);
  });
  await t('viewer: drafts never exposed, manual scores count', async () => {
    await put(base({ open: 0, scores: { 0: { 2: 6 } } }));        // Cleo has a manual score; Bob only a draft
    let v = await (await vinfo()).json(); assert.strictEqual(v.rounds[0].ratings, null); assert.strictEqual(v.rounds[0].done, 2);
    assert.ok(!JSON.stringify(v).includes('[1,2,3,4]'));
    await jpost('score', { token: tok(2), round: 0, c: [1, 2, 3, 4], lock: true });
    v = await (await vinfo()).json(); assert.strictEqual(v.rounds[0].done, 3);
    const names = v.rounds[0].ratings.map(r => [r.name, r.avg, r.c && r.c.join()]);
    assert.deepStrictEqual(names, [['Ana', 8.5, '8,7,9,10'], ['Bob', 2.5, '1,2,3,4'], ['Cleo', 6, null]]);
  });
  await t('viewer: only opened rounds listed', async () => {
    const v = await (await vinfo()).json(); assert.strictEqual(v.rounds.length, 1);
    await put(base({ open: 2, scores: { 0: { 2: 6 } } })); const v2 = await (await vinfo()).json(); assert.strictEqual(v2.rounds.length, 3);
  });

  console.log('merge rules');
  await t('PUT keeps cats/claims when only n changes', async () => {
    await put(base({ open: 2, n: 4, scores: { 0: { 2: 6 } } }));
    const j = await jinfo(tok(1)); assert.strictEqual(j.me, 0); assert.deepStrictEqual(j.mine[0].c, [8, 7, 9, 10]); assert.strictEqual(j.n, 4);
  });
  await t('PUT cannot overwrite judge data (cats/claims in body ignored)', async () => {
    await put(Object.assign(base({ open: 2, n: 4, scores: { 0: { 2: 6 } } }), { cats: { 0: { 0: { c: [1, 1, 1, 1], locked: true } } }, claims: { 0: tok(9) } }));
    const j = await jinfo(tok(1)); assert.deepStrictEqual(j.mine[0].c, [8, 7, 9, 10]); assert.strictEqual(j.me, 0);
  });
  await t('judge actions keep admin fields', async () => {
    await put(base({ open: 2, n: 4, owners: { 1: 'Q' }, scores: { 1: { 0: 7 } } }));
    await jpost('score', { token: tok(1), round: 1, c: [4, 4, 4, 4], lock: false });
    const s = await (await adm('/api/state')).json(); assert.deepStrictEqual(s.owners, { 1: 'Q' }); assert.deepStrictEqual(s.scores, { 1: { 0: 7 } }); assert.strictEqual(s.open, 2);
  });
  await t('changing juror names wipes cats and claims', async () => {
    await put(base({ jurors: ['Ana', 'Bob', 'Dora'], open: 2, n: 4 }));
    const j = await jinfo(tok(1)); assert.strictEqual(j.me, null); assert.deepStrictEqual(j.mine, {});
  });

  console.log('admin actions');
  await t('admin release / reopen / reset', async () => {
    await jpost('claim', { token: tok(1), juror: 0 });
    await jpost('score', { token: tok(1), round: 0, c: [5, 5, 5, 5], lock: true });
    assert.strictEqual((await adm('/api/admin/reopen', { method: 'POST', body: JSON.stringify({ round: 0, juror: 0 }) })).status, 204);
    assert.strictEqual((await jpost('score', { token: tok(1), round: 0, c: [6, 6, 6, 6], lock: true })).status, 200);
    assert.strictEqual((await adm('/api/admin/reopen', { method: 'POST', body: JSON.stringify({ round: 7, juror: 0 }) })).status, 404);
    assert.strictEqual((await adm('/api/admin/release', { method: 'POST', body: JSON.stringify({ juror: 0 }) })).status, 204);
    assert.strictEqual((await jinfo(tok(1))).me, null);
    assert.strictEqual((await adm('/api/admin/reset', { method: 'POST' })).status, 204);
    assert.strictEqual(await (await adm('/api/state')).json(), null);
    assert.strictEqual((await adm('/api/admin/reset', { method: 'POST' })).status, 204);   // idempotent
  });

  console.log('finale');
  const fin = async step => { await put(base({ jurors: ['Ana', 'Bob'], n: 4, owners: { 1: 'W', 2: 'X', 3: 'Y', 4: 'Z' }, open: 4, scores: { 1: { 0: 9, 1: 9 }, 2: { 0: 7, 1: 7 }, 3: { 0: 7, 1: 7 }, 4: { 0: 3, 1: 3 } }, finale: step === null ? null : { step } })); return (await fetch(BASE + '/api/finale')).json(); };
  await t('finale endpoint reveals ties together, nothing more', async () => {
    assert.strictEqual(await fin(null), null);
    let f = await fin(0); assert.deepStrictEqual(f.items, []); assert.strictEqual(f.total, 6);
    f = await fin(1); assert.deepStrictEqual(f.items.map(x => [x.round, x.owner]), [[4, null]]);
    f = await fin(3); assert.deepStrictEqual(f.items.map(x => [x.round, x.place, x.owner]), [[2, 2, null], [3, 2, null], [4, 4, 'Z']]);
    f = await fin(4); assert.deepStrictEqual(f.items.map(x => x.owner), ['X', 'Y', 'Z']);
    f = await fin(5); assert.ok(!JSON.stringify(f).includes('"W"') && f.items[0].round === 1 && f.items[0].owner === null);
    f = await fin(6); assert.strictEqual(f.done, true); assert.deepStrictEqual(f.items.map(x => x.place), [1, 2, 2, 4]);
    assert.ok(!JSON.stringify(await (await vinfo()).json()).includes('"W"') === false);   // viewer sees finale as well
  });
  await t('viewer info before finale has no owners/averages of rakije', async () => {
    await fin(null);
    const raw = JSON.stringify(await (await vinfo()).json()); assert.ok(!/"[WXYZ]"/.test(raw), 'owner leaked');
  });

  console.log('persistence');
  await t('state survives restart; corrupt file handled', async () => {
    await fin(2); await stop(); await start();
    assert.strictEqual((await (await fetch(BASE + '/api/finale')).json()).step, 2);
    fs.writeFileSync(STATE, '{corrupt'); assert.strictEqual(await (await adm('/api/state')).json(), null);
    assert.strictEqual((await fetch(BASE + '/api/finale')).status, 200);
    assert.strictEqual((await vinfo()).status, 200); assert.strictEqual((await jinfo(tok(1))).me, null);
  });
  await t('no leftover tmp file / server still alive', async () => { assert.ok(!fs.existsSync(STATE + '.tmp')); assert.strictEqual((await fetch(BASE + '/')).status, 200); });

  await stop();
  try { fs.unlinkSync(STATE); } catch (e) {}
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); try { srv.kill(); } catch (x) {} process.exit(2); });
