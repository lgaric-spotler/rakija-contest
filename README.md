# Rakija Contest

## 3D print (juror dials)
- `stl/dial_base.stl` – paddle with pin and pointer (178 × 108 mm, print flat, no supports)
- `stl/dial_disc.stl` – number disc 1–10 (print flat). For two colours, change filament at Z = 3.0 mm
- `stl/dial_circle.stl` – plain flat circle Ø 17.2 mm (2 × the hole in the disc), 2 mm thick. Glue it flat onto the end of the pin so the disc cannot come off
- `stl/dial_ring.stl` – Ø 17.2 mm retaining circle, 2.8 mm high: closed circle on one side, 1.4 mm deep socket (Ø 8.4) on the other. Glue the socket onto the end of the pin (replaces `dial_circle.stl`). Printed closed side down, socket up, no supports
- Print 5 × each (one set per juror). PLA, 0.2 mm layers, 15–20 % infill. `gen_dial.py` regenerates the STLs.

## Web (host, judges, viewers)
Files: `index.html` (role picker), `ocjenjivanje.html` (host), `sudac.html` (judges), `gledatelj.html` (viewers), `style.css`, `logic.js`, `common.js`, `serve.js`.
All data is in `state.json`, read/written through `serve.js` (Node only, no dependencies). The server listens on all
interfaces, so it is reachable on the LAN at `http://<LAN-IP>:8080`.

1. `node serve.js` – prints the **ADMIN PIN** (saved in `.admin_pin`; override with `ADMIN_PIN=...`) and the URLs.
   `http://<LAN-IP>:8080/` is the role picker (on every page the "Rakija Contest" title links back to it):
   - Host:    `http://<LAN-IP>:8080/admin`     (asks for the PIN)
   - Judges:  `http://<LAN-IP>:8080/sudac`
   - Viewers: `http://<LAN-IP>:8080/gledatelj`  (asks for the **VIEWER PIN**, saved in `.viewer_pin`, override with `VIEWER_PIN=...`;
     also shown in the host page under Postavke. Give it to viewers only, not to judges)
2. Host: Postavke → judges (Ime Prezime, one per line), number of rakije, owners (Ključ) → **Zaključi postavke**.
   Judges can only pick their name after that.
3. Host: Ocjene → **Otvori Kalibracija / Rakija 1 / …** when the glasses are poured. Judges rate 4 categories (1–10, all
   required), see the live average and lock the rating. At the end each judge sees their own stats.
4. Viewers see every judge's locked category ratings per rakija; a round appears once all judges have locked it.
   No overall averages, ranking or owners until the finale.
5. Host: Finale → "Otkrij rezultat / Otkrij vlasnika". Judges and viewers see the same reveal on their screens within ~1 s.
   Ties share a place and the next is skipped (1, 2, 2, 4); rakije that share a place are revealed together.
   New cards slide the already revealed ones down (nothing redraws). "Natrag" closes the finale for everyone.

## Tests
`node test_logic.js` (scoring/ranking/judge stats). End-to-end tests ran against the real server with jsdom (not kept in the repo).

## Tests
`node test_logic.js` (pure logic). `cd tests && npm i && node api.js && node ui.js` (API + full UI flow with jsdom, own server/port/temp state).
