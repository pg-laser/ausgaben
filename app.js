'use strict';

// ---------- Konstanten ----------

const STORAGE_KEY = 'ausgaben-web-v1';
const SYNC_KEY = 'ausgaben-sync-v1';
const THEME_KEY = 'ausgaben-theme';
const TABLES = ['categories', 'entries', 'recurring'];
const COLORS = ['#66BB6A', '#42A5F5', '#FFA726', '#AB47BC', '#EF5350', '#26C6DA', '#8D6E63', '#78909C', '#FFEE58', '#5C6BC0'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const INCOME_COLOR = '#2E7D32';
const EXPENSE_COLOR = '#E53935';
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

// ---------- IDs und Datenformat ----------
// Beträge in Cent, Datum "JJJJ-MM-TT", Monat "JJJJ-MM".
// Jeder Datensatz: id, updatedAt, deleted (Löschmarkierung), _dirty (noch nicht hochgeladen).

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
  return {
    categories: defaults.map(([name, kind, color], i) => ({ id: 'seed-' + (i + 1), name, kind, color, budget: null })),
    entries: [],
    recurring: [],
  };
}

/** Bringt Daten auf das aktuelle Format (feste IDs für Startkategorien, neue Felder mit Standardwerten). */
function normalize(data, forceDirty) {
  const now = Date.now();
  const catMap = new Map();
  const out = { categories: [], entries: [], recurring: [] };

  for (const t of TABLES) {
    for (const r of (data[t] || [])) {
      const reassigned = !isUid(r.id);
      let id = r.id;
      if (reassigned) {
        const oldNum = Number(r.id);
        id = (t === 'categories' && oldNum >= 1 && oldNum <= 8) ? 'seed-' + oldNum : uid();
        if (t === 'categories') catMap.set(String(r.id), id);
      }
      const extra = t === 'recurring' ? { endYm: r.endYm || null }
        : t === 'categories' ? { budget: r.budget || null }
        : {};
      out[t].push({
        ...r,
        ...extra,
        id,
        deleted: !!r.deleted,
        updatedAt: Number(r.updatedAt) || now,
        _dirty: !!forceDirty || reassigned || r._dirty === true,
      });
    }
  }
  for (const t of ['entries', 'recurring']) {
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
  } catch (e) {
    // Speicher nicht lesbar: mit Startdaten weitermachen
  }
  return normalize(seedData(), true);
}

let state = loadState();

const live = table => state[table].filter(r => !r.deleted);
const catById = id => live('categories').find(c => c.id === id);
const findRec = (table, id) => state[table].find(r => r.id === id);

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

// ---------- Synchronisation ----------

let sync = loadSync();
let syncMsg = sync.url ? 'Nicht synchronisiert' : 'Keine Verbindung eingerichtet';
let syncTimer = null;
let syncing = false;

function loadSync() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveSync() {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
  } catch (e) { /* ignorieren */ }
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

/** Nutzdaten eines Datensatzes ohne interne Felder. */
function payload(r) {
  const { _dirty, id, updatedAt, deleted, ...data } = r;
  return data;
}

/** Übernimmt einen Datensatz vom Server, außer lokal gibt es eine neuere ungesendete Änderung. */
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

