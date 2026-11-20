// Shared, pure logic (used by both pages, tested by test_logic.js). No DOM, no network.
const SCORE_MIN = 1, SCORE_MAX = 10;
const CATEGORIES = ['Miris', 'Okus', 'Završetak', 'Balans'];

// round 0 = calibration (never counted); rounds 1..n = rakije
function roundLabel(r) { return r === 0 ? 'Kalibracija' : 'Rakija ' + r; }

// mean of the categories that were rated; null if none ("-" in the UI)
function catAverage(c) {
  const v = (c || []).filter(x => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// The score of juror i for round r: the juror's locked phone rating if there is one,
// otherwise the score the host typed in manually.
function scoreOf(state, r, i) {
  const cell = (((state.cats || {})[r]) || {})[i];
  if (cell && cell.locked) { const a = catAverage(cell.c); if (a !== null) return a; }
  const v = ((state.scores || {})[r] || {})[i];
  return typeof v === 'number' ? v : null;
}

// Blind tasting: every juror's score counts for every rakija.
function countedScores(state, r) {
  const out = [];
  state.jurors.forEach((_, i) => { const v = scoreOf(state, r, i); if (v !== null) out.push(v); });
  return out;
}

function computeResults(state) {
  const res = [];
  for (let r = 1; r <= state.n; r++) {
    const s = countedScores(state, r);
    const avg = s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
    res.push({ round: r, avg, count: s.length });
  }
  return res;
}

// Missing score cells among rounds 0..n
function missingScores(state) {
  const miss = [];
  for (let r = 0; r <= state.n; r++)
    state.jurors.forEach((j, i) => { if (scoreOf(state, r, i) === null) miss.push({ round: r, juror: j }); });
  return miss;
}

// Competition ranking of [{avg}] best -> worst: ties share a place and the next place(s) are skipped
// (1 A, 2 B, 2 C, 4 D). Items without a score go last with place null. Sorts a copy.
function rankItems(items) {
  const res = items.slice();
  res.sort((a, b) => (a.avg === null) - (b.avg === null) || (b.avg ?? 0) - (a.avg ?? 0) || a.round - b.round);
  let place = 0, prev = undefined;
  res.forEach((x, i) => {
    const same = prev !== undefined && x.avg !== null && Math.abs(x.avg - prev) < 1e-9;
    if (!same) place = i + 1;
    x.place = x.avg === null ? null : place;
    prev = x.avg === null ? undefined : x.avg;
  });
  return res;
}

function ranking(state) { return rankItems(computeResults(state)); }

function tiedForFirst(rank) { return rank.filter(x => x.place === 1).length > 1; }

// ---- judge side ----
// first round (0..n) the judge has not locked yet; null when everything is locked
function firstOpenRound(mine, n) {
  for (let r = 0; r <= n; r++) if (!((mine || {})[r] && mine[r].locked)) return r;
  return null;
}

// personal statistics of one judge over rakije 1..n (calibration excluded)
function judgeStats(mine, n) {
  const items = [];
  for (let r = 1; r <= n; r++) {
    const cell = (mine || {})[r];
    items.push({ round: r, c: cell ? cell.c : [null, null, null, null], avg: cell && cell.locked ? catAverage(cell.c) : null });
  }
  const ranked = rankItems(items);
  const scored = ranked.filter(x => x.avg !== null);
  const catMeans = CATEGORIES.map((_, k) => {
    const v = items.map(x => x.c[k]).filter(x => typeof x === 'number');
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  });
  return {
    ranked,
    mean: scored.length ? scored.reduce((a, b) => a + b.avg, 0) / scored.length : null,
    best: scored.filter(x => x.place === 1),
    worst: scored.filter(x => Math.abs(x.avg - scored[scored.length - 1].avg) < 1e-9),
    catMeans,
  };
}

// ---- finale: what is revealed at a given step (shared by server, host and viewers) ----
// Reveal order is worst -> best; per place two steps: first the score, then the owner.
// Rakije that share a place (ties) are one group and are revealed together.
// Only the already revealed part is returned, so nothing unrevealed can leak to viewers.
function finaleView(state) {
  const f = state.finale;
  if (!f) return null;
  const rank = ranking(state), groups = [];
  rank.forEach(x => {
    const g = groups[groups.length - 1];
    if (g && g[0].place === x.place) g.push(x); else groups.push([x]);
  });
  const rev = groups.reverse();
  const total = rev.length * 2, step = Math.max(0, Math.min(f.step | 0, total));
  let items = [];
  rev.forEach((g, i) => {
    if (step > 2 * i) {
      const showOwner = step > 2 * i + 1;
      items = g.map(x => ({ round: x.round, place: x.place, avg: x.avg, owner: showOwner ? ((state.owners || {})[x.round] || '—') : null })).concat(items);
    }
  });
  const done = step >= total;
  return { step, total, items, done, tied: done && tiedForFirst(rank) };
}
