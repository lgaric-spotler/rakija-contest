// Shared UI helpers for all pages (host, judges, viewers).
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const k in (attrs || {})) {
    if (k === 'class') e.className = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] === true) e.setAttribute(k, '');
    else if (attrs[k] !== false && attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
  }
  kids.flat().forEach(c => e.append(c instanceof Node ? c : document.createTextNode(c)));
  return e;
}

const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

// Finale list. One persistent DOM list per page: a card is created once (keyed by rakija number) and
// updated in place, so a new reveal slides the existing cards down and pops the new one in
// instead of redrawing everything. f comes from finaleView().
const reveal = { list: null, cards: new Map(), primed: false };

function cardInner(x) {
  return [
    el('div', { class: 'place' }, x.place === null ? '–' : x.place + '.', x.place && MEDAL[x.place] ? el('small', {}, MEDAL[x.place]) : ''),
    el('div', { class: 'who' }, el('b', {}, 'Rakija ' + x.round), el('div', { class: 'mute owner' }, x.owner === null ? 'vlasnik: ???' : '🥃 ' + x.owner)),
    el('div', { class: 'avg' }, x.avg === null ? '—' : x.avg.toFixed(2))];
}

function rankCards(f) {
  if (!reveal.list) reveal.list = el('div', { class: 'ranklist' });
  const list = reveal.list, cards = reveal.cards;
  if (!f.items.length) { cards.clear(); list.replaceChildren(); reveal.primed = true; return list; }   // (re)start of a finale
  const before = new Map();                                    // current vertical position of each card in the list
  cards.forEach((c, k) => { if (c.node.parentNode === list) before.set(k, c.node.offsetTop); });
  const next = [], added = [], ownerChanged = [];
  f.items.forEach(x => {
    const sig = [x.place, x.avg, x.owner].join('|'), old = cards.get(x.round);
    const cls = 'rank' + (x.place && x.place <= 3 ? ' p' + x.place : '');
    if (old && old.sig === sig) { next.push(old); return; }
    const node = old ? old.node : el('div', {});
    node.className = cls; node.replaceChildren(...cardInner(x));
    const c = { node, sig, round: x.round };
    if (!old) added.push(c); else if (old.owner === null && x.owner !== null) ownerChanged.push(c);
    c.owner = x.owner; cards.set(x.round, c); next.push(c);
  });
  cards.forEach((c, k) => { if (!f.items.some(x => x.round === k)) cards.delete(k); });
  list.replaceChildren(...next.map(c => c.node));
  const animate = reveal.primed;
  reveal.primed = true;
  if (animate && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
    next.forEach(c => {
      if (!c.node.animate) return;
      if (added.includes(c)) c.node.animate([{ transform: 'scale(.6) translateY(-14px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, delay: 220, fill: 'backwards', easing: 'cubic-bezier(.2,1.4,.4,1)' });   // after the others made room
      else if (before.has(c.round)) {
        const d = before.get(c.round) - c.node.offsetTop;
        if (d) c.node.animate([{ transform: 'translateY(' + d + 'px)' }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.3,.7,.3,1)' });
      }
      if (ownerChanged.includes(c)) c.node.querySelector('.owner').animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 450 });
    });
  });
  return list;
}

// the view judges and viewers get while the host runs the finale
function revealView(f) {
  return el('div', {},
    el('div', { class: 'card center' },
      el('h2', { style: 'justify-content:center' }, '🏆 Finale'),
      el('p', { class: 'mute' }, f.done ? 'Gotovo 🎉' : f.items.length ? 'Točitelj otkriva rezultate…' : 'Počinje od zadnjeg mjesta…'),
      f.done && f.tied ? el('div', { class: 'warn' }, 'Izjednačeno za 1. mjesto → blind dvoboj.') : ''),
    rankCards(f));
}