function addMonths(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Alle Monate von a bis b (jeweils inklusive). */
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

/** Euro-Eingabe in Cent. Akzeptiert „12,50“ und „12.50“. */
function parseCents(text) {
  let s = String(text).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

/** Alle Buchungen eines Monats. Fixkosten erscheinen für jeden Monat zwischen Start und Ende. */
function monthEntries(ym) {
  const tx = live('entries')
    .filter(e => e.date.startsWith(ym))
    .map(e => ({ id: e.id, fixed: false, kind: e.kind, amount: e.amount, categoryId: e.categoryId, note: e.note, date: e.date }));
  const fixed = live('recurring')
    .filter(r => r.startYm <= ym && (!r.endYm || ym <= r.endYm))
    .map(r => ({ id: r.id, fixed: true, kind: r.kind, amount: r.amount, categoryId: r.categoryId, note: r.note, date: dateIn(ym, r.day) }));
  return [...tx, ...fixed].sort((a, b) => b.date.localeCompare(a.date));
}

/** Summen pro Kategorie für Einnahmen oder Ausgaben, inklusive Budget. */
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

function dot(cat) {
  return el('span', { class: 'dot', style: { background: cat ? cat.color : '#9E9E9E' } });
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

/** Wischen nach links löscht den Eintrag (nach Rückfrage). */
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

/** Zwei Knöpfe nebeneinander, einer ist aktiv. */
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

// ---------- Ansichten ----------

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
      legend('Einnahmen', inc),
      legend('Ausgaben', exp)),
    el('div', { class: 'big' }, money(expT)),
    el('div', { class: 'muted' }, 'Ausgaben in diesem Monat'),
    ...exp.map(s => catRow(s, expT)),
    exp.length ? null : el('p', { class: 'muted' }, 'Noch keine Ausgaben in diesem Monat.'),
    historyChart());
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

/** Balken für die letzten 12 Monate. Tippen auf einen Monat öffnet ihn. */
function historyChart() {
  const months = monthsBetween(addMonths(currentYm, -11), currentYm);
  const data = months.map(ym => {
    const e = monthEntries(ym);
    return { ym, inc: sum(segsOf(e, 'income')), exp: sum(segsOf(e, 'expense')) };
  });
  const max = Math.max(1, ...data.map(d => Math.max(d.inc, d.exp)));
  return el('div', {},
    el('h3', {}, 'Letzte 12 Monate'),
    el('div', { class: 'hist' }, ...data.map(d => el('div', {
      class: 'hist-col' + (d.ym === currentYm ? ' current' : ''),
      title: `${d.ym}: Einnahmen ${money(d.inc)}, Ausgaben ${money(d.exp)}`,
      onclick: () => { currentYm = d.ym; tipText = ''; render(); },
    },
      el('div', { class: 'hist-bars' },
        el('div', { class: 'hbar', style: { height: (d.inc / max * 100) + '%', background: INCOME_COLOR } }),
        el('div', { class: 'hbar', style: { height: (d.exp / max * 100) + '%', background: EXPENSE_COLOR } })),
      el('div', { class: 'hist-label' }, MONTHS[Number(d.ym.slice(5)) - 1].slice(0, 3))))));
}

function viewHistory() {
  const q = el('input', { class: 'input', type: 'search', placeholder: 'Suchen (Notiz oder Kategorie)', autocomplete: 'off' });
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
  const details = [`${d}.${m}.`, e.fixed ? 'Fixkosten' : null, e.note || null].filter(Boolean).join(' · ');
  const inc = e.kind === 'income';
  const table = e.fixed ? 'recurring' : 'entries';
  const node = el('div', { class: 'row tap' },
    dot(cat),
    el('div', { class: 'grow' },
      el('div', {}, cat ? cat.name : 'Ohne Kategorie'),
      el('div', { class: 'muted small' }, details)),
    el('div', { class: inc ? 'pos' : 'neg' }, (inc ? '+' : '−') + money(e.amount)),
    el('button', {
      class: 'icon', 'aria-label': 'Löschen',
      onclick: ev => {
        ev.stopPropagation();
        if (confirm(e.fixed ? 'Diese Fixkosten dauerhaft entfernen?' : 'Buchung löschen?')) remove(table, e.id);
      },
    }, '🗑'));
  node.addEventListener('click', () => {
    if (suppressClick) return;
    const rec = findRec(table, e.id);
    if (rec) openEntryDialog({ table, rec });
  });
  swipeToDelete(node, () => {
    if (confirm(e.fixed ? 'Diese Fixkosten dauerhaft entfernen?' : 'Buchung löschen?')) remove(table, e.id);
  });
  return node;
}

function viewFixed() {
  return el('div', {},
    el('h2', {}, 'Fixe Buchungen'),
    el('p', { class: 'muted small' },
      'Erscheinen jeden Monat automatisch. Tippen zum Bearbeiten, „Letzter Monat“ beendet ein Abo, ohne die alten Monate zu löschen.'),
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
      const node = el('div', { class: 'row tap' },
        dot(cat),
        el('div', { class: 'grow' },
          el('div', {}, cat ? cat.name : 'Ohne Kategorie'),
          el('div', { class: 'muted small' },
            `${inc ? 'Einnahme' : 'Ausgabe'} · jeden Monat ${period}` + (r.note ? ` · ${r.note}` : ''))),
        el('div', { class: inc ? 'pos' : 'neg' }, (inc ? '+' : '−') + money(r.amount)),
        el('button', {
          class: 'icon', 'aria-label': 'Fixkosten löschen',
          onclick: ev => {
            ev.stopPropagation();
            if (confirm('Diese Fixkosten dauerhaft entfernen?')) remove('recurring', r.id);
          },
        }, '🗑'));
      node.addEventListener('click', () => {
        if (suppressClick) return;
        openEntryDialog({ table: 'recurring', rec: r });
      });
      swipeToDelete(node, () => {
        if (confirm('Diese Fixkosten dauerhaft entfernen?')) remove('recurring', r.id);
      });
      return node;
    }));
}

