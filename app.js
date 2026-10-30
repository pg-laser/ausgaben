'use strict';

// ---------- Konstanten ----------

const STORAGE_KEY = 'ausgaben-web-v1';
const SYNC_KEY = 'ausgaben-sync-v1';
const THEME_KEY = 'ausgaben-theme';
const STATEMENT_KEY = 'ausgaben-statements-v1';
const TABLES = ['categories', 'entries', 'recurring', 'accounts', 'balances', 'loans', 'rules'];
const COLORS = ['#66BB6A', '#42A5F5', '#FFA726', '#AB47BC', '#EF5350', '#26C6DA', '#8D6E63', '#78909C', '#FFEE58', '#5C6BC0'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const ACCOUNT_TYPES = { giro: 'Girokonto', tagesgeld: 'Tagesgeld', depot: 'Depot', bargeld: 'Bargeld' };
const METHOD_LABELS = { card: 'Karte', cash: 'Bar', transfer: 'Überweisung' };
const INCOME_COLOR = '#2E7D32';
const EXPENSE_COLOR = '#E53935';
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

/** Attribute, damit Passwort-Manager dieses Feld nicht als Anmeldefeld behandeln. */
const LOCK = {
  autocomplete: 'off',
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
};
const field = props => el('input', { ...LOCK, class: 'input', ...props });

// ---------- IDs und Datenformat ----------
// Beträge in Cent, Datum "JJJJ-MM-TT", Monat "JJJJ-MM".

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const isUid = id => typeof id === 'string' && (id.length >= 20 || id.startsWith('seed-'));

function seedData() {
  const defaults = [
    ['Lebensmittel', 'expense', '#66BB6A'],
    ['Wohnen', 'expense', '#42A5F5'],
    ['Verkehr', 'expense', '#FFA726'],
    ['Versicherungen', 'expense', '#78909C'],
    ['Freizeit', 'expense', '#AB47BC'],
    ['Sonstiges', 'expense', '#8D6E63'],
    ['Gehalt 1', 'income', '#26C6DA'],
    ['Gehalt 2', 'income', '#5C6BC0'],
  ];
  const out = {};
  TABLES.forEach(t => { out[t] = []; });
  out.categories = defaults.map(([name, kind, color], i) => ({ id: 'seed-' + (i + 1), name, kind, color, budget: null }));
  return out;
}

/** Bringt Daten auf das aktuelle Format. Fehlende Tabellen werden leer angelegt. */
function normalize(data, forceDirty) {
  const now = Date.now();
  const catMap = new Map();
  const out = {};
  TABLES.forEach(t => { out[t] = []; });

  for (const t of TABLES) {
    for (const r of (data[t] || [])) {
      const reassigned = !isUid(r.id);
      let id = r.id;
      if (reassigned) {
        const oldNum = Number(r.id);
        id = (t === 'categories' && oldNum >= 1 && oldNum <= 8) ? 'seed-' + oldNum : uid();
        if (t === 'categories') catMap.set(String(r.id), id);
      }
      out[t].push({
        ...r,
        id,
        deleted: !!r.deleted,
        updatedAt: Number(r.updatedAt) || now,
        _dirty: !!forceDirty || reassigned || r._dirty === true,
      });
    }
  }
  for (const t of ['entries', 'recurring', 'rules']) {
    for (const r of out[t]) {
      if (catMap.has(String(r.categoryId))) r.categoryId = catMap.get(String(r.categoryId));
    }
  }
  return out;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw), false);
  } catch (e) { /* Startdaten verwenden */ }
  return normalize(seedData(), true);
}

let state = loadState();

function loadStatements() {
  try { return JSON.parse(localStorage.getItem(STATEMENT_KEY)) || []; } catch (e) { return []; }
}
let statements = loadStatements();

function saveStatements() {
  try {
    localStorage.setItem(STATEMENT_KEY, JSON.stringify(statements));
  } catch (e) {
    alert('Der Speicher ist voll, der Kontoauszug konnte nicht archiviert werden.');
  }
}

const live = table => state[table].filter(r => !r.deleted);
const catById = id => live('categories').find(c => c.id === id);
const findRec = (table, id) => state[table].find(r => r.id === id);
const accountById = id => live('accounts').find(a => a.id === id);
const ymOf = e => e.ym || e.date.slice(0, 7);

function balanceOf(accountId, ym) {
  return live('balances').find(b => b.accountId === accountId && b.ym === ym) || null;
}

function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    alert('Die Daten konnten nicht gespeichert werden. Ist der Speicher des Browsers voll oder blockiert?');
  }
}

/** Nach jeder Änderung: lokal speichern, anzeigen, Synchronisation anstoßen. */
function persist() {
  saveLocal();
  render();
  scheduleSync();
}

function add(table, fields) {
  state[table].push({ id: uid(), ...fields, deleted: false, updatedAt: Date.now(), _dirty: true });
  persist();
}

function update(table, id, fields) {
  const rec = findRec(table, id);
  if (!rec) return;
  Object.assign(rec, fields, { updatedAt: Date.now(), _dirty: true });
  persist();
}

function remove(table, id) {
  const rec = findRec(table, id);
  if (!rec) return;
  rec.deleted = true;
  rec.updatedAt = Date.now();
  rec._dirty = true;
  persist();
}

function setBalance(accountId, ym, cents) {
  const ex = balanceOf(accountId, ym);
  if (ex) update('balances', ex.id, { amount: cents });
  else add('balances', { accountId, ym, amount: cents });
}

// ---------- Synchronisation ----------

let sync = loadSync();
let syncMsg = sync.url ? 'Nicht synchronisiert' : 'Keine Verbindung eingerichtet';
let syncTimer = null;
let syncing = false;

function loadSync() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch (e) { return {}; }
}

function saveSync() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (e) { /* ignorieren */ }
}

function setStatus(msg) {
  syncMsg = msg;
  const node = document.getElementById('sync-status');
  if (node) node.textContent = msg;
}

function scheduleSync() {
  if (!sync.url || !sync.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 1500);
}

function payload(r) {
  const { _dirty, id, updatedAt, deleted, ...data } = r;
  return data;
}

function mergeIncoming(ch) {
  if (!TABLES.includes(ch.table)) return;
  const local = findRec(ch.table, ch.id);
  if (local) {
    if (local._dirty && local.updatedAt >= ch.updatedAt) return;
    Object.assign(local, ch.data, { updatedAt: ch.updatedAt, deleted: ch.deleted, _dirty: false });
  } else {
    state[ch.table].push({ ...ch.data, id: ch.id, updatedAt: ch.updatedAt, deleted: ch.deleted, _dirty: false });
  }
}

async function runSync() {
  if (!sync.url || !sync.token || syncing) return;
  if (!navigator.onLine) {
    setStatus('Offline. Die Synchronisation läuft, sobald wieder Verbindung besteht.');
    return;
  }
  syncing = true;
  setStatus('Synchronisiere …');
  try {
    const changes = [];
    for (const t of TABLES) {
      for (const r of state[t]) {
        if (r._dirty) changes.push({ table: t, id: r.id, data: payload(r), updatedAt: r.updatedAt, deleted: !!r.deleted });
      }
    }
    const res = await fetch(sync.url.replace(/\/+$/, '') + '/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sync.token },
      body: JSON.stringify({ since: sync.seq || 0, changes }),
    });
    if (res.status === 401) throw new Error('Schlüssel falsch');
    if (!res.ok) throw new Error('Server antwortet mit ' + res.status);
    const body = await res.json();

    for (const c of changes) {
      const rec = findRec(c.table, c.id);
      if (rec && rec.updatedAt === c.updatedAt) rec._dirty = false;
    }
    body.changes.forEach(mergeIncoming);
    sync.seq = body.seq;
    saveSync();
    saveLocal();
    setStatus('Zuletzt synchronisiert: ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }));
    if (body.changes.length > 0) render();
  } catch (e) {
    setStatus('Sync fehlgeschlagen: ' + e.message);
  } finally {
    syncing = false;
  }
}

