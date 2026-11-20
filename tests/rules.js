// Security-rules tests against the Firebase emulator (auth :9099, database :9000, project demo-rakija).
//   firebase emulators:start --only auth,database --project demo-rakija   (in another terminal)
//   cd tests && npm i && node rules.js
const assert = require('assert');
const firebase = require('firebase/compat/app');
require('firebase/compat/auth');
require('firebase/compat/database');

const DOMAIN = 'rakija.example.com';
let n = 0, passes = 0, fails = 0;
async function client(label) {
  const app = firebase.initializeApp({ apiKey: 'fake', projectId: 'demo-rakija', databaseURL: 'http://127.0.0.1:9000?ns=demo-rakija-default-rtdb' }, 'c' + (n++) + label);
  app.auth().useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
  const db = app.database(); db.useEmulator('127.0.0.1', 9000);
  return { app, auth: app.auth(), db, ref: p => db.ref(p) };
}
async function signup(label, email, pw) { const c = await client(label); const cred = await c.auth.createUserWithEmailAndPassword(email, pw); c.uid = cred.user.uid; return c; }
const ok = p => p.then(() => true, e => { if (/PERMISSION_DENIED|permission_denied|validation/i.test(e.message + e.code)) return false; throw e; });
const read = async (c, path) => { try { return { ok: true, v: (await c.ref(path).once('value')).val() }; } catch (e) { return { ok: false }; } };
async function t(name, fn) { try { await fn(); passes++; console.log('  ok  ', name); } catch (e) { fails++; console.log('  FAIL', name, '\n      ', String(e.message).split('\n').slice(0, 2).join(' | ')); } }