function syncSection() {
  const urlInput = el('input', { class: 'input', type: 'url', placeholder: 'https://ausgaben.deine-domain.de', value: sync.url || '', autocomplete: 'off' });
  const tokenInput = el('input', { class: 'input', type: 'password', placeholder: 'Gemeinsamer Schlüssel', value: sync.token || '', autocomplete: 'off' });
  return el('div', {},
    el('h3', {}, 'Synchronisation'),
    el('p', { class: 'muted small' },
      'Adresse des Servers und der gemeinsame Schlüssel. Auf beiden Handys gleich eintragen.'),
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

function viewCategories() {
  const sorted = [...live('categories')].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'de'));
  return el('div', {},
    el('button', { class: 'primary wide', onclick: () => openCategoryDialog(null) }, 'Neue Kategorie oder Einnahmequelle'),
    ...sorted.map(c => {
      const sub = (c.kind === 'income' ? 'Einnahmequelle' : 'Ausgabenkategorie') +
        (c.budget ? ` · Budget ${money(c.budget)}` : '');
      const node = el('div', { class: 'row tap' },
        dot(c),
        el('div', { class: 'grow' },
          el('div', {}, c.name),
          el('div', { class: 'muted small' }, sub)),
        el('button', {
          class: 'icon', 'aria-label': 'Kategorie löschen',
          onclick: ev => {
            ev.stopPropagation();
            if (confirm(`„${c.name}“ löschen? Vorhandene Buchungen verlieren dann den Namen.`)) remove('categories', c.id);
          },
        }, '🗑'));
      node.addEventListener('click', () => {
        if (!suppressClick) openCategoryDialog(c);
      });
      return node;
    }),
    themeSection(),
    syncSection(),
    el('h3', {}, 'Daten sichern'),
    el('p', { class: 'muted small' }, 'Sicherungsdatei zum Speichern oder Wiederherstellen, und eine CSV-Datei für Excel.'),
    el('div', { class: 'row-buttons' },
      el('button', { onclick: exportData }, 'Sicherung'),
      el('button', { onclick: () => importInput.click() }, 'Wiederherstellen'),
      el('button', { onclick: exportCsv }, 'CSV')));
}

const views = { overview: viewOverview, history: viewHistory, fixed: viewFixed, categories: viewCategories };