// ---------- Zeit und Format ----------

const pad = n => String(n).padStart(2, '0');
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const todayYm = () => todayIso().slice(0, 7);
const todayDay = () => Number(todayIso().slice(8, 10));
const daysIn = ym => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};
const dateIn = (ym, day) => `${ym}-${pad(Math.min(day, daysIn(ym)))}`;
const money = cents => eur.format(cents / 100);
const centsToInput = c => (c / 100).toFixed(2).replace('.', ',');
const sum = list => list.reduce((s, x) => s + x.cents, 0);
const shortYm = ym => MONTHS[Number(ym.slice(5)) - 1].slice(0, 3) + ' ' + ym.slice(2, 4);

function addMonths(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function monthsBetween(a, b) {
  const out = [];
  let ym = a;
  while (ym <= b) {
    out.push(ym);
    ym = addMonths(ym, 1);
  }
  return out;
}

let currentYm = todayYm();
let tab = 'overview';
let tipText = '';
let suppressClick = false;

/** Euro-Eingabe in Cent, nur positive Beträge. „12,50“ und „12.50“ sind erlaubt. */
function parseCents(text) {
  const c = parseEuro(text);
  return c !== null && c > 0 ? c : 0;
}

/** Euro-Eingabe mit Vorzeichen. Leer ergibt null. */
function parseEuro(text) {
  let s = String(text).replace(/[€\s]/g, '');
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Alle Buchungen eines Monats. Fixkosten erscheinen zwischen Start- und Endmonat. */
function monthEntries(ym) {
  const tx = live('entries')
    .filter(e => ymOf(e) === ym)
    .map(e => ({ id: e.id, fixed: false, kind: e.kind, amount: e.amount, categoryId: e.categoryId, note: e.note, date: e.date, method: e.method }));
  const fixed = live('recurring')
    .filter(r => r.startYm <= ym && (!r.endYm || ym <= r.endYm))
    .map(r => ({ id: r.id, fixed: true, kind: r.kind, amount: r.amount, categoryId: r.categoryId, note: r.note, date: dateIn(ym, r.day), method: r.method }));
  return [...tx, ...fixed].sort((a, b) => b.date.localeCompare(a.date));
}

/** Summen pro Kategorie. Umbuchungen zählen nicht. */
function segsOf(entries, kind) {
  const totals = new Map();
  entries
    .filter(e => e.kind === kind)
    .forEach(e => totals.set(e.categoryId, (totals.get(e.categoryId) || 0) + e.amount));
  return [...totals]
    .map(([id, cents]) => {
      const c = catById(id);
      return {
        name: c ? c.name : 'Ohne Kategorie',
        color: c ? c.color : '#9E9E9E',
        cents,
        budget: c && c.budget ? c.budget : null,
      };
    })
    .sort((a, b) => b.cents - a.cents);
}

// ---------- Vermögen und Kredit ----------

/** Vermögen zum Monatsende: letzter bekannter Kontostand je Konto, abzüglich Restschuld. */
function netWorth(ym) {
  let assets = 0;
  const missing = [];
  for (const a of live('accounts')) {
    const b = live('balances')
      .filter(x => x.accountId === a.id && x.ym <= ym)
      .sort((x, y) => y.ym.localeCompare(x.ym))[0];
    if (b) assets += b.amount;
    else missing.push(a);
  }
  const l = live('loans')
    .filter(x => x.ym <= ym)
    .sort((x, y) => y.ym.localeCompare(x.ym))[0];
  const debt = l ? l.saldo : 0;
  return { assets, debt, net: assets - debt, missing };
}

/** Erinnerung zum Monatsende, wenn Kontostände für den Monat fehlen. */
function reminderNode() {
  if (todayDay() < 25) return null;
  const missing = live('accounts').filter(a => !balanceOf(a.id, todayYm()));
  if (!missing.length) return null;
  return el('div', {
    class: 'banner',
    onclick: () => { tab = 'accounts'; render(); },
  }, `Monatsende: Bitte die Kontostände für ${MONTHS[Number(todayYm().slice(5)) - 1]} eintragen (${missing.map(a => a.name).join(', ')}).`);
}

// ---------- DOM-Hilfen ----------

/** Erzeugt ein Element. Text wird immer als Text eingefügt, nicht als HTML. */
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function dot(cat, color) {
  return el('span', { class: 'dot', style: { background: color || (cat ? cat.color : '#9E9E9E') } });
}

function monthNav() {
  const [y, m] = currentYm.split('-').map(Number);
  return el('div', { class: 'monthnav' },
    el('button', { class: 'icon', 'aria-label': 'Vorheriger Monat', onclick: () => shiftMonth(-1) }, '‹'),
    el('strong', {}, `${MONTHS[m - 1]} ${y}`),
    el('button', { class: 'icon', 'aria-label': 'Nächster Monat', onclick: () => shiftMonth(1) }, '›'));
}

function shiftMonth(delta) {
  currentYm = addMonths(currentYm, delta);
  tipText = '';
  render();
}

/** Nach links wischen löscht (nach Rückfrage). */
function swipeToDelete(node, onDelete) {
  let startX = null;
  node.addEventListener('pointerdown', e => { startX = e.clientX; });
  node.addEventListener('pointerup', e => {
    if (startX !== null && startX - e.clientX > 90) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 300);
      onDelete();
    }
    startX = null;
  });
  node.addEventListener('pointercancel', () => { startX = null; });
}

/** Zwei oder drei Knöpfe nebeneinander, einer ist aktiv. */
function segControl(options, value, onChange) {
  let current = value;
  const btns = options.map(([v, label]) => el('button', {
    type: 'button',
    class: 'seg-btn',
    onclick: () => {
      current = v;
      btns.forEach((b, i) => b.classList.toggle('on', options[i][0] === current));
      onChange(v);
    },
  }, label));
  btns.forEach((b, i) => b.classList.toggle('on', options[i][0] === current));
  return el('div', { class: 'seg' }, ...btns);
}

// ---------- Übersicht ----------

function viewOverview() {
  const entries = monthEntries(currentYm);
  const inc = segsOf(entries, 'income');
  const exp = segsOf(entries, 'expense');
  const incT = sum(inc);
  const expT = sum(exp);
  const rest = incT - expT;
  const max = Math.max(incT, expT, 1);

  return el('div', {},
    monthNav(),
    el('div', { class: 'card' },
      el('div', { class: 'bar-label' }, el('span', {}, 'Einnahmen'), el('strong', {}, money(incT))),
      bar(inc, max),
      el('div', { class: 'bar-label' }, el('span', {}, 'Ausgaben'), el('strong', {}, money(expT))),
      bar(exp, max),
      el('div', { class: 'tip' }, tipText || 'Tippe auf ein Segment, um den Betrag zu sehen.'),
      el('div', { class: 'rest ' + (rest >= 0 ? 'pos' : 'neg') }, `Übrig: ${money(rest)}`),
      legend('Einnahmen', inc)),
    el('div', { class: 'big' }, money(expT)),
    el('div', { class: 'muted' }, 'Ausgaben in diesem Monat'),
    ...exp.map(s => catRow(s, expT)),
    exp.length ? null : el('p', { class: 'muted' }, 'Noch keine Ausgaben in diesem Monat.'));
}

function bar(segs, max) {
  const total = sum(segs);
  const track = el('div', { class: 'bar' });
  if (total > 0) {
    const inner = el('div', { class: 'bar-inner', style: { width: (total / max * 100) + '%' } });
    segs.forEach(s => inner.append(el('div', {
      title: `${s.name}: ${money(s.cents)}`,
      style: { flexGrow: String(s.cents), background: s.color },
      onclick: () => {
        tipText = `${s.name}: ${money(s.cents)}`;
        render();
      },
    })));
    track.append(inner);
  }
  return track;
}

