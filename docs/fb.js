// Firebase glue shared by all pages (compat SDK is loaded before this file). Exposes the global FB.
//   Everybody signs in with "name + PIN":  Firebase Email/Password with a made-up address <name-slug>@rakija.example.com.
//   The host is just the user "Rakija-Admin" (password RAKIJA); the database rules recognise the host by that address.
(function () {
  const cfg = window.FIREBASE_CONFIG || {};
  const configured = !!cfg.apiKey && !/YOUR_|PASTE/i.test(cfg.apiKey);
  const DOMAIN = 'rakija.example.com', ADMIN_NAME = 'Rakija-Admin';
  const PAGE = { admin: 'admin.html', judge: 'sudac.html', viewer: 'gledatelj.html' };
  const never = new Promise(() => {});
  const go = url => (window.__navigate ? window.__navigate(url) : location.replace(url));   // __navigate: tests only
  const FB = { go, configured, DOMAIN, ADMIN_NAME, PAGE, auth: null, db: null, user: null, name: null, role: null };

  // "Ana Čurić" -> "ana-curic"; empty if the name has no letters/digits at all
  FB.slug = name => String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  FB.cleanName = name => String(name || '').trim().replace(/\s+/g, ' ');
  FB.emailFor = name => FB.slug(name) + '@' + DOMAIN;
  FB.ADMIN_EMAIL = FB.slug(ADMIN_NAME) + '@' + DOMAIN;
  FB.isAdminName = name => FB.slug(name) === FB.slug(ADMIN_NAME);

  if (configured) {
    firebase.initializeApp(cfg);
    FB.auth = firebase.auth(); FB.db = firebase.database();
    if (window.FIREBASE_EMULATOR) {            // tests only
      FB.auth.useEmulator(window.FIREBASE_EMULATOR.auth, { disableWarnings: true });
      FB.db.useEmulator(window.FIREBASE_EMULATOR.db[0], window.FIREBASE_EMULATOR.db[1]);
    }
    FB.ready = new Promise(res => { const off = FB.auth.onAuthStateChanged(u => { off(); FB.user = u; res(u); }); });
  } else FB.ready = Promise.resolve(null);

  const randomPin = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(100000 + (a[0] % 900000)); };

  // New person: pick a name, get a PIN. Throws {code:'taken'} when the name already exists, {code:'admin'} for the host's name.
  FB.register = async function (rawName) {
    const name = FB.cleanName(rawName);
    if (!name || name.length > 40 || !FB.slug(name)) throw { code: 'bad-name' };
    if (FB.isAdminName(name)) throw { code: 'admin' };
    const pin = randomPin();
    let cred;
    try { cred = await FB.auth.createUserWithEmailAndPassword(FB.emailFor(name), pin); }
    catch (e) { throw e.code === 'auth/email-already-in-use' ? { code: 'taken' } : e; }
    FB.user = cred.user;
    await FB.db.ref('users/' + cred.user.uid).set({ name, pin });
    return { name, pin };
  };

  // Existing person (or the host) on any device. Throws {code:'bad-secret'} or {code:'no-user'}.
  FB.login = async function (rawName, secret) {
    const name = FB.cleanName(rawName);
    if (!FB.slug(name)) throw { code: 'bad-name' };
    try { FB.user = (await FB.auth.signInWithEmailAndPassword(FB.emailFor(name), String(secret).trim())).user; }
    catch (e) {
      if (e.code === 'auth/user-not-found') throw { code: 'no-user' };
      if (/wrong-password|invalid-credential|invalid-login|too-many/.test(e.code)) throw { code: e.code === 'auth/too-many-requests' ? 'too-many' : 'bad-secret' };
      throw e;
    }
    if (!FB.isAdminName(name)) {                 // heal a profile that failed to save at registration
      const ref = FB.db.ref('users/' + FB.user.uid);
      if (!(await ref.once('value')).exists() && /^[0-9]{6}$/.test(String(secret).trim())) await ref.set({ name, pin: String(secret).trim() });
    }
    return FB.user;
  };

  FB.signOut = async () => { await FB.auth.signOut(); FB.user = null; go('index.html'); };
  FB.isAdmin = u => !!u && u.email === FB.ADMIN_EMAIL;

  // which page this signed-in user belongs on
  FB.roleOf = async function (u) {
    if (FB.isAdmin(u)) return 'admin';
    const s = await FB.db.ref('judges/' + u.uid).once('value');
    return s.exists() ? 'judge' : 'viewer';
  };

  // Every page starts with this: must be signed in and on the page of its role, otherwise it moves.
  // Resolves with {user, name, role}; later role changes (host ticks someone as judge) move the page too.
  FB.guard = async function (page) {
    if (!configured) { go('index.html'); return never; }
    const u = await FB.ready;
    if (!u) { go('index.html'); return never; }
    const role = await FB.roleOf(u);
    if (role !== page) { go(PAGE[role]); return never; }
    FB.role = role;
    if (role === 'admin') FB.name = 'Točitelj';
    else {
      FB.name = ((await FB.db.ref('users/' + u.uid).once('value')).val() || {}).name || 'Gost';
      FB.db.ref('judges/' + u.uid).on('value', s => { const now = s.exists() ? 'judge' : 'viewer'; if (now !== FB.role) go(PAGE[now]); });
    }
    FB.mountWho();
    return { user: u, name: FB.name, role };
  };

  // small "name · PIN · sign out" line under the title
  FB.mountWho = function () {
    const box = document.getElementById('who'); if (!box) return;
    const pin = el('button', { class: 'linkish' }, 'PIN');
    pin.addEventListener('click', async () => {
      if (pin.dataset.shown) { pin.textContent = 'PIN'; delete pin.dataset.shown; return; }
      const p = FB.isAdmin(FB.user) ? 'RAKIJA' : ((await FB.db.ref('users/' + FB.user.uid + '/pin').once('value')).val() || '?');
      pin.textContent = p; pin.dataset.shown = '1';
    });
    const out = el('button', { class: 'linkish' }, 'Odjava'); out.addEventListener('click', FB.signOut);
    box.replaceChildren(el('span', {}, FB.name), ' · ', pin, ' · ', out);
  };

  // ---- shapes stored in the database -> shapes the UI/logic use ----
  const cats4 = c => [0, 1, 2, 3].map(k => (c && typeof c[k] === 'number') ? c[k] : null);   // RTDB returns {0:..} or [..] without nulls
  FB.cell = v => ({ c: cats4(v && v.c), locked: !!(v && v.locked) });
  FB.cellOut = (c, locked) => { const o = {}; c.forEach((v, k) => { if (v !== null) o[k] = v; }); return Object.keys(o).length ? { c: o, locked } : { locked }; };
  FB.cellMap = v => { const m = {}; Object.keys(v || {}).forEach(r => { m[r] = FB.cell(v[r]); }); return m; };
  FB.stateOf = v => ({ locked: !!(v && v.locked), n: v && typeof v.n === 'number' ? v.n : 0, open: v && typeof v.open === 'number' ? v.open : -1 });
  const arr = v => Array.isArray(v) ? v.filter(x => x !== null && x !== undefined) : Object.values(v || {});
  FB.finaleOf = v => v ? ({ step: v.step || 0, total: v.total || 0, done: !!v.done, tied: !!v.tied,
    items: arr(v.items).map(x => ({ round: x.round, place: x.place ?? null, avg: x.avg ?? null, owner: x.owner ?? null })) }) : null;

  window.FB = FB;
})();