function render() {
  document.getElementById('main').replaceChildren(views[tab]());
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('fab').hidden = tab !== 'overview' && tab !== 'history';
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

/** Neue Buchung oder Bearbeiten. existing = { table: 'entries'|'recurring', rec } oder null. */
function openEntryDialog(existing) {
  const isEdit = !!existing;
  const table = existing ? existing.table : 'entries';
  const rec = existing ? existing.rec : null;
  let kind = rec ? rec.kind : 'expense';
  let categoryId = rec ? rec.categoryId : null;
  let fixed = table === 'recurring';

  const amountInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0,00', autocomplete: 'off', value: rec ? centsToInput(rec.amount) : '' });
  const noteInput = el('input', { class: 'input', type: 'text', placeholder: 'Notiz (optional)', autocomplete: 'off', value: rec ? (rec.note || '') : '' });
  const dateInput = el('input', { class: 'input', type: 'date', value: rec && table === 'entries' ? rec.date : dateIn(currentYm, todayDay()) });
  const startInput = el('input', { class: 'input', type: 'month', value: rec && table === 'recurring' ? rec.startYm : currentYm });
  const endInput = el('input', { class: 'input', type: 'month', value: rec && rec.endYm ? rec.endYm : '' });
  const chips = el('div', { class: 'chips' });
  const fixedBox = el('input', { type: 'checkbox' });
  const saveBtn = el('button', { type: 'button', class: 'primary' }, 'Speichern');

  function drawChips() {
    chips.replaceChildren(...live('categories')
      .filter(c => c.kind === kind)
      .map(c => el('button', {
        type: 'button',
        class: 'chip' + (categoryId === c.id ? ' on' : ''),
        onclick: () => { categoryId = c.id; drawChips(); validate(); },
      }, c.name)));
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
    amountInput,
    el('div', { class: 'label' }, 'Kategorie oder Einnahmequelle'),
    chips,
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
  validate();
  dlg.showModal();
  amountInput.focus();
}

/** Neue Kategorie oder Bearbeiten (cat = bestehende Kategorie oder null). */
function openCategoryDialog(cat) {
  const isEdit = !!cat;
  let kind = cat ? cat.kind : 'expense';
  let color = cat ? cat.color : COLORS[0];

  const nameInput = el('input', { class: 'input', type: 'text', placeholder: 'Name', autocomplete: 'off', value: cat ? cat.name : '' });
  const budgetInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: 'Monatsbudget in € (optional)', autocomplete: 'off', value: cat && cat.budget ? centsToInput(cat.budget) : '' });
  const budgetRow = el('div', {}, el('div', { class: 'label' }, 'Monatsbudget'), budgetInput);
  const toggle = kindToggle(kind, v => { kind = v; budgetRow.hidden = v === 'income'; });
  const sw = swatches(color, c => { color = c; });
  const saveBtn = el('button', { type: 'button', class: 'primary' }, 'Speichern');

  function validate() {
    saveBtn.disabled = nameInput.value.trim() === '';
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
  const rows = [];

  for (const e of live('entries')) {
    rows.push([e.date, e.kind === 'income' ? 'Einnahme' : 'Ausgabe', fmt(e.amount), catName(e.categoryId), e.note || '', 'nein']);
  }
  for (const r of live('recurring')) {
    const last = r.endYm && r.endYm < todayYm() ? r.endYm : todayYm();
    for (const ym of monthsBetween(r.startYm, last)) {
      rows.push([dateIn(ym, r.day), r.kind === 'income' ? 'Einnahme' : 'Ausgabe', fmt(r.amount), catName(r.categoryId), r.note || '', 'ja']);
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));

  const lines = [['Datum', 'Art', 'Betrag', 'Kategorie', 'Notiz', 'Fixkosten'], ...rows]
    .map(cols => cols.map(q).join(';'));
  downloadBlob('﻿' + lines.join('\r\n'), `ausgaben-${todayIso()}.csv`, 'text/csv;charset=utf-8');
}

async function importData(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.categories) || !Array.isArray(data.entries) || !Array.isArray(data.recurring)) {
      throw new Error('ungültiges Format');
    }
    if (!confirm('Die aktuellen Daten werden durch die Sicherung ersetzt. Fortfahren?')) return;
    state = normalize(data, true);
    persist();
  } catch (e) {
    alert('Die Datei passt nicht zur App.');
  }
}

const importInput = el('input', { type: 'file', accept: 'application/json', hidden: true, onchange: importData });

// ---------- Start ----------

function init() {
  try { applyTheme(localStorage.getItem(THEME_KEY) || 'auto'); } catch (e) { /* Standard */ }

  document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    tipText = '';
    render();
    window.scrollTo(0, 0);
  }));
  document.getElementById('fab').addEventListener('click', () => openEntryDialog(null));
  document.body.append(importInput);
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