function legend(title, segs) {
  if (!segs.length) return null;
  return el('div', { class: 'legend' },
    el('div', { class: 'label' }, title),
    ...segs.map(s => el('div', { class: 'legend-row' },
      el('span', { class: 'dot', style: { background: s.color } }),
      el('span', { class: 'grow' }, s.name),
      el('span', {}, money(s.cents)))));
}

function catRow(seg, total) {
  const pct = total ? (seg.cents / total) * 100 : 0;
  let progressPct = pct;
  let budgetLine = null;
  let over = false;
  if (seg.budget) {
    progressPct = seg.cents / seg.budget * 100;
    over = seg.cents > seg.budget;
    budgetLine = el('div', { class: over ? 'small neg' : 'muted small' },
      `${money(seg.cents)} von ${money(seg.budget)}` + (over ? ' · überschritten' : ''));
  }
  return el('div', { class: 'cat' },
    el('div', { class: 'circle', style: { background: seg.color } }, seg.name.charAt(0).toUpperCase()),
    el('div', { class: 'grow' },
      el('div', { class: 'between' }, el('span', {}, seg.name), el('span', {}, money(seg.cents))),
      el('div', { class: 'progress' }, el('div', {
        style: { width: Math.min(progressPct, 100) + '%', background: over ? 'var(--danger)' : seg.color },
      })),
      budgetLine));
}

// ---------- Verlauf ----------

function viewHistory() {
  const q = field({ type: 'search', placeholder: 'Suchen (Notiz oder Kategorie)' });
  const catSel = el('select', { class: 'input' },
    el('option', { value: '' }, 'Alle Kategorien'),
    ...live('categories').map(c => el('option', { value: c.id }, c.name)));
  const list = el('div', {});

  function draw() {
    const term = q.value.trim().toLowerCase();
    const catId = catSel.value;
    const entries = monthEntries(currentYm).filter(e => {
      if (catId && e.categoryId !== catId) return false;
      if (!term) return true;
      const c = catById(e.categoryId);
      return (e.note || '').toLowerCase().includes(term) || (c && c.name.toLowerCase().includes(term));
    });
    list.replaceChildren(...(entries.length
      ? entries.map(e => entryRow(e))
      : [el('p', { class: 'muted' }, 'Keine Einträge gefunden.')]));
  }
  q.addEventListener('input', draw);
  catSel.addEventListener('change', draw);
  draw();

  return el('div', {},
    monthNav(),
    el('div', { class: 'filters' }, q, catSel),
    list);
}

function entryRow(e) {
  const cat = catById(e.categoryId);
  const [, m, d] = e.date.split('-');
  const isTransfer = e.kind === 'transfer';
  const details = [
    `${d}.${m}.`,
    e.fixed ? 'Fixkosten' : null,
    e.method ? METHOD_LABELS[e.method] : null,
    e.note || null,
  ].filter(Boolean).join(' · ');
  const inc = e.kind === 'income';
  const table = e.fixed ? 'recurring' : 'entries';
  const label = isTransfer ? 'Umbuchung' : (cat ? cat.name : 'Ohne Kategorie');
  const sign = isTransfer ? '⇄ ' : (inc ? '+' : '−');
  const cls = isTransfer ? 'muted' : (inc ? 'pos' : 'neg');

  const node = el('div', { class: 'row compact tap' },
    dot(cat, isTransfer ? '#9E9E9E' : undefined),
    el('div', { class: 'grow' },
      el('div', { class: 'row-title' }, label),
      el('div', { class: 'muted small' }, details)),
    el('div', { class: cls }, sign + money(e.amount)),
    el('button', {
      class: 'icon', 'aria-label': 'Löschen',
      onclick: ev => {
        ev.stopPropagation();
        if (confirm(e.fixed ? 'Diese Fixkosten dauerhaft entfernen?' : 'Eintrag löschen?')) remove(table, e.id);
      },
    }, '🗑'));
  node.addEventListener('click', () => {
    if (suppressClick) return;
    const rec = findRec(table, e.id);
    if (rec) openEntryDialog({ table, rec });
  });
  swipeToDelete(node, () => {
    if (confirm(e.fixed ? 'Diese Fixkosten dauerhaft entfernen?' : 'Eintrag löschen?')) remove(table, e.id);
  });
  return node;
}

// ---------- Fixkosten ----------

function viewFixed() {
  return el('div', {},
    el('h2', {}, 'Fixe Buchungen'),
    el('p', { class: 'muted small' },
      'Erscheinen jeden Monat automatisch. Mit dem + unten legst du neue an. Tippen zum Bearbeiten. „Letzter Monat“ beendet ein Abo, ohne alte Monate zu löschen.'),
    live('recurring').length ? null : el('p', {}, 'Noch keine Fixkosten angelegt.'),
    ...live('recurring').map(r => {
      const cat = catById(r.categoryId);
      const [y, m] = r.startYm.split('-');
      const inc = r.kind === 'income';
      let period = `ab ${m}/${y}`;
      if (r.endYm) {
        const [ey, em] = r.endYm.split('-');
        period += ` bis ${em}/${ey}`;
      }
      const node = el('div', { class: 'row compact tap' },
        dot(cat),
        el('div', { class: 'grow' },
          el('div', { class: 'row-title' }, cat ? cat.name : 'Ohne Kategorie'),
          el('div', { class: 'muted small' },
            `${inc ? 'Einnahme' : 'Ausgabe'} · jeden Monat am ${r.day}. · ${period}` + (r.note ? ` · ${r.note}` : ''))),
        el('div', { class: inc ? 'pos' : 'neg' }, (inc ? '+' : '−') + money(r.amount)),
        el('button', {
          class: 'icon', 'aria-label': 'Fixkosten löschen',
          onclick: ev => {
            ev.stopPropagation();
            if (confirm('Diese Fixkosten dauerhaft entfernen?')) remove('recurring', r.id);
          },
        }, '🗑'));
      node.addEventListener('click', () => {
        if (!suppressClick) openEntryDialog({ table: 'recurring', rec: r });
      });
      swipeToDelete(node, () => {
        if (confirm('Diese Fixkosten dauerhaft entfernen?')) remove('recurring', r.id);
      });
      return node;
    }));
}

// ---------- Konten ----------

function viewAccounts() {
  const accounts = live('accounts');
  const inputs = [];

  const balanceRows = accounts.map(a => {
    const b = balanceOf(a.id, currentYm);
    const input = field({
      type: 'text',
      inputmode: 'decimal',
      placeholder: '0,00',
      value: b ? centsToInput(b.amount) : '',
      class: 'input bal',
    });
    inputs.push({ acc: a, input });
    return el('div', { class: 'row compact' },
      el('div', { class: 'grow' },
        el('div', { class: 'row-title' }, a.name),
        el('div', { class: 'muted small' },
          ACCOUNT_TYPES[a.type] + (a.iban ? ' · ····' + a.iban.slice(-4) : ''))),
      input,
      el('button', {
        class: 'icon', 'aria-label': 'Konto löschen',
        onclick: () => {
          if (confirm(`„${a.name}“ löschen? Die Buchungen bleiben erhalten.`)) remove('accounts', a.id);
        },
      }, '🗑'));
  });

  const saveBalances = el('button', {
    class: 'primary wide',
    onclick: () => {
      let n = 0;
      inputs.forEach(({ acc, input }) => {
        const c = parseEuro(input.value);
        if (c !== null) {
          setBalance(acc.id, currentYm, c);
          n++;
        }
      });
      if (n) setStatus(`${n} Kontostände für ${shortYm(currentYm)} gespeichert.`);
    },
  }, 'Kontostände speichern');

  return el('div', {},
    monthNav(),
    el('h3', {}, 'Kontostände am Monatsende'),
    el('p', { class: 'muted small' },
      'Girokonten kommen beim Import automatisch. Bargeld und Depots trägst du hier von Hand ein. Minusbeträge sind möglich.'),
    balanceRows.length ? balanceRows : el('p', {}, 'Noch keine Konten angelegt.'),
    saveBalances,
    el('div', { class: 'row-buttons' },
      el('button', { onclick: openAccountDialog }, 'Konto hinzufügen'),
      el('button', { onclick: () => csvInput.click() }, 'Kontoauszug importieren')),
    netWorthCard(),
    loanSection(),
    statementsSection());
}

