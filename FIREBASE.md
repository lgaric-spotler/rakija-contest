# Rakija Contest – Firebase / GitHub Pages version (branch `firebase`)

Static site in `docs/` (publish with GitHub Pages) + Firebase Realtime Database + Firebase Auth. No server.
The LAN/Node version (`serve.js`) is still on branch `main`.

## How people sign in
- Everyone types their name on `index.html`. A new name creates an account and shows a personal 6-digit **PIN** once
  (also visible later via the small "PIN" link under the title, and to the host in Postavke).
- Same name + PIN on another phone signs in again. The name is compared ignoring case and diacritics.
- Host: name `Rakija-Admin`, password `RAKIJA`. Whoever is ticked as **sudac** in the host's Postavke becomes a judge; everybody else is a viewer.

## Setup (once)
1. Firebase console: create project → **Build → Realtime Database** (create, locked mode) → **Authentication → Sign-in method → Email/Password: enable**.
2. Realtime Database → **Rules** → paste `database.rules.json` → Publish.
3. Project settings → Your apps → Web app → copy the config into `docs/firebase-config.js`.
4. Create the host account **before anybody opens the app** (otherwise the first person typing "Rakija-Admin" owns it):
   `cd tests && npm i && cd .. && node scripts/create-admin.js`
5. GitHub: Settings → Pages → deploy from branch `firebase`, folder `/docs` (a free account needs a public repo).

## Privacy model (enforced by `database.rules.json`, not by the browser)
- Judges see only their own ratings. Owners and unrevealed finale results are readable by the host only.
- The host page publishes to `pub/`: a round's ratings (only when every judge has locked it) and the already revealed part of the finale.
  Judges cannot read `pub/rounds`; viewers can. **The host page must stay open** during the contest for viewers/finale to update.
- Limits: anyone can register an account, so a judge could register a second name and look at the viewer data; the host password is weak (`RAKIJA`)
  and the site is public. Fine for a party; change/delete the host account afterwards (Authentication → Users).

## Tests (optional, local emulator)
`firebase emulators:start --only auth,database --project demo-rakija` then `cd tests && node rules.js` (rules) / `node fbui.js` (full UI flow).