(async () => {
  // fresh database
  await fetch('http://127.0.0.1:9000/.json?ns=demo-rakija-default-rtdb', { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
  await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-rakija/accounts', { method: 'DELETE' });

  const admin = await signup('admin', 'rakija-admin@' + DOMAIN, 'RAKIJA');
  const ana = await signup('ana', 'ana@' + DOMAIN, '111111');
  const bob = await signup('bob', 'bob@' + DOMAIN, '222222');
  const cleo = await signup('cleo', 'cleo@' + DOMAIN, '333333');
  const anon = await client('anon');   // not signed in

  console.log('users');
  await t('user creates own profile once (name + 6 digit pin)', async () => {
    assert.ok(await ok(ana.ref('users/' + ana.uid).set({ name: 'Ana', pin: '111111' })));
    assert.ok(await ok(bob.ref('users/' + bob.uid).set({ name: 'Bob', pin: '222222' })));
    assert.ok(await ok(cleo.ref('users/' + cleo.uid).set({ name: 'Cleo', pin: '333333' })));
  });
  await t('profile: cannot overwrite, cannot write for someone else, bad shapes rejected', async () => {
    assert.ok(!(await ok(ana.ref('users/' + ana.uid).set({ name: 'Hacker', pin: '111111' }))));
    assert.ok(!(await ok(ana.ref('users/' + bob.uid + '/name').set('X'))));
    const dan = await signup('dan', 'dan@' + DOMAIN, '444444');
    assert.ok(!(await ok(dan.ref('users/' + dan.uid).set({ name: 'Dan', pin: '12' }))));
    assert.ok(!(await ok(dan.ref('users/' + dan.uid).set({ name: '', pin: '123456' }))));
    assert.ok(!(await ok(dan.ref('users/' + dan.uid).set({ name: 'x'.repeat(41), pin: '123456' }))));
    assert.ok(!(await ok(dan.ref('users/' + dan.uid).set({ name: 'Dan', pin: '123456', extra: 1 }))));
    assert.ok(await ok(dan.ref('users/' + dan.uid).set({ name: 'Dan', pin: '123456' })));
  });
  await t('users: self can read own (incl. pin); others and anonymous cannot; admin reads all', async () => {
    assert.strictEqual((await read(ana, 'users/' + ana.uid)).v.pin, '111111');
    assert.ok(!(await read(ana, 'users/' + bob.uid)).ok); assert.ok(!(await read(ana, 'users')).ok);
    assert.ok(!(await read(anon, 'users/' + ana.uid)).ok);
    const all = await read(admin, 'users'); assert.ok(all.ok && Object.keys(all.v).length === 4);
  });

  console.log('judges & state');
  await t('only admin writes judges / state / admin data', async () => {
    assert.ok(!(await ok(ana.ref('judges/' + ana.uid).set(true))));
    assert.ok(!(await ok(ana.ref('state').set({ locked: true, n: 3, open: 0 }))));
    assert.ok(!(await ok(ana.ref('admin/owners/1').set('Ana'))));
    assert.ok(await ok(admin.ref('judges/' + ana.uid).set(true))); assert.ok(await ok(admin.ref('judges/' + bob.uid).set(true)));
    assert.ok(!(await ok(admin.ref('judges/' + cleo.uid).set('yes'))));    // only true allowed
  });
  await t('state validation', async () => {
    const st = o => ok(admin.ref('state').set(o));
    assert.ok(!(await st({ locked: true, n: 0, open: 0 }))); assert.ok(!(await st({ locked: true, n: 21, open: 0 })));
    assert.ok(!(await st({ locked: 'yes', n: 3, open: 0 }))); assert.ok(!(await st({ locked: true, n: 3 })));
    assert.ok(!(await st({ locked: true, n: 3, open: 0, junk: 1 }))); assert.ok(!(await st({ locked: true, n: 2.5, open: 0 })));
    assert.ok(await st({ locked: false, n: 3, open: -1 }));
  });
  await t('state readable by any signed-in user, not by anonymous', async () => {
    assert.ok((await read(cleo, 'state')).ok); assert.ok(!(await read(anon, 'state')).ok);
  });
  await t('judges: a user reads only own flag; admin reads all', async () => {
    assert.strictEqual((await read(ana, 'judges/' + ana.uid)).v, true);
    assert.strictEqual((await read(cleo, 'judges/' + cleo.uid)).v, null);
    assert.ok(!(await read(ana, 'judges/' + bob.uid)).ok); assert.ok(!(await read(ana, 'judges')).ok);
    assert.ok((await read(admin, 'judges')).ok);
  });

  console.log('ratings');
  const rate = (c, r, v) => ok(c.ref('ratings/' + c.uid + '/' + r).set(v));
  await t('judge cannot rate before settings are locked or round open', async () => {
    assert.ok(!(await rate(ana, 0, { locked: false, c: { 0: 5 } })));
    await admin.ref('state').set({ locked: true, n: 3, open: -1 });
    assert.ok(!(await rate(ana, 0, { locked: false, c: { 0: 5 } })));
    await admin.ref('state').update({ open: 0, 'openRounds/0': true });
    assert.ok(await rate(ana, 0, { locked: false, c: { 0: 5 } }));
    assert.ok(!(await rate(ana, 1, { locked: false, c: { 0: 5 } })), 'round 1 not opened');
  });
  await t('non-judge cannot rate; judges cannot rate for each other', async () => {
    assert.ok(!(await rate(cleo, 0, { locked: false, c: { 0: 5 } })));
    assert.ok(!(await ok(ana.ref('ratings/' + bob.uid + '/0').set({ locked: false, c: { 0: 5 } }))));
  });
  await t('rating validation (range, integer, keys, shape)', async () => {
    for (const bad of [{ locked: false, c: { 0: 0 } }, { locked: false, c: { 0: 11 } }, { locked: false, c: { 0: 5.5 } }, { locked: false, c: { 0: '5' } }, { locked: false, c: { 4: 5 } },
      { locked: false, c: { 0: 5 }, extra: 1 }, { c: { 0: 5 } }, { locked: 'no', c: { 0: 5 } }]) assert.ok(!(await rate(ana, 0, bad)), JSON.stringify(bad));
    assert.ok(await rate(ana, 0, { locked: false, c: { 0: 8, 1: 7 } }));
    assert.ok(await rate(ana, 0, { locked: false }));      // all cleared
  });
  await t('lock requires all 4 categories', async () => {
    assert.ok(!(await rate(ana, 0, { locked: true, c: { 0: 8, 1: 7, 2: 9 } })));
    assert.ok(!(await rate(ana, 0, { locked: true })));
    assert.ok(await rate(ana, 0, { locked: true, c: { 0: 8, 1: 7, 2: 9, 3: 10 } }));
  });
  await t('locked rating cannot be changed by the judge; admin can reopen', async () => {
    assert.ok(!(await rate(ana, 0, { locked: false, c: { 0: 1, 1: 1, 2: 1, 3: 1 } })));
    assert.ok(!(await ok(ana.ref('ratings/' + ana.uid + '/0/locked').set(false))));
    assert.ok(!(await ok(ana.ref('ratings/' + ana.uid + '/0').remove())));
    assert.ok(await ok(admin.ref('ratings/' + ana.uid + '/0/locked').set(false)));
    assert.ok(await rate(ana, 0, { locked: true, c: { 0: 6, 1: 6, 2: 6, 3: 6 } }));
  });
  await t('ratings readable only by owner and admin', async () => {
    assert.strictEqual((await read(ana, 'ratings/' + ana.uid + '/0')).v.locked, true);
    assert.ok(!(await read(bob, 'ratings/' + ana.uid + '/0')).ok); assert.ok(!(await read(cleo, 'ratings/' + ana.uid + '/0')).ok);
    assert.ok(!(await read(bob, 'ratings')).ok); assert.ok(!(await read(anon, 'ratings')).ok);
    assert.ok((await read(admin, 'ratings')).ok);
  });
  await t('closed round / unlocked settings stop further judge writes', async () => {
    await admin.ref('state').update({ open: -1, 'openRounds/0': null });
    assert.ok(!(await rate(bob, 0, { locked: false, c: { 0: 5 } })));
    await admin.ref('state').update({ open: 0, 'openRounds/0': true, locked: false });
    assert.ok(!(await rate(bob, 0, { locked: false, c: { 0: 5 } })));
    await admin.ref('state').update({ locked: true });
    assert.ok(await rate(bob, 0, { locked: false, c: { 0: 5 } }));
  });

  console.log('published data');
  await t('only admin publishes', async () => {
    assert.ok(!(await ok(ana.ref('pub/finale').set({ step: 1 })))); assert.ok(!(await ok(cleo.ref('pub/rounds/0').set({ done: 1 }))));
    assert.ok(await ok(admin.ref('pub/rounds/0').set({ done: 2, total: 2 }))); assert.ok(await ok(admin.ref('pub/finale').set({ step: 0, total: 2 })));
  });
  await t('viewers read pub/rounds; judges and anonymous cannot; everyone signed in reads finale', async () => {
    assert.ok((await read(cleo, 'pub/rounds')).ok);
    assert.ok(!(await read(ana, 'pub/rounds')).ok); assert.ok(!(await read(ana, 'pub/rounds/0')).ok); assert.ok(!(await read(anon, 'pub/rounds')).ok);
    assert.ok((await read(admin, 'pub/rounds')).ok);
    assert.ok((await read(ana, 'pub/finale')).ok); assert.ok((await read(cleo, 'pub/finale')).ok); assert.ok(!(await read(anon, 'pub/finale')).ok);
  });
  await t('owners/manual scores (admin node) are admin only; nothing else readable at root', async () => {
    await admin.ref('admin').set({ owners: { 1: 'SECRET' } });
    assert.ok(!(await read(ana, 'admin')).ok); assert.ok(!(await read(cleo, 'admin/owners')).ok); assert.ok(!(await read(anon, 'admin')).ok);
    assert.ok(!(await read(cleo, '')).ok);
    assert.ok(!(await ok(cleo.ref('foo').set(1))));
  });
  await t('admin can wipe everything with one multi-path update (reset); a user cannot', async () => {
    assert.ok(!(await ok(ana.ref().update({ state: null }))));
    assert.ok(await ok(admin.ref().update({ judges: null, state: null, admin: null, ratings: null, pub: null })));
    assert.strictEqual((await read(admin, 'ratings')).v, null); assert.strictEqual((await read(admin, 'state')).v, null);
    assert.ok((await read(admin, 'users')).v);   // users survive
  });
  await t('a normal user cannot pose as admin by email', async () => {
    // "Rakija-Admin" can only exist once; a second sign-up with the same address is refused by Auth
    const c = await client('x'); let code = ''; try { await c.auth.createUserWithEmailAndPassword('rakija-admin@' + DOMAIN, 'whatever'); } catch (e) { code = e.code; }
    assert.strictEqual(code, 'auth/email-already-in-use');
  });

  await Promise.all(firebase.apps.map(a => a.delete()));
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