function netWorthCard() {
  const nw = netWorth(currentYm);
  return el('div', {},
    el('h3', {}, 'Vermögen'),
    el('div', { class: 'card' },
      el('div', { class: 'bar-label' }, el('span', {}, 'Konten und Depots'), el('strong', {}, money(nw.assets))),
      el('div', { class: 'bar-label' }, el('span', {}, 'Restschuld Kredit'), el('strong', {}, '− ' + money(nw.debt))),
      el('div', { class: 'rest ' + (nw.net >= 0 ? 'pos' : 'neg') }, `Netto: ${money(nw.net)}`),
      nw.missing.length
        ? el('div', { class: 'muted small' }, 'Fehlt noch für diesen Monat: ' + nw.missing.map(a => a.name).join(', '))
        : null));
}

function loanSection() {
  const loans = live('loans').slice().sort((a, b) => b.ym.localeCompare(a.ym));
  if (!loans.length) {
    return el('div', {},
      el('h3', {}, 'Immobilienkredit'),
      el('p', { class: 'muted small' },
        'Noch keine Kreditdaten. Sie kommen automatisch aus dem Kontoauszug, sobald dort eine Rate mit Tilgung und Zinsen steht.'));
  }

  const last = loans[0];
  const monthly = last.zins / (last.saldo + last.tilg);
  const annual = (monthly * 12 * 100).toFixed(2).replace('.', ',');

  const proj = [];
  let s = last.saldo;
  let ym = last.ym;
  for (let n = 1; n <= 600 && s > 0; n++) {
    ym = addMonths(ym, 1);
    const z = Math.round(s * monthly);
    const t = last.rate - z;
    if (t <= 0) break;
    const t2 = Math.min(t, s);
    s -= t2;
    proj.push({ ym, z, t: t2, s });
  }
  const end = proj.length ? proj[proj.length - 1].ym : null;

  return el('div', {},
    el('h3', {}, 'Immobilienkredit'),
    el('div', { class: 'card' },
      el('div', { class: 'bar-label' }, el('span', {}, 'Restschuld'), el('strong', {}, money(last.saldo))),
      el('div', { class: 'bar-label' }, el('span', {}, 'Monatliche Rate'), el('strong', {}, money(last.rate))),
      el('div', { class: 'muted small' }, `Zinssatz ca. ${annual} % pro Jahr (aus den Buchungen berechnet)`),
      end ? el('div', { class: 'muted small' }, `Bei gleicher Rate ca. ${proj.length} Monate, Ende ca. ${shortYm(end)}. Sondertilgungen sind nicht berücksichtigt.`) : null),
    el('h3', {}, 'Vorschau nächste 6 Monate'),
    tableNode(['Monat', 'Zinsen', 'Tilgung', 'Restschuld'],
      proj.slice(0, 6).map(p => [shortYm(p.ym), money(p.z), money(p.t), money(p.s)])),
    el('h3', {}, 'Bisherige Raten'),
    tableNode(['Monat', 'Rate', 'Zinsen', 'Tilgung', 'Restschuld'],
      loans.slice(0, 12).map(l => [shortYm(l.ym), money(l.rate), money(l.zins), money(l.tilg), money(l.saldo)])));
}

function tableNode(headers, rows) {
  return el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {}, ...headers.map(h => el('th', {}, h)))),
    el('tbody', {}, ...rows.map(r => el('tr', {}, ...r.map(c => el('td', {}, c))))));
}

function statementsSection() {
  return el('div', {},
    el('h3', {}, 'Kontoauszüge'),
    el('p', { class: 'muted small' }, 'Alle importierten Auszüge bleiben hier gespeichert, auch über mehrere Jahre. Sie liegen nur auf diesem Gerät.'),
    statements.length ? null : el('p', {}, 'Noch keine Auszüge importiert.'),
    ...statements.map(st => el('div', { class: 'row compact' },
      el('div', { class: 'grow' },
        el('div', { class: 'row-title' }, st.name),
        el('div', { class: 'muted small' },
          `${st.periodYm ? shortYm(st.periodYm) : ''} · ${st.count} neue Buchungen · importiert ${new Date(st.savedAt).toLocaleDateString('de-DE')}`)),
      el('button', {
        class: 'icon', 'aria-label': 'Anzeigen',
        onclick: () => showStatement(st),
      }, '👁'),
      el('button', {
        class: 'icon', 'aria-label': 'Auszug löschen',
        onclick: () => {
          if (!confirm('Diesen Kontoauszug aus dem Archiv löschen? Die Buchungen bleiben erhalten.')) return;
          statements = statements.filter(x => x.id !== st.id);
          saveStatements();
          render();
        },
      }, '🗑'))));
}

