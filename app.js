'use strict';

// ---------- Konstanten ----------

const STORAGE_KEY = 'ausgaben-web-v1';
const SYNC_KEY = 'ausgaben-sync-v1';
const TABLES = ['categories', 'entries', 'recurring'];
const COLORS = ['#66BB6A', '#42A5F5', '#FFA726', '#AB47BC', '#EF5350', '#26C6DA', '#8D6E63', '#78909C', '#FFEE58', '#5C6BC0'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

// ---------- IDs und Datenformat ----------
// Beträge in Cent, Datum "JJJJ-MM-TT", Monat "JJJJ-MM".
// Jeder Datensatz hat eine eindeutige ID, einen Zeitstempel (updatedAt),
// ein deleted-Flag (Löschen per Markierung) und _dirty (noch nicht hochgeladen).

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
  // Feste IDs, damit beide Handys dieselben Startkategorien haben und sie nicht doppelt entstehen.
  return {
    categories: defaults.map(([name, kind, color], i) => ({ id: 'seed-' + (i + 1), name, kind, color })),
    entries: [],
    recurring: [],
  };
}

/** Bringt Daten aus älteren Versionen (numerische IDs) auf das neue Format. */
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
      out[t].push({
        ...r,
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

    // Gesendete Änderungen gelten nur als erledigt, wenn sie sich seitdem nicht verändert haben.
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
const sum = list => list.reduce((s, x) => s + x.cents, 0);

let currentYm = todayYm();
let tab = 'overview';

/** Euro-Eingabe in Cent. Akzeptiert „12,50“ und „12.50“. */
function parseCents(text) {
  let s = String(text).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

/** Alle Buchungen eines Monats. Fixkosten werden für jeden Monat ab Startmonat erzeugt. */
function monthEntries(ym) {
  const tx = live('entries')
    .filter(e => e.date.startsWith(ym))
    .map(e => ({ id: e.id, fixed: false, kind: e.kind, amount: e.amount, categoryId: e.categoryId, note: e.note, date: e.date }));
  const fixed = live('recurring')
    .filter(r => r.startYm <= ym)
    .map(r => ({ id: r.id, fixed: true, kind: r.kind, amount: r.amount, categoryId: r.categoryId, note: r.note, date: dateIn(ym, r.day) }));
  return [...tx, ...fixed].sort((a, b) => b.date.localeCompare(a.date));
}

/** Summen pro Kategorie für Einnahmen oder Ausgaben. */
function segsOf(entries, kind) {
  const totals = new Map();
  entries
    .filter(e => e.kind === kind)
    .forEach(e => totals.set(e.categoryId, (totals.get(e.categoryId) || 0) + e.amount));
  return [...totals]
    .map(([id, cents]) => {
      const c = catById(id);
      return { name: c ? c.name : 'Ohne Kategorie', color: c ? c.color : '#9E9E9E', cents };
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
  const [y, m] = currentYm.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  currentYm = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  render();
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
      el('div', { class: 'rest ' + (rest >= 0 ? 'pos' : 'neg') }, `Übrig: ${money(rest)}`),
      legend('Einnahmen', inc),
      legend('Ausgaben', exp)),
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
  return el('div', { class: 'cat' },
    el('div', { class: 'circle', style: { background: seg.color } }, seg.name.charAt(0).toUpperCase()),
    el('div', { class: 'grow' },
      el('div', { class: 'between' }, el('span', {}, seg.name), el('span', {}, money(seg.cents))),
      el('div', { class: 'progress' }, el('div', { style: { width: pct + '%', background: seg.color } }))));
}

function viewHistory() {
  const entries = monthEntries(currentYm);
  return el('div', {},
    monthNav(),
    entries.length ? null : el('p', { class: 'muted' }, 'Keine Einträge in diesem Monat.'),
    ...entries.map(e => entryRow(e)));
}

function entryRow(e) {
  const cat = catById(e.categoryId);
  const [, m, d] = e.date.split('-');
  const details = [`${d}.${m}.`, e.fixed ? 'Fixkosten' : null, e.note || null].filter(Boolean).join(' · ');
  const inc = e.kind === 'income';
  return el('div', { class: 'row' },
    dot(cat),
    el('div', { class: 'grow' },
      el('div', {}, cat ? cat.name : 'Ohne Kategorie'),
      el('div', { class: 'muted small' }, details)),
    el('div', { class: inc ? 'pos' : 'neg' }, (inc ? '+' : '−') + money(e.amount)),
    e.fixed ? null : el('button', {
      class: 'icon', 'aria-label': 'Löschen',
      onclick: () => { if (confirm('Buchung löschen?')) remove('entries', e.id); },
    }, '🗑'));
}

function viewFixed() {
  return el('div', {},
    el('h2', {}, 'Fixe Buchungen'),
    el('p', { class: 'muted small' },
      'Erscheinen jeden Monat ab dem Startmonat automatisch. Neue Fixkosten legst du mit dem + an und setzt den Haken bei „Fixkosten“.'),
    live('recurring').length ? null : el('p', {}, 'Noch keine Fixkosten angelegt.'),
    ...live('recurring').map(r => {
      const cat = catById(r.categoryId);
      const [y, m] = r.startYm.split('-');
      const inc = r.kind === 'income';
      return el('div', { class: 'row' },
        dot(cat),
        el('div', { class: 'grow' },
          el('div', {}, cat ? cat.name : 'Ohne Kategorie'),
          el('div', { class: 'muted small' },
            `${inc ? 'Einnahme' : 'Ausgabe'} · jeden Monat ab ${m}/${y}` + (r.note ? ` · ${r.note}` : ''))),
        el('div', { class: inc ? 'pos' : 'neg' }, (inc ? '+' : '−') + money(r.amount)),
        el('button', {
          class: 'icon', 'aria-label': 'Fixkosten löschen',
          onclick: () => {
            if (confirm('Diese Fixkosten dauerhaft entfernen?')) remove('recurring', r.id);
          },
        }, '🗑'));
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

function viewCategories() {
  const sorted = [...live('categories')].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'de'));
  return el('div', {},
    el('button', { class: 'primary wide', onclick: openAddCategory }, 'Neue Kategorie oder Einnahmequelle'),
    ...sorted.map(c => el('div', { class: 'row' },
      dot(c),
      el('div', { class: 'grow' },
        el('div', {}, c.name),
        el('div', { class: 'muted small' }, c.kind === 'income' ? 'Einnahmequelle' : 'Ausgabenkategorie')),
      el('button', {
        class: 'icon', 'aria-label': 'Kategorie löschen',
        onclick: () => {
          if (confirm(`„${c.name}“ löschen? Vorhandene Buchungen verlieren dann den Namen.`)) remove('categories', c.id);
        },
      }, '🗑'))),
    syncSection(),
    el('h3', {}, 'Daten sichern'),
    el('p', { class: 'muted small' }, 'Sicherungsdatei zum Speichern oder Wiederherstellen.'),
    el('div', { class: 'row-buttons' },
      el('button', { onclick: exportData }, 'Exportieren'),
      el('button', { onclick: () => importInput.click() }, 'Importieren')));
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

function openAddEntry() {
  let kind = 'expense';
  let categoryId = null;
  let fixed = false;

  const amountInput = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0,00', autocomplete: 'off' });
  const noteInput = el('input', { class: 'input', type: 'text', placeholder: 'Notiz (optional)', autocomplete: 'off' });
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
    saveBtn.disabled = !(parseCents(amountInput.value) > 0 && categoryId !== null);
  }

  const toggle = kindToggle('expense', v => {
    kind = v;
    categoryId = null;
    drawChips();
    validate();
  });

  amountInput.addEventListener('input', validate);
  fixedBox.addEventListener('change', () => { fixed = fixedBox.checked; });

  saveBtn.addEventListener('click', () => {
    const cents = parseCents(amountInput.value);
    const note = noteInput.value.trim();
    dlg.close();
    if (fixed) {
      add('recurring', { kind, amount: cents, categoryId, day: todayDay(), startYm: currentYm, note });
    } else {
      add('entries', { kind, amount: cents, categoryId, date: dateIn(currentYm, todayDay()), note });
    }
  });

  const dlg = el('dialog', { class: 'sheet' },
    el('h2', {}, 'Neuer Eintrag'),
    toggle.node,
    amountInput,
    el('div', { class: 'label' }, 'Kategorie oder Einnahmequelle'),
    chips,
    noteInput,
    el('label', { class: 'check' }, fixedBox, ' Fixkosten (jeden Monat automatisch)'),
    el('div', { class: 'actions' },
      el('button', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      saveBtn));

  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  drawChips();
  validate();
  dlg.showModal();
  amountInput.focus();
}

function openAddCategory() {
  let kind = 'expense';
  let color = COLORS[0];

  const nameInput = el('input', { class: 'input', type: 'text', placeholder: 'Name', autocomplete: 'off' });
  const toggle = kindToggle('expense', v => { kind = v; });
  const sw = swatches(color, c => { color = c; });
  const saveBtn = el('button', { type: 'button', class: 'primary' }, 'Speichern');

  function validate() {
    saveBtn.disabled = nameInput.value.trim() === '';
  }
  nameInput.addEventListener('input', validate);
  saveBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    dlg.close();
    add('categories', { name, kind, color });
  });

  const dlg = el('dialog', { class: 'sheet' },
    el('h2', {}, 'Neue Kategorie'),
    toggle.node,
    nameInput,
    el('div', { class: 'label' }, 'Farbe'),
    sw.node,
    el('div', { class: 'actions' },
      el('button', { type: 'button', onclick: () => dlg.close() }, 'Abbrechen'),
      saveBtn));

  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  validate();
  dlg.showModal();
  nameInput.focus();
}

// ---------- Sichern und Wiederherstellen ----------

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `ausgaben-${todayIso()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    render();
    window.scrollTo(0, 0);
  }));
  document.getElementById('fab').addEventListener('click', openAddEntry);
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
