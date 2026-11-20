const fs = require('fs'), assert = require('assert'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8');
const L = new Function(src + '; return {scoreOf,catAverage,computeResults,missingScores,ranking,rankItems,tiedForFirst,firstOpenRound,judgeStats,CATEGORIES};')();
const mk = (scores, n = 3, jurors = ['A', 'B', 'C', 'D'], cats = {}) => ({ jurors, n, owners: { 1: 'A' }, scores, cats });
const all = v => ({ 0: v, 1: v, 2: v, 3: v });

// categories average: only rated ones count, none -> null
assert.strictEqual(L.catAverage([8, 6, null, null]), 7);
assert.strictEqual(L.catAverage([null, null, null, null]), null);
assert.strictEqual(L.catAverage([10, 9, 8, 7]), 8.5);

// plain mean of ALL jurors (owner not excluded); calibration (round 0) ignored
let s = mk({ 0: all(10), 1: { 0: 10, 1: 6, 2: 6, 3: 6 }, 2: { 0: 9, 1: 9, 2: 8, 3: 10 }, 3: { 0: 1, 1: 2, 2: 3, 3: 2 } });
let r = L.ranking(s);
assert.deepStrictEqual(r.map(x => [x.round, x.avg, x.place]), [[2, 9, 1], [1, 7, 2], [3, 2, 3]]);
assert.strictEqual(L.missingScores(s).length, 0);

// locked phone rating wins over manual score; unlocked draft is ignored
s = mk({ 1: { 0: 2 } }, 1, ['A', 'B'], { 1: { 0: { c: [8, 6, null, null], locked: true }, 1: { c: [10, 10, 10, 10], locked: false } } });
assert.strictEqual(L.scoreOf(s, 1, 0), 7);
assert.strictEqual(L.scoreOf(s, 1, 1), null);
assert.strictEqual(L.computeResults(s)[0].avg, 7);

// missing: every juror required in every round incl. calibration
assert.strictEqual(L.missingScores(mk({ 1: { 0: 5 } }, 1)).length, 4 + 3);

// ties: 1 A, 2 B, 2 C, 4 D  (place 3 skipped)
s = mk({ 1: all(9), 2: all(7), 3: all(7), 4: all(3) }, 4);
r = L.ranking(s);
assert.deepStrictEqual(r.map(x => [x.round, x.place]), [[1, 1], [2, 2], [3, 2], [4, 4]]);
assert.ok(!L.tiedForFirst(r));
r = L.ranking(mk({ 1: all(8), 2: all(8), 3: all(5) }));
assert.deepStrictEqual(r.map(x => x.place), [1, 1, 3]);
assert.ok(L.tiedForFirst(r));
r = L.ranking(mk({ 1: { 0: 7, 1: 7, 2: 8 }, 2: { 0: 8, 1: 7, 2: 7 }, 3: {} }, 3, ['A', 'B', 'C']));
assert.deepStrictEqual(r.map(x => x.place), [1, 1, null]);

// judge flow helpers
const lk = c => ({ c, locked: true });
assert.strictEqual(L.firstOpenRound({}, 2), 0);
assert.strictEqual(L.firstOpenRound({ 0: lk([5, 5, 5, 5]), 1: { c: [1, null, null, null], locked: false } }, 2), 1);
assert.strictEqual(L.firstOpenRound({ 0: lk([5, 5, 5, 5]), 1: lk([1, 1, 1, 1]), 2: lk([1, 1, 1, 1]) }, 2), null);

// judge stats: calibration excluded, ties 1,2,2,4, category means
const mine = { 0: lk([10, 10, 10, 10]), 1: lk([9, 9, 9, 9]), 2: lk([7, 7, 7, 7]), 3: lk([8, 6, null, null]), 4: lk([3, 3, 3, 3]) };
const st = L.judgeStats(mine, 4);
assert.deepStrictEqual(st.ranked.map(x => [x.round, x.place]), [[1, 1], [2, 2], [3, 2], [4, 4]]);
assert.strictEqual(st.mean, (9 + 7 + 7 + 3) / 4);
assert.deepStrictEqual(st.best.map(x => x.round), [1]);
assert.deepStrictEqual(st.worst.map(x => x.round), [4]);
assert.strictEqual(st.catMeans[0], (9 + 7 + 8 + 3) / 4);
assert.strictEqual(st.catMeans[2], (9 + 7 + 3) / 3);
console.log('logic tests passed');

// finale view reveals worst -> best, score first, then owner; never more than the step allows
{
  const L2 = new Function(fs.readFileSync(path.join(__dirname, 'logic.js'), 'utf8') + '; return {finaleView};')();
  const base = mk({ 1: all(9), 2: all(7), 3: all(7), 4: all(3) }, 4); base.owners = { 1: 'W', 2: 'X', 3: 'Y', 4: 'Z' };
  const at = step => L2.finaleView(Object.assign({}, base, { finale: { step } }));
  assert.strictEqual(L2.finaleView(base), null);
  assert.deepStrictEqual(at(0).items, []);
  assert.strictEqual(at(99).total, 6);                            // 3 places (1, 2/2, 4) -> 6 steps
  assert.deepStrictEqual(at(1).items, [{ round: 4, place: 4, avg: 3, owner: null }]);
  assert.deepStrictEqual(at(2).items, [{ round: 4, place: 4, avg: 3, owner: 'Z' }]);
  // tied rakije (2 and 3 share place 2) are revealed together, score first, then owners
  assert.deepStrictEqual(at(3).items.map(x => [x.round, x.place, x.owner]), [[2, 2, null], [3, 2, null], [4, 4, 'Z']]);
  assert.deepStrictEqual(at(4).items.map(x => [x.round, x.owner]), [[2, 'X'], [3, 'Y'], [4, 'Z']]);
  assert.ok(!at(5).items.some(x => x.owner === 'W') && at(5).items[0].round === 1 && at(5).items[0].owner === null);
  assert.strictEqual(at(99).done, true); assert.strictEqual(at(99).items.length, 4);
  assert.deepStrictEqual(at(99).items.map(x => x.place), [1, 2, 2, 4]);
  assert.strictEqual(at(99).tied, false);
  // all tied: one group, two steps; tie for first is reported
  const allTied = Object.assign(mk({ 1: all(5), 2: all(5), 3: all(5) }, 3), { owners: { 1: 'A', 2: 'B', 3: 'C' } });
  const t = s2 => L2.finaleView(Object.assign({}, allTied, { finale: { step: s2 } }));
  assert.strictEqual(t(99).total, 2); assert.strictEqual(t(1).items.length, 3); assert.ok(t(1).items.every(x => x.owner === null));
  assert.strictEqual(t(2).done, true); assert.strictEqual(t(2).tied, true);
  // unscored rakije form one group (place null) that is revealed first
  const part = Object.assign(mk({ 1: all(8) }, 3), { owners: {} });
  const pv = s2 => L2.finaleView(Object.assign({}, part, { finale: { step: s2 } }));
  assert.strictEqual(pv(99).total, 4); assert.deepStrictEqual(pv(1).items.map(x => [x.round, x.place]), [[2, null], [3, null]]);
  console.log('finale tests passed');
}