function showStatement(st) {
  const dlg = el('dialog', { class: 'sheet wide' },
    el('h2', {}, st.name),
    el('pre', { class: 'raw' }, st.raw),
    el('div', { class: 'actions' }, el('button', { type: 'button', onclick: () => dlg.close() }, 'Schließen')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

function openAccountDialog() {
  let type = 'giro';
  const nameInput = field({ type: 'text', placeholder: 'Name, z. B. DKB Girokonto', value: '' });
  const ibanInput = field({ type: 'text', placeholder: 'IBAN (optional, für Umbuchungen)', value: '' });
  const typeSel = el('select', { class: 'input' },
    ...Object.entries(ACCOUNT_TYPES).map(([v, label]) => el('option', { value: v }, label)));
  const saveBtn = el('button', { type: 'button', class: 'primary' }, 'Speichern');
  const validate = () => { saveBtn.disabled = nameInput.value.trim() === ''; };
  nameInput.addEventListener('input', validate);
  saveBtn.addEventListener('click', () => {
    const fields = { name: nameInput.value.trim(), type: typeSel.value, iban: ibanInput.value.replace(/\s/g, '') };
    dlg.close();
    add('accounts', fields);
  });
  const dlg = el('dialog', { class: 'sheet' },
    el('h2', {}, 'Neues Konto'),
    el('div', { class: 'label' }, 'Name'), nameInput,
    el('div', { class: 'label' }, 'Art'), typeSel,
    el('div', { class: 'label' }, 'IBAN'), ibanInput,
    el('div', { class: 'actions' },
      el('button', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      saveBtn));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  validate();
  dlg.showModal();
  nameInput.focus();
}

// ---------- Auswertung ----------

function viewStats() {
  const months = monthsBetween(addMonths(currentYm, -11), currentYm);
  const data = months.map(ym => {
    const e = monthEntries(ym);
    const inc = sum(segsOf(e, 'income'));
    const exp = sum(segsOf(e, 'expense'));
    const loan = live('loans').find(l => l.ym === ym);
    return { ym, inc, exp, rest: inc - exp, net: netWorth(ym).net, loan };
  });

  const maxNet = Math.max(1, ...data.map(d => Math.abs(d.net)));
  const maxExp = Math.max(1, ...data.map(d => Math.max(d.inc, d.exp)));
  const nw = netWorth(currentYm);

  // Ausgaben nach Kategorie im laufenden Jahr
  const year = currentYm.slice(0, 4);
  const yearEntries = [];
  for (const e of live('entries')) if (ymOf(e).startsWith(year)) yearEntries.push({ ...e, amount: e.amount });
  for (const r of live('recurring')) {
    for (const ym of monthsBetween(r.startYm, year + '-12')) {
      if (!ym.startsWith(year)) continue;
      if (r.endYm && ym > r.endYm) break;
      yearEntries.push({ kind: r.kind, amount: r.amount, categoryId: r.categoryId });
    }
  }
  const yearCats = segsOf(yearEntries, 'expense');
  const yearSum = sum(yearCats);

  return el('div', {},
    monthNav(),
    el('h3', {}, 'Vermögen'),
    el('div', { class: 'card' },
      el('div', { class: 'big-small' }, money(nw.net)),
      el('div', { class: 'muted small' }, `Konten und Depots ${money(nw.assets)} · Restschuld ${money(nw.debt)}`)),
    el('h3', {}, 'Vermögensverlauf, 12 Monate'),
    ...data.map(d => statRow(shortYm(d.ym), money(d.net), Math.abs(d.net) / maxNet * 100, d.net >= 0 ? INCOME_COLOR : EXPENSE_COLOR)),
    el('h3', {}, 'Einnahmen und Ausgaben, 12 Monate'),
    ...data.map(d => el('div', { class: 'stat-block' },
      el('div', { class: 'stat-head' },
        el('span', {}, shortYm(d.ym)),
        el('span', { class: d.rest >= 0 ? 'pos' : 'neg' }, `Rest ${money(d.rest)}`)),
      statRow('Einnahmen', money(d.inc), d.inc / maxExp * 100, INCOME_COLOR),
      statRow('Ausgaben', money(d.exp), d.exp / maxExp * 100, EXPENSE_COLOR))),
    el('h3', {}, 'Sparquote'),
    ...data.map(d => {
      const rate = d.inc > 0 ? Math.round(d.rest / d.inc * 100) : null;
      return statRow(shortYm(d.ym), rate === null ? 'keine Einnahmen' : `${rate} %`, rate === null ? 0 : Math.max(0, rate), rate !== null && rate >= 0 ? INCOME_COLOR : EXPENSE_COLOR);
    }),
    el('h3', {}, 'Kredit: Zinsen und Tilgung'),
    ...data.filter(d => d.loan).map(d => statRow(
      shortYm(d.ym),
      `Z ${money(d.loan.zins)} · T ${money(d.loan.tilg)}`,
      d.loan.zins / d.loan.rate * 100,
      '#8D6E63')),
    data.some(d => d.loan) ? el('p', { class: 'muted small' }, 'Balken: Zinsanteil an der Rate. Der Rest ist Tilgung.') : null,
    el('h3', {}, `Ausgaben nach Kategorie, ${year}`),
    yearCats.length
      ? yearCats.map(c => statRow(c.name, money(c.cents), yearSum ? c.cents / yearSum * 100 : 0, c.color))
      : el('p', { class: 'muted' }, 'Noch keine Ausgaben in diesem Jahr.'));
}

function statRow(label, value, pct, color) {
  const w = Math.max(0, Math.min(100, pct));
  return el('div', { class: 'stat' },
    el('div', { class: 'lbl' }, label),
    el('div', { class: 'track' }, el('div', { style: { width: w + '%', background: color } })),
    el('div', { class: 'val' }, value));
}

// ---------- Einstellungen ----------

function viewSettings() {
  const sorted = [...live('categories')].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'de'));
  const rules = live('rules');

  return el('div', {},
    el('h2', {}, 'Einstellungen'),
    el('h3', {}, 'Kategorien und Einnahmequellen'),
    el('button', { class: 'primary wide', onclick: () => openCategoryDialog(null) }, 'Neue Kategorie oder Einnahmequelle'),
    ...sorted.map(c => {
      const sub = (c.kind === 'income' ? 'Einnahmequelle' : 'Ausgabenkategorie') +
        (c.budget ? ` · Budget ${money(c.budget)}` : '');
      const node = el('div', { class: 'row compact tap' },
        dot(c),
        el('div', { class: 'grow' },
          el('div', { class: 'row-title' }, c.name),
          el('div', { class: 'muted small' }, sub)),
        el('button', {
          class: 'icon', 'aria-label': 'Kategorie löschen',
          onclick: ev => {
            ev.stopPropagation();
            if (confirm(`„${c.name}“ löschen? Vorhandene Buchungen verlieren dann den Namen.`)) remove('categories', c.id);
          },
        }, '🗑'));
      node.addEventListener('click', () => { if (!suppressClick) openCategoryDialog(c); });
      return node;
    }),

    el('h3', {}, 'Zuordnungsregeln aus Importen'),
    rules.length
      ? rules.map(r => {
        const target = r.target === 'transfer' ? 'Umbuchung' : (catById(r.target) ? catById(r.target).name : 'gelöschte Kategorie');
        return el('div', { class: 'row compact' },
          el('div', { class: 'grow' },
            el('div', { class: 'row-title' }, `„${r.match}“`),
            el('div', { class: 'muted small' }, `→ ${target}`)),
          el('button', {
            class: 'icon', 'aria-label': 'Regel löschen',
            onclick: () => remove('rules', r.id),
          }, '🗑'));
      })
      : el('p', { class: 'muted small' }, 'Noch keine Regeln. Sie entstehen beim Import, wenn du „merken“ aktiv lässt.'),

    themeSection(),
    syncSection(),

    el('h3', {}, 'Daten sichern'),
    el('p', { class: 'muted small' }, 'Sicherungsdatei zum Speichern oder Wiederherstellen, und eine CSV-Datei für Excel.'),
    el('div', { class: 'row-buttons' },
      el('button', { onclick: exportData }, 'Sicherung'),
      el('button', { onclick: () => restoreInput.click() }, 'Wiederherstellen'),
      el('button', { onclick: exportCsv }, 'CSV')));
}

function themeSection() {
  let current = 'auto';
  try { current = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { /* Standard */ }
  return el('div', {},
    el('h3', {}, 'Darstellung'),
    segControl([['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']], current, v => {
      try { localStorage.setItem(THEME_KEY, v); } catch (e) { /* ignorieren */ }
      applyTheme(v);
    }));
}

function applyTheme(v) {
  if (v === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = v;
}

function syncSection() {
  const urlInput = field({ type: 'url', placeholder: 'https://ausgaben.deine-domain.de', value: sync.url || '' });
  const tokenInput = field({ type: 'password', placeholder: 'Gemeinsamer Schlüssel', value: sync.token || '' });
  return el('div', {},
    el('h3', {}, 'Synchronisation'),
    el('p', { class: 'muted small' }, 'Adresse des Servers und der gemeinsame Schlüssel. Auf beiden Handys gleich eintragen.'),
    urlInput,
    tokenInput,
    el('div', { class: 'row-buttons' },
      el('button', {
        onclick: () => {
          const prevUrl = sync.url;
          sync.url = urlInput.value.trim();
          sync.token = tokenInput.value.trim();
          if (sync.url !== prevUrl) sync.seq = 0;
          saveSync();
          runSync();
        },
      }, 'Speichern und synchronisieren'),
      el('button', {
        onclick: () => {
          sync = {};
          saveSync();
          setStatus('Keine Verbindung eingerichtet');
          render();
        },
      }, 'Trennen')),
    el('p', { id: 'sync-status', class: 'muted small' }, syncMsg));
}

const views = {
  overview: viewOverview,
  history: viewHistory,
  fixed: viewFixed,
  accounts: viewAccounts,
  stats: viewStats,
  settings: viewSettings,
};

function render() {
  const main = document.getElementById('main');
  const node = views[tab]();
  const banner = tab === 'overview' ? reminderNode() : null;
  main.replaceChildren(...(banner ? [banner, node] : [node]));
  document.querySelectorAll('nav button, .gear').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('fab').hidden = !['overview', 'history', 'fixed'].includes(tab);
}

// ---------- Dialoge ----------

/** Umschalter Ausgabe / Einnahme. */
function kindToggle(initial, onChange) {
  let value = initial;
  const expBtn = el('button', { type: 'button', class: 'seg-btn', onclick: () => set('expense') }, 'Ausgabe');
  const incBtn = el('button', { type: 'button', class: 'seg-btn', onclick: () => set('income') }, 'Einnahme');
  function paint() {
    expBtn.classList.toggle('on', value === 'expense');
    incBtn.classList.toggle('on', value === 'income');
  }
  function set(v) {
    value = v;
    paint();
    onChange(v);
  }
  paint();
  return { node: el('div', { class: 'seg' }, expBtn, incBtn) };
}

/** Farbauswahl aus der Palette. */
function swatches(initial, onChange) {
  let value = initial;
  const node = el('div', { class: 'swatches' });
  function paint() {
    node.replaceChildren(...COLORS.map(c => el('button', {
      type: 'button',
      class: 'swatch' + (c === value ? ' on' : ''),
      style: { background: c },
      'aria-label': c,
      onclick: () => { value = c; paint(); onChange(c); },
    })));
  }
  paint();
  return { node };
}

/** Buchung anlegen oder bearbeiten. existing = { table: 'entries'|'recurring', rec } oder null. */
function openEntryDialog(existing, presetFixed) {
  const isEdit = !!existing;
  const table = existing ? existing.table : 'entries';
  const rec = existing ? existing.rec : null;
  let kind = rec ? rec.kind : 'expense';
  let categoryId = rec ? rec.categoryId : null;
  let fixed = table === 'recurring' || !!presetFixed;
  let method = rec && rec.method ? rec.method : (kind === 'income' ? 'transfer' : 'card');

  const amountInput = field({ type: 'text', inputmode: 'decimal', placeholder: '0,00', value: rec ? centsToInput(rec.amount) : '' });
  const noteInput = field({ type: 'text', placeholder: 'Notiz (optional)', value: rec ? (rec.note || '') : '' });
  const dateInput = field({ type: 'date', value: rec && table === 'entries' ? rec.date : dateIn(currentYm, todayDay()) });
  const startInput = field({ type: 'month', value: rec && table === 'recurring' ? rec.startYm : currentYm });
  const endInput = field({ type: 'month', value: rec && rec.endYm ? rec.endYm : '' });
  const chips = el('div', { class: 'chips' });
  const methodBox = el('div', {});
  const fixedBox = el('input', { type: 'checkbox' });
  const saveBtn = el('button', { type: 'button', class: 'primary' }, 'Speichern');

  function drawChips() {
    chips.replaceChildren(...live('categories')
      .filter(c => c.kind === kind)
      .map(c => {
        const on = categoryId === c.id;
        return el('button', {
          type: 'button',
          class: 'chip' + (on ? ' on' : ''),
          style: on
            ? { background: c.color, borderColor: c.color, color: '#fff' }
            : { borderColor: c.color },
          onclick: () => { categoryId = c.id; drawChips(); validate(); },
        }, c.name);
      }));
  }

  function drawMethod() {
    const options = kind === 'income'
      ? [['transfer', 'Überweisung'], ['cash', 'Bar']]
      : [['card', 'Karte'], ['cash', 'Bar']];
    if (!options.some(o => o[0] === method)) method = options[0][0];
    methodBox.replaceChildren(
      el('div', { class: 'label' }, kind === 'income' ? 'Eingang über' : 'Bezahlt mit'),
      segControl(options, method, v => { method = v; }));
  }

  function validate() {
    const useFixed = table === 'recurring' || fixed;
    const ok = parseCents(amountInput.value) > 0 && categoryId !== null && (!useFixed || startInput.value);
    saveBtn.disabled = !ok;
  }

  const toggle = kindToggle(kind, v => {
    kind = v;
    categoryId = null;
    drawChips();
    drawMethod();
    validate();
  });

  const dateRow = el('div', {}, el('div', { class: 'label' }, 'Datum'), dateInput);
  const fixedRows = el('div', {},
    el('div', { class: 'label' }, 'Startmonat'), startInput,
    el('div', { class: 'label' }, 'Letzter Monat (leer = unbegrenzt)'), endInput);
  const fixedCheck = el('label', { class: 'check' }, fixedBox, ' Fixkosten (jeden Monat automatisch)');

  function paintMode() {
    const f = table === 'recurring' || fixed;
    dateRow.hidden = f;
    fixedRows.hidden = !f;
    fixedCheck.hidden = isEdit;
  }

  fixedBox.checked = fixed;
  fixedBox.addEventListener('change', () => { fixed = fixedBox.checked; paintMode(); validate(); });
  amountInput.addEventListener('input', validate);
  startInput.addEventListener('input', validate);

  saveBtn.addEventListener('click', () => {
    const cents = parseCents(amountInput.value);
    const note = noteInput.value.trim();
    const useFixed = table === 'recurring' || fixed;
    dlg.close();
    if (useFixed) {
      const data = {
        kind,
        amount: cents,
        categoryId,
        method,
        day: isEdit ? rec.day : (Number(dateInput.value.slice(8, 10)) || todayDay()),
        startYm: startInput.value,
        endYm: endInput.value || null,
        note,
      };
      if (isEdit) update('recurring', rec.id, data);
      else add('recurring', data);
    } else {
      const data = {
        kind,
        amount: cents,
        categoryId,
        method,
        date: dateInput.value || dateIn(currentYm, todayDay()),
        note,
      };
      if (isEdit) update('entries', rec.id, data);
      else add('entries', data);
    }
  });

  const dlg = el('dialog', { class: 'sheet' },
    el('h2', {}, isEdit ? 'Eintrag bearbeiten' : 'Neuer Eintrag'),
    toggle.node,
    el('div', { class: 'label' }, 'Betrag in €'),
    amountInput,
    el('div', { class: 'label' }, 'Kategorie oder Einnahmequelle'),
    chips,
    methodBox,
    el('div', { class: 'label' }, 'Notiz'),
    noteInput,
    dateRow,
    fixedRows,
    fixedCheck,
    el('div', { class: 'actions' },
      el('button', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      saveBtn));

  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  paintMode();
  drawChips();
  drawMethod();
  validate();
  dlg.showModal();
  amountInput.focus();
}

/** Kategorie anlegen oder bearbeiten (cat = bestehende Kategorie oder null). */
function openCategoryDialog(cat) {
  const isEdit = !!cat;
  let kind = cat ? cat.kind : 'expense';
  let color = cat ? cat.color : COLORS[0];

  const nameInput = field({ type: 'text', placeholder: 'Name', value: cat ? cat.name : '' });
  const budgetInput = field({ type: 'text', inputmode: 'decimal', placeholder: 'Monatsbudget in € (optional)', value: cat && cat.budget ? centsToInput(cat.budget) : '' });
  const budgetRow = el('div', {}, el('div', { class: 'label' }, 'Monatsbudget'), budgetInput);
  const preview = el('div', { class: 'cat-preview' });
  const saveBtn = el('button', { type: 'button', class: 'primary' }, 'Speichern');

  function paintPreview() {
    preview.replaceChildren(
      el('span', { class: 'dot big-dot', style: { background: color } }),
      el('span', {}, nameInput.value.trim() || 'Vorschau'));
  }

  const toggle = kindToggle(kind, v => {
    kind = v;
    budgetRow.hidden = v === 'income';
  });
  const sw = swatches(color, c => { color = c; paintPreview(); });

  function validate() {
    saveBtn.disabled = nameInput.value.trim() === '';
    paintPreview();
  }
  nameInput.addEventListener('input', validate);
  saveBtn.addEventListener('click', () => {
    const b = parseCents(budgetInput.value);
    const fields = {
      name: nameInput.value.trim(),
      kind,
      color,
      budget: kind === 'expense' && b > 0 ? b : null,
    };
    dlg.close();
    if (isEdit) update('categories', cat.id, fields);
    else add('categories', fields);
  });

  const dlg = el('dialog', { class: 'sheet' },
    el('h2', {}, isEdit ? 'Kategorie bearbeiten' : 'Neue Kategorie'),
    toggle.node,
    nameInput,
    budgetRow,
    el('div', { class: 'label' }, 'Farbe'),
    sw.node,
    preview,
    el('div', { class: 'actions' },
      el('button', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      saveBtn));

  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  budgetRow.hidden = kind === 'income';
  validate();
  dlg.showModal();
  nameInput.focus();
}

// ---------- Kontoauszug importieren ----------

/** Zerlegt eine CSV-Zeile mit Semikolon und Anführungszeichen. */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ';' && !quoted) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const squash = s => String(s || '').replace(/\s+/g, ' ').trim();

/** „30.01.26“ oder „30.01.2026“ wird zu „2026-01-30“. */
function deDate(s) {
  const parts = squash(s).split('.');
  const y = parts[2].length === 2 ? '20' + parts[2] : parts[2];
  return `${y}-${pad(Number(parts[1]))}-${pad(Number(parts[0]))}`;
}

/** „-1.542,8“ wird zu -154280 Cent. */
function germanCents(s) {
  const n = Number(String(s).replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Liest den DKB-Export: Kopfzeilen, Tabellenkopf, dann die Buchungen. */
function parseDkb(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let iban = null;
  let periodYm = null;
  let balance = null;
  let headerIdx = -1;

  lines.forEach((line, i) => {
    if (headerIdx >= 0) return;
    const c = splitCsv(line);
    if (c[0] === 'Buchungsdatum') headerIdx = i;
    else if (!iban && c[1] && /^[A-Z]{2}\d{2}[A-Z0-9]{10,}$/.test(c[1].trim())) iban = c[1].trim();
    else if (c[0].startsWith('Zeitraum')) {
      const m = c[1] ? c[1].match(/(\d{2}\.\d{2}\.\d{4})/) : null;
      if (m) periodYm = deDate(m[1]).slice(0, 7);
    } else if (c[0].startsWith('Kontostand vom')) {
      const m = c[0].match(/(\d{2}\.\d{2}\.\d{4})/);
      if (m) {
        // Kontostand am Monatsanfang = Monatsende des Vormonats
        const d = deDate(m[1]);
        const ym = d.endsWith('-01') ? addMonths(d.slice(0, 7), -1) : d.slice(0, 7);
        balance = { ym, cents: germanCents(c[1]) };
      }
    }
  });

  if (headerIdx < 0) throw new Error('Kein Tabellenkopf „Buchungsdatum“ gefunden.');
  if (!iban) throw new Error('Keine IBAN gefunden.');

  const rows = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const c = splitCsv(line);
    if (c.length < 9 || !c[0].trim()) continue;
    const cents = germanCents(c[8]);
    rows.push({
      date: deDate(c[0]),
      status: squash(c[2]),
      partner: squash(cents < 0 ? c[4] : c[3]),
      text: squash(c[5]),
      cents,
      counterIban: squash(c[7]).replace(/\s/g, ''),
    });
  }
  return { iban, periodYm, balance, rows };
}

/** Kreditrate im Verwendungszweck: Saldo, Tilgung, Zinsen und Zeitraum. */
function parseLoan(text) {
  const grab = re => {
    const x = text.match(re);
    return x ? Math.round(Number(x[1].replace(/\./g, '').replace(',', '.')) * 100) : null;
  };
  const saldo = grab(/Saldo:\s*([\d.]+,\d+)/);
  const tilg = grab(/Tilg\.:\s*([\d.]+,\d+)/);
  const zins = grab(/Zins\/Entg:\s*([\d.]+,\d+)/);
  if (saldo === null || tilg === null || zins === null) return null;
  const start = text.match(/(\d{2}\.\d{2}\.\d{4})/);
  if (!start) return null;
  return { saldo, tilg, zins, periodYm: deDate(start[1]).slice(0, 7) };
}

const groupKeyOf = r => (r.partner || r.text).toLowerCase();

function openImportReview(parsed, fileName, raw) {
  const ownIbans = new Set(live('accounts').map(a => a.iban).filter(Boolean));
  ownIbans.add(parsed.iban);
  const existingKeys = new Set(live('entries').map(e => e.importKey).filter(Boolean));
  // Manuell erfasste Buchungen (ohne importKey), die noch keinem Umsatz zugeordnet sind
  const manualFree = live('entries').filter(e => !e.importKey);
  const claimed = new Set();

  const items = [];
  let already = 0;
  for (const r of parsed.rows) {
    const key = [r.date, r.cents, r.counterIban, r.text].join('|');
    if (existingKeys.has(key)) { already++; continue; }

    const match = manualFree.find(e => !claimed.has(e.id) && e.date === r.date && e.amount === Math.abs(r.cents));
    if (match) { claimed.add(match.id); items.push({ r, key, type: 'linked', entry: match }); already++; continue; }

    const loan = r.text.includes('Tilg.:') ? parseLoan(r.text) : null;
    if (loan) { items.push({ r, key, type: 'loan', loan }); continue; }

    if (r.counterIban && ownIbans.has(r.counterIban)) { items.push({ r, key, type: 'transfer' }); continue; }

    const hay = (r.partner + ' ' + r.text).toLowerCase();
    const rule = live('rules').find(x => hay.includes(x.match));
    if (rule) {
      items.push({ r, key, type: rule.target === 'transfer' ? 'transfer' : 'auto', target: rule.target });
      continue;
    }
    items.push({ r, key, type: 'open' });
  }

  // Unbekannte Empfänger zusammenfassen, jeder Empfänger wird einmal gefragt
  const groups = new Map();
  for (const it of items.filter(i => i.type === 'open')) {
    const gk = groupKeyOf(it.r);
    if (!groups.has(gk)) {
      groups.set(gk, { key: gk, label: it.r.partner || it.r.text, count: 0, cents: 0, expense: it.r.cents < 0, decision: '' });
    }
    const g = groups.get(gk);
    g.count++;
    g.cents += it.r.cents;
  }

  const count = t => items.filter(i => i.type === t).length;
  const summary = el('p', { class: 'muted small' },
    `${count('auto')} automatisch zugeordnet · ${count('transfer')} Umbuchungen · ${count('loan')} Kredit-Raten · ${count('linked')} schon manuell erfasst (verknüpft) · ${already - count('linked')} schon importiert`);

  const groupRows = [...groups.values()].map(g => {
    const sel = el('select', { class: 'input', ...LOCK },
      el('option', { value: '' }, '— bitte wählen —'),
      el('option', { value: 'transfer' }, 'Umbuchung zwischen eigenen Konten'),
      el('option', { value: 'skip' }, 'Überspringen'),
      ...live('categories')
        .filter(c => c.kind === (g.expense ? 'expense' : 'income'))
        .sort((a, b) => a.name.localeCompare(b.name, 'de'))
        .map(c => el('option', { value: c.id }, c.name)));
    sel.addEventListener('change', () => { g.decision = sel.value; validate(); });
    return el('div', { class: 'row compact' },
      el('div', { class: 'grow' },
        el('div', { class: 'row-title' }, g.label),
        el('div', { class: 'muted small' }, `${g.count}× · ${money(g.cents)}`)),
      sel);
  });

  const remember = el('input', { type: 'checkbox', checked: true });
  const saveBtn = el('button', { type: 'button', class: 'primary' }, 'Übernehmen');

  function validate() {
    saveBtn.disabled = [...groups.values()].some(g => g.decision === '');
  }

  saveBtn.addEventListener('click', () => {
    dlg.close();
    commitImport({ parsed, fileName, raw, items, groups, remember: remember.checked });
  });

  const dlg = el('dialog', { class: 'sheet wide' },
    el('h2', {}, 'Kontoauszug prüfen'),
    el('p', { class: 'muted small' }, `${fileName} · Konto ····${parsed.iban.slice(-4)}`),
    summary,
    groups.size ? el('div', { class: 'label' }, 'Diese Empfänger sind neu. Wohin sollen sie?') : null,
    ...groupRows,
    groups.size ? el('label', { class: 'check' }, remember, ' Zuordnung für künftige Importe merken') : null,
    el('div', { class: 'actions' },
      el('button', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      saveBtn));

  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  validate();
  dlg.showModal();
}

function commitImport(ctx) {
  const { parsed, fileName, raw, items, groups, remember } = ctx;

  let account = live('accounts').find(a => a.iban === parsed.iban);
  if (!account) {
    account = { id: uid(), name: 'DKB Girokonto', type: 'giro', iban: parsed.iban, deleted: false, updatedAt: Date.now(), _dirty: true };
    state.accounts.push(account);
  }

  let kredit = live('categories').find(c => c.name === 'Kredit' && c.kind === 'expense');
  if (!kredit && items.some(i => i.type === 'loan')) {
    kredit = { id: uid(), name: 'Kredit', kind: 'expense', color: '#8D6E63', budget: null, deleted: false, updatedAt: Date.now(), _dirty: true };
    state.categories.push(kredit);
  }

  let created = 0;
  let transfers = 0;
  for (const it of items) {
    const r = it.r;
    if (it.type === 'linked') {
      // Manuelle Buchung wird mit dem Umsatz verknüpft, damit sie nicht doppelt entsteht
      it.entry.importKey = it.key;
      it.entry._dirty = true;
      it.entry.updatedAt = Date.now();
      continue;
    }
    let kind;
    let categoryId = null;
    let note = r.text.slice(0, 120);
    let ym = null;
    const method = r.text.startsWith('VISA') ? 'card' : 'transfer';

    if (it.type === 'loan') {
      kind = 'expense';
      categoryId = kredit.id;
      ym = it.loan.periodYm;
      note = 'Rate Immobilienkredit';
    } else if (it.type === 'transfer') {
      kind = 'transfer';
    } else {
      const target = it.type === 'auto' ? it.target : groups.get(groupKeyOf(r)).decision;
      if (target === 'transfer') {
        kind = 'transfer';
      } else {
        if (!target || target === 'skip') continue;
        kind = r.cents < 0 ? 'expense' : 'income';
        categoryId = target;
      }
    }
    if (kind === 'transfer') transfers++;

    const entry = {
      id: uid(),
      kind,
      amount: Math.abs(r.cents),
      categoryId,
      date: r.date,
      note,
      method,
      importKey: it.key,
      deleted: false,
      updatedAt: Date.now(),
      _dirty: true,
    };
    if (ym && ym !== r.date.slice(0, 7)) entry.ym = ym;
    state.entries.push(entry);
    created++;
  }

  for (const it of items.filter(i => i.type === 'loan')) {
    const l = it.loan;
    const exists = live('loans').find(x => x.ym === l.periodYm && x.iban === it.r.counterIban);
    if (!exists) {
      state.loans.push({
        id: uid(), ym: l.periodYm, iban: it.r.counterIban,
        saldo: l.saldo, tilg: l.tilg, zins: l.zins, rate: l.tilg + l.zins,
        deleted: false, updatedAt: Date.now(), _dirty: true,
      });
    }
  }

  if (parsed.balance) {
    const ex = live('balances').find(b => b.accountId === account.id && b.ym === parsed.balance.ym);
    if (ex) {
      ex.amount = parsed.balance.cents;
      ex.updatedAt = Date.now();
      ex._dirty = true;
    } else {
      state.balances.push({
        id: uid(), accountId: account.id, ym: parsed.balance.ym, amount: parsed.balance.cents,
        deleted: false, updatedAt: Date.now(), _dirty: true,
      });
    }
  }

  if (remember) {
    for (const g of groups.values()) {
      if (!g.decision || g.decision === 'skip') continue;
      const match = g.label.toLowerCase();
      if (live('rules').some(x => x.match === match)) continue;
      state.rules.push({
        id: uid(), match, target: g.decision,
        deleted: false, updatedAt: Date.now(), _dirty: true,
      });
    }
  }

  statements.unshift({
    id: uid(), name: fileName, iban: parsed.iban, periodYm: parsed.periodYm,
    count: created, raw, savedAt: Date.now(),
  });
  saveStatements();

  tab = 'accounts';
  persist();
  alert(`${created} Buchungen übernommen, davon ${transfers} Umbuchungen.`);
}

// ---------- Sichern und Wiederherstellen ----------

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportData() {
  downloadBlob(JSON.stringify(state, null, 2), `ausgaben-${todayIso()}.json`, 'application/json');
}

/** CSV mit Semikolon und deutschem Dezimalkomma, damit Excel es direkt öffnet. */
function exportCsv() {
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  const fmt = cents => (cents / 100).toFixed(2).replace('.', ',');
  const catName = id => (catById(id) ? catById(id).name : 'Ohne Kategorie');
  const kindName = k => (k === 'income' ? 'Einnahme' : k === 'transfer' ? 'Umbuchung' : 'Ausgabe');
  const rows = [];

  for (const e of live('entries')) {
    rows.push([e.date, kindName(e.kind), fmt(e.amount), e.kind === 'transfer' ? '' : catName(e.categoryId), e.note || '', 'nein']);
  }
  for (const r of live('recurring')) {
    const last = r.endYm && r.endYm < todayYm() ? r.endYm : todayYm();
    for (const ym of monthsBetween(r.startYm, last)) {
      rows.push([dateIn(ym, r.day), kindName(r.kind), fmt(r.amount), catName(r.categoryId), r.note || '', 'ja']);
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));

  const lines = [['Datum', 'Art', 'Betrag', 'Kategorie', 'Notiz', 'Fixkosten'], ...rows]
    .map(cols => cols.map(q).join(';'));
  downloadBlob('﻿' + lines.join('\r\n'), `ausgaben-${todayIso()}.csv`, 'text/csv;charset=utf-8');
}

async function restoreData(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.categories) || !Array.isArray(data.entries)) throw new Error('ungültig');
    if (!confirm('Die aktuellen Daten werden durch die Sicherung ersetzt. Fortfahren?')) return;
    state = normalize(data, true);
    persist();
  } catch (e) {
    alert('Die Datei passt nicht zur App.');
  }
}

async function importCsv(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const raw = await file.text();
    const parsed = parseDkb(raw);
    openImportReview(parsed, file.name, raw);
  } catch (e) {
    alert('Der Kontoauszug konnte nicht gelesen werden: ' + e.message);
  }
}

const restoreInput = el('input', { type: 'file', accept: 'application/json', hidden: true, onchange: restoreData });
const csvInput = el('input', { type: 'file', accept: '.csv,text/csv', hidden: true, onchange: importCsv });

// ---------- Start ----------

function init() {
  try { applyTheme(localStorage.getItem(THEME_KEY) || 'auto'); } catch (e) { /* Standard */ }

  document.querySelectorAll('nav button, .gear').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    tipText = '';
    render();
    window.scrollTo(0, 0);
  }));
  document.getElementById('fab').addEventListener('click', () => {
    openEntryDialog(null, tab === 'fixed');
  });
  document.body.append(restoreInput, csvInput);
  render();

  window.addEventListener('online', runSync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) runSync(); });
  setInterval(() => { if (!document.hidden) runSync(); }, 60000);
  runSync();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* Offline-Betrieb ist optional */ });
  }
}

init();
