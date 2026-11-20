// One-off: creates the host account "Rakija-Admin" (password RAKIJA) in your Firebase project.
// Run it BEFORE anybody opens the app, otherwise the first person to type that name could take it over.
//   cd tests && npm i && cd ..        (installs the firebase SDK once)
//   node scripts/create-admin.js      (uses docs/firebase-config.js; EMULATOR=1 targets the local emulators)
const path = require('path'), fs = require('fs');
const firebase = require(path.join(__dirname, '..', 'tests', 'node_modules', 'firebase', 'compat', 'app'));
require(path.join(__dirname, '..', 'tests', 'node_modules', 'firebase', 'compat', 'auth'));
const cfg = new Function('window', fs.readFileSync(path.join(__dirname, '..', 'docs', 'firebase-config.js'), 'utf8') + '; return window.FIREBASE_CONFIG;')({});
const EMAIL = 'rakija-admin@rakija.example.com', PASSWORD = process.env.ADMIN_PASSWORD || 'RAKIJA';
if (!cfg.apiKey || /PASTE/.test(cfg.apiKey)) { console.error('Fill in docs/firebase-config.js first.'); process.exit(1); }
const app = firebase.initializeApp(cfg);
if (process.env.EMULATOR) app.auth().useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
app.auth().createUserWithEmailAndPassword(EMAIL, PASSWORD)
  .then(() => { console.log('Created host account: name "Rakija-Admin", password "' + PASSWORD + '".'); process.exit(0); })
  .catch(async e => {
    if (e.code !== 'auth/email-already-in-use') { console.error('Failed:', e.code || e.message); process.exit(1); }
    try { await app.auth().signInWithEmailAndPassword(EMAIL, PASSWORD); console.log('Host account already exists and the password works.'); process.exit(0); }
    catch (e2) { console.error('Host account exists but the password is different (' + e2.code + ').'); process.exit(1); }
  });
