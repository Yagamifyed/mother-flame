import { APP_NAME, KEYS, REPO, INBOX, CALENDAR, THISWEEK, TASKS, PEOPLE, JOURNAL, HEALTH, QUESTIONS, TODOS, RESEARCH, VOICE_ANSWERS, RULES, ACTIVITY, SECTIONS, HIDDEN } from './config.js?v=1794066801';
import { Vault } from './vault.js?v=1794066801';
import { GitHubBackend, FolderBackend, DeviceBackend } from './backends.js?v=1794066801';
import * as md from './md.js?v=1794066801';
import { renderMarkdown, hydrateImages, renderInline, resolveLink, AUDIO, TAG, noteBlocks, blockToMarkdown } from './render.js?v=1794066801';
import { parseCapture, iso, addDays, dayLabel, longDate, weekday } from './dates.js?v=1794066801';
import { matchAnswers, questionsOf, answerLine } from './answers.js?v=1794066801';

const vault = new Vault();
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v; // a textarea ignores the value attribute
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}

// ---------- settings & ui state ----------
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
let settings = load(KEYS.settings, {});
const ui = load(KEYS.ui, { open: {}, showDone: {} });
const saveUi = () => store(KEYS.ui, ui);
const getPref = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const isDark = () => { const t = getPref(KEYS.theme, 'auto'); return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches); };
function applyTheme() {
  const t = getPref(KEYS.theme, 'auto');
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = isDark();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#151515' : '#f3f3f3'));
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

const stem = (path) => path.split('/').pop().replace(/\.md$/i, '');
// `title:` in the frontmatter shows a list under another name while its file keeps its own (others read it by path)
const title = (path) => md.splitFrontmatter((typeof vault !== 'undefined' && vault.read(path)) || '').data.title || stem(path);
const section = (path) => (path.includes('/') ? path.split('/')[0] : '');
const fileHref = (path) => `#/f/${encodeURIComponent(path)}`;
const update = (path, fn) => { const t = vault.read(path) ?? ''; const n = fn(t); if (n !== t) vault.write(path, n); };
const isMobile = () => matchMedia('(max-width: 760px)').matches;

// ---------- routing ----------
function route() {
  const hsh = decodeURIComponent(location.hash.slice(1) || '/');
  if (hsh.startsWith('/f/')) return { view: 'file', path: hsh.slice(3) };
  if (hsh === '/settings') return { view: 'settings' };
  if (hsh === '/index') return { view: 'today', drawer: true };
  if (hsh === '/new') return { view: 'today', write: true };  // a link that opens the writing sheet (a Mac shortcut can open it)
  if (hsh === '/lab') return { view: 'lab' };
  if (hsh === '/calendar') return { view: 'calendar' };
  if (hsh === '/day') return { view: 'day' };
  if (hsh === '/review') return { view: 'review' };
  if (hsh === '/recent') return { view: 'recent' };
  if (hsh.startsWith('/sort/')) return { view: 'sort', path: hsh.slice(6) };
  if (hsh.startsWith('/people/')) return { view: 'person', name: hsh.slice(8) };
  if (hsh.startsWith('/tag/')) return { view: 'tag', name: hsh.slice(5).toLowerCase() };
  if (hsh === '/starred') return { view: 'starred' };
  return { view: 'today' };
}

// ---------- render loop ----------
let stale = false, query = '';
function editingInMain() {
  const a = document.activeElement;
  return a && $('#main')?.contains(a) && (a.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(a.tagName));
}
function render() {
  tagCache = null;
  renderTabbar();
  document.body.classList.toggle('side-collapsed', !!ui.sideCollapsed);
  if (!$('.drawer-back')) document.body.append(h('div', { class: 'drawer-back', onclick: closeDrawer }));
  renderSide();
  // quick-entry fields (data-keep) survive a redraw; other edits defer it until blur
  const a = document.activeElement;
  const keep = a?.dataset?.keep && $('#main').contains(a) ? { key: a.dataset.keep, value: a.value, pos: a.selectionStart } : null;
  if ((!keep && editingInMain()) || drag) { stale = true; return; }
  stale = false;
  renderMain();
  if (keep) {
    const el = $(`#main [data-keep="${keep.key}"]`);
    if (el) { el.value = keep.value; el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch {} }
  }
}
document.addEventListener('focusout', () => setTimeout(() => { if (stale && !editingInMain()) { stale = false; renderMain(); } }, 0));
let raf = 0;
let filesChanged = false;
// sync status changes (no paths) only touch the sidebar, so taps on the page aren't lost mid-redraw
const scheduleRender = (paths) => {
  if (paths || route().view === 'settings') filesChanged = true;
  // a timer, not requestAnimationFrame: that pauses in background windows and hidden panes
  clearTimeout(raf);
  raf = setTimeout(() => { if (filesChanged) { filesChanged = false; render(); } else renderSide(); }, 16);
};
addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.metaKey && !e.ctrlKey && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
    e.preventDefault();
    if (isMobile()) location.hash = '#/index';
    setTimeout(() => $('.search')?.focus(), 0);
  }
});
const writeFromLink = () => { if (!route().write || !vault.backend) return; history.replaceState(null, '', '#/'); renderMain(); openQuickAdd(); };
addEventListener('hashchange', () => { stale = false; closeDrawer(); if (route().write) return writeFromLink(); if (route().drawer) openDrawer(); followTab(); renderSide(); renderTabbar(); renderMain(); $('#main').scrollTop = 0; scrollTo(0, 0); });

// what waits on Levin: open questions and actions the projects need from him
const labCount = () => [QUESTIONS, TODOS].reduce((n, p) => n + (vault.exists(p) ? md.countOpen(vault.read(p)) : 0), 0);
const labItems = () => [QUESTIONS, TODOS].flatMap((p) => (vault.exists(p) ? md.parseList(vault.read(p)).filter((x) => x.kind === 'item' && x.checkbox && !x.checked).map((x) => x.text) : []));
// the red number: only what arrived since the Lab was last opened
const labNew = () => labItems().filter((t) => !(ui.seenLab || []).includes(t)).length;

// ---------- areas ----------
// a file belongs to the Planner when its frontmatter says `area: planner`
// three areas: Planner (frontmatter `area: planner`), Lists (the other lists) and Collections (notes, trackers)
const area = (path) => (md.splitFrontmatter(vault.read(path) || '').data.area === 'planner' ? 'planner' : section(path) === 'Lists' ? 'lists' : 'collections');
function followTab() {
  const r = route();
  if (r.view === 'file' && vault.exists(r.path)) ui.tab = area(r.path);
  else if (['today', 'lab', 'calendar', 'day', 'review', 'recent', 'tag', 'starred'].includes(r.view)) ui.tab = 'planner';
  else if (r.view === 'person') ui.tab = 'collections';
  saveUi();
}
async function setArea(path, to) {
  const text = vault.read(path) || '';
  await vault.write(path, md.setFrontmatterKey(text, 'area', to === 'planner' ? 'planner' : null));
  ui.tab = area(path); saveUi(); renderSide(); renderMain();
}

// ---------- sidebar ----------
function sortKey(path) {
  const o = Number(md.splitFrontmatter(vault.read(path) || '').data.order);
  return [Number.isFinite(o) ? o : 1e9, title(path).toLowerCase()];
}
const byOrder = (a, b) => { const [x, y] = [sortKey(a), sortKey(b)]; return x[0] - y[0] || x[1].localeCompare(y[1], undefined, { numeric: true }); };

function tree() {
  const root = { dirs: {}, files: [] };
  for (const f of vault.list()) {
    if (!/\.md$/i.test(f.path) || f.path === INBOX) continue;
    const parts = f.path.split('/');
    if (HIDDEN.includes(parts[0])) continue;
    let node = root;
    for (const p of parts.slice(0, -1)) node = node.dirs[p] ||= { dirs: {}, files: [] };
    node.files.push(f.path);
  }
  return root;
}

function badge(path) {
  const t = vault.read(path) || '';
  const type = md.fileType(path, t);
  if (type === 'list') { const n = md.countOpen(t); return n || ''; }
  return '';
}

// ---------- touch: swipe from the left edge to go back; swipe rows for quick actions ----------
// a row follows the finger; past 80px the action runs: `left` for a swipe to the left, `right` for one to the right
// `hold`: pressing a row for half a second (e.g. to start selecting).
// `lift`: pressing it lifts it instead, to drag it somewhere else ({ start, move, end }); let go without moving = `hold`
function swipe(el, { left = null, right = null, hold = null, lift = null } = {}) {
  if (!left && !right && !hold && !lift) return el;
  el.classList.add('swipe-row');
  let x0 = 0, y0 = 0, dx = 0, on = false, decided = false, timer = null, lifted = false;
  const noClick = () => el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); }, { capture: true, once: true });
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (t.clientX < 44) return;  // the left edge opens the sidebar
    x0 = t.clientX; y0 = t.clientY; dx = 0; on = true; decided = false; lifted = false;
    clearTimeout(timer);
    if (lift) timer = setTimeout(() => { if (on && !decided) { on = false; lifted = true; navigator.vibrate?.(10); lift.start(x0, y0); } }, 350);
    else if (hold) timer = setTimeout(() => { if (on && !decided) { on = false; noClick(); navigator.vibrate?.(10); hold.run(); } }, 500);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (lifted) { e.preventDefault(); lift.move(e.touches[0].clientX, e.touches[0].clientY); return; }  // dragging: the page doesn't scroll
    if (!on) return;
    const t = e.touches[0], mx = t.clientX - x0, my = t.clientY - y0;
    if (!decided) { if (Math.abs(mx) < 10 && Math.abs(my) < 10) return; decided = true; clearTimeout(timer); if (Math.abs(my) > Math.abs(mx)) { on = false; return; } }
    if ((mx < 0 && !left) || (mx > 0 && !right)) return;
    dx = mx;
    el.classList.add('swiping');
    el.style.transform = `translateX(${dx}px)`;
    el.dataset.swipe = dx < 0 ? left.label : right.label;
    el.classList.toggle('swipe-left', dx < 0);
    el.classList.toggle('swipe-ready', Math.abs(dx) > 80);
  }, { passive: false });
  el.addEventListener('touchcancel', () => {
    clearTimeout(timer); on = false; el.classList.remove('swiping', 'swipe-ready'); el.style.transform = '';
    if (lifted) { lifted = false; lift.end(true); }
  });
  el.addEventListener('touchend', () => {
    clearTimeout(timer);
    if (lifted) { lifted = false; noClick(); if (!lift.end()) hold?.run(); return; }
    if (!on) return;
    on = false;
    const act = dx < -80 ? left : dx > 80 ? right : null;
    el.classList.remove('swiping', 'swipe-ready');
    el.style.transform = '';
    if (Math.abs(dx) > 10) noClick();
    if (act) act.run();
  });
  return el;
}

// ---------- dragging tasks, as in Google Tasks: up and down to reorder, sideways to make it a sub-task (or not) ----------
const STEP = 28;  // one level of indent, in pixels (as the list draws sub-tasks)
let drag = null;
function liftRow(path, it, itemEl, x, y) {
  const list = itemEl.closest('.list'), row = itemEl.querySelector('.item-row');
  // the places it can go: between the other open rows (not inside itself)
  const rows = [...list.querySelectorAll('.item[data-depth]')].filter((r) => r !== itemEl && !itemEl.contains(r) && !r.closest('.completed'));
  const b = row.getBoundingClientRect();
  const ghost = row.cloneNode(true);
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px' });
  const line = h('div', { class: 'drop-line' });
  document.body.append(ghost, line);
  document.body.classList.add('dragging');
  document.activeElement?.blur?.();
  itemEl.classList.add('drag-src');
  const depth0 = +itemEl.dataset.depth;
  drag = { path, it, itemEl, rows, ghost, line, x0: x, y0: y, depth0, base: b.left - depth0 * STEP, right: b.right, slot: null, moved: false };
  moveDrag(x, y);
}
function moveDrag(x, y) {
  const d = drag; if (!d) return;
  if (Math.abs(y - d.y0) > 6 || Math.abs(x - d.x0) > 12) d.moved = true;
  d.ghost.style.transform = `translate(${x - d.x0}px, ${y - d.y0}px)`;
  const box = (r) => r.querySelector('.item-row').getBoundingClientRect();
  let i = d.rows.findIndex((r) => { const b = box(r); return b.top + b.height / 2 > y; });
  if (i < 0) i = d.rows.length;
  const above = d.rows[i - 1], below = d.rows[i], dep = (r) => +r.dataset.depth;
  const max = above ? dep(above) + 1 : 0, min = below ? dep(below) : 0;
  const depth = Math.max(min, Math.min(max, d.depth0 + Math.round((x - d.x0) / STEP)));
  d.slot = { above, below, depth };
  const top = below ? box(below).top : above ? box(above).bottom : box(d.itemEl).top;
  Object.assign(d.line.style, { top: top - 1 + 'px', left: d.base + depth * STEP + 'px', width: Math.max(40, d.right - d.base - depth * STEP) + 'px' });
  // near the top or bottom of the screen the page scrolls along
  const edge = y < 90 ? -10 : y > innerHeight - 150 ? 10 : 0;
  if (edge) { scrollBy(0, edge); $('#main').scrollTop += edge; }
}
function endDrag(cancel = false) {
  const d = drag; drag = null;
  if (!d) return false;
  d.ghost.remove(); d.line.remove(); d.itemEl.classList.remove('drag-src'); document.body.classList.remove('dragging');
  if (cancel || !d.moved || !d.slot) { if (stale) { stale = false; renderMain(); } return false; }
  const { above, below, depth } = d.slot;
  // exactly where the line showed it: right before the row below when it sits at that depth, else at the end of the row above
  const to = below && +below.dataset.depth === depth ? { before: below._it, depth }
    : above ? { after: above._it, depth } : { before: below?._it || null, depth };
  withUndo('Moved', [d.path], () => update(d.path, (t) => md.dropItem(t, d.it, to)));
  return true;
}
// on the Mac: a grip beside each task (shown on hover) drags it with the mouse
function dragGrip(start) {
  return h('span', { class: 'grip', 'aria-hidden': 'true', title: 'Drag to move; sideways for a sub-task', onmousedown: (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    start(e.clientX, e.clientY);
    const mv = (ev) => moveDrag(ev.clientX, ev.clientY);
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); endDrag(); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  } });
}

// a list item moved to another list or note, with its sub-items and notes
function moveTo(from, it, target) {
  const src = vault.read(from) || '';
  const f = md.findItem(src, it); if (!f || !target || target === from) return;
  const block = md.extractBlock(src, f);
  const isList = md.fileType(target, vault.read(target) || '') === 'list';
  update(target, (t) => md.insertBlock(t, block, { top: isList }));
  update(from, (t) => { const g = md.findItem(t, it); return g ? md.deleteItem(t, g) : t; });
  noteRecent(target);
}
// a sheet from the bottom: where should this go?
function openMoveSheet(from, it, many = null) {
  const files = vault.list().map((f) => f.path).filter((p) => /\.md$/i.test(p) && ['Lists', 'Notes'].includes(section(p)) && p !== from && p !== QUESTIONS);
  const recent = (ui.recent || []).filter((p) => files.includes(p));
  const groups = [
    ['Recent', recent],
    ['Planner', files.filter((p) => area(p) === 'planner')],
    ...[...new Set(files.filter((p) => area(p) === 'lists').map((p) => md.splitFrontmatter(vault.read(p) || '').data.folder || 'Lists'))].sort()
      .map((g) => [g, files.filter((p) => area(p) === 'lists' && (md.splitFrontmatter(vault.read(p) || '').data.folder || 'Lists') === g)]),
    ['Notes', files.filter((p) => section(p) === 'Notes')],
  ].filter(([, ps]) => ps.length);
  const close = () => back.remove();
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'File into' },
      h('div', { class: 'sheet-head' }, h('span', { class: 'label' }, 'File into'), h('button', { class: 'quiet', 'aria-label': 'Close', onclick: close }, '×')),
      h('p', { class: 'meta sheet-what' }, many ? `${many.length} items` : it.text.replace(/!\[\[[^\]]+\]\]/g, '').slice(0, 90)),
      groups.map(([g, ps]) => h('div', { class: 'sheet-group' }, h('div', { class: 'label' }, g.replace(/\//g, ' › ')),
        (g === 'Recent' ? ps : [...ps].sort(byOrder)).map((p) => h('button', { class: 'sheet-item', onclick: () => { close(); withUndo(`Filed in ${title(p)}`, [from, p], () => { for (const x of many || [it]) moveTo(from, x, p); if (many) { ui.selected = {}; renderMain(); } }); } }, title(p)))))));
  document.body.append(back);
}

// the iPhone keyboard covers the bottom of the screen without moving it: sheets sit on top of the keyboard (--kb)
visualViewport?.addEventListener('resize', () => {
  const kb = Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop);
  document.documentElement.style.setProperty('--kb', kb > 80 ? kb + 'px' : '0px');
});

// ---------- the sidebar as a drawer: on the phone always, on the Mac when tucked away ----------
const drawerMode = () => isMobile() || !!ui.sideCollapsed;
const openDrawer = () => { if (drawerMode()) { document.body.classList.add('drawer-open'); renderTabbar(); $('#side .nav-item.active')?.scrollIntoView({ block: 'nearest' }); } };
const closeDrawer = () => { document.body.classList.remove('drawer-open'); if ($('.tabbar')) renderTabbar(); };
document.addEventListener('click', (e) => { if (e.target.closest?.('#side a')) closeDrawer(); });
function setCollapsed(on) { ui.sideCollapsed = on; saveUi(); closeDrawer(); document.body.classList.toggle('side-collapsed', on); }
// swipe in from the left edge to open it; swipe it back to the left (or tap beside it) to close it.
// On the phone it is a sheet from the bottom: swipe sideways on it to change tab, swipe it down to close it.
(() => {
  let x0 = null, y0 = 0, closing = false, sheet = false, mode = null;
  const free = (el) => !el.closest?.('.swipe-row, .pad-canvas, input, textarea, select, .table-wrap, .week-grid, .quick-chips, .sheet, [contenteditable]');
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0], open = document.body.classList.contains('drawer-open');
    closing = open; sheet = isMobile(); mode = null;
    if (open && sheet && (!e.target.closest?.('#side') || e.target.closest('input'))) { x0 = null; return; }  // beside it: a tap closes it
    x0 = open || (drawerMode() && (t.clientX < 44 || free(e.target))) ? t.clientX : null; y0 = t.clientY;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (x0 === null) return;
    const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0, side = $('#side');
    if (!mode) { if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return; mode = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'; }
    if (sheet) {
      if (!closing || mode !== 'y') return;  // opening rises on release; a sideways swipe changes tab on release
      if (dy > 0 && (!e.target.closest('.nav') || $('#side .nav').scrollTop <= 0)) { side.style.transition = 'none'; side.style.transform = `translateY(${dy}px)`; }
      else { mode = 'scroll'; side.style.transform = ''; }
      return;
    }
    if (mode === 'y') return;  // a scroll, not a swipe
    side.style.transition = 'none';
    side.style.transform = closing ? `translateX(${Math.min(0, dx)}px)` : `translateX(${Math.min(0, dx - side.offsetWidth)}px)`;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0, side = $('#side');
    side.style.transition = ''; side.style.transform = '';
    x0 = null;
    if (sheet && closing) {
      if (mode === 'x' && Math.abs(dx) > 50 && Math.abs(dy) < 70) {
        const i = TABS.findIndex(([k]) => k === ui.tab), j = Math.max(0, i) + (dx < 0 ? 1 : -1);
        if (TABS[j]) showTab(TABS[j][0], dx < 0 ? 1 : -1);
      }
      if (mode === 'y' && dy > 80) closeDrawer();
      return;
    }
    if (!closing && mode === 'x' && dx > 60 && Math.abs(dy) < Math.max(80, dx * 0.6)) openDrawer();
    if (closing && mode === 'x' && dx < -60 && Math.abs(dy) < 80) closeDrawer();
  });
})();

// the write button's icon: the pixel flame (Levin's pick, 7 Nov 2026)
const writeIcon = () => h('span', { class: 'tb-flame', 'aria-hidden': 'true', html: '<svg viewBox="0 1 12 11" width="100%" height="100%" shape-rendering="crispEdges"><path fill="currentColor" d="M5 2h1v1h-1zM6 2h1v1h-1zM5 3h1v1h-1zM6 3h1v1h-1zM5 4h1v1h-1zM6 4h1v1h-1zM7 4h1v1h-1zM9 4h1v1h-1zM3 5h1v1h-1zM4 5h1v1h-1zM5 5h1v1h-1zM7 5h1v1h-1zM8 5h1v1h-1zM9 5h1v1h-1zM3 6h1v1h-1zM4 6h1v1h-1zM7 6h1v1h-1zM8 6h1v1h-1zM9 6h1v1h-1zM2 7h1v1h-1zM3 7h1v1h-1zM8 7h1v1h-1zM9 7h1v1h-1zM3 8h1v1h-1zM8 8h1v1h-1zM9 8h1v1h-1zM3 9h1v1h-1zM4 9h1v1h-1zM7 9h1v1h-1zM8 9h1v1h-1zM4 10h1v1h-1zM5 10h1v1h-1zM6 10h1v1h-1zM7 10h1v1h-1z"/><path fill="currentColor" opacity=".55" d="M6 5h1v1h-1zM5 6h1v1h-1zM6 6h1v1h-1zM4 7h1v1h-1zM5 7h1v1h-1zM6 7h1v1h-1zM7 7h1v1h-1zM4 8h1v1h-1zM5 8h1v1h-1zM6 8h1v1h-1zM7 8h1v1h-1zM5 9h1v1h-1zM6 9h1v1h-1z"/></svg>' });

// ---------- phone: a tab bar at the bottom (Filer, Today, +, Week, More) ----------
function renderTabbar() {
  let bar = $('.tabbar');
  if (!vault.backend) { bar?.remove(); $('.fab')?.remove(); return; }
  // on the Mac (no tab bar) the same button floats in the corner
  if (!$('.fab')) document.body.append(h('button', { class: 'fab', 'aria-label': 'Write something down (N)', title: 'Write something down (N)', onclick: () => openQuickAdd() }, writeIcon()));
  if (!bar) bar = document.body.appendChild(h('nav', { class: 'tabbar', 'aria-label': 'Main' }));
  const r = route(), n = labNew();
  const tab = (label, href, on) => h('a', { class: 'tb' + (on ? ' on' : ''), href }, h('span', {}, label));
  bar.replaceChildren(
    tab('Filer', '#/', r.view === 'today'),
    tab('Today', '#/day', r.view === 'day'),
    h('button', { class: 'tb-add', 'aria-label': 'Write something down', onclick: () => openQuickAdd() }, writeIcon()),
    tab('Week', fileHref(THISWEEK), r.view === 'file' && r.path === THISWEEK),
    h('button', { class: 'tb' + (document.body.classList.contains('drawer-open') ? ' on' : ''), 'aria-label': 'Planner, Lists and Collections', onclick: toggleMoreMenu }, h('span', {}, 'More'), n ? h('i', { class: 'tb-badge' }, String(n)) : null));
}

// ---------- quick destinations: where a new card goes, picked while writing (none = the Filer) ----------
let quickTarget = null;
const QUICK = () => {
  const now = new Date(), r = route();
  // on a list's page, that list comes first (and is picked when the sheet opens)
  const here = r.view === 'file' && ![INBOX, THISWEEK, TASKS, 'Lists/Shopping.md'].includes(r.path) && md.fileType(r.path, vault.read(r.path) || '') === 'list';
  return [
    here && { key: 'here', label: title(r.path), path: r.path },
    { key: 'today', label: 'Today', path: THISWEEK, due: iso(now) },
    { key: 'tomorrow', label: 'Tomorrow', path: THISWEEK, due: iso(addDays(now, 1)) },
    { key: 'week', label: 'This week', path: THISWEEK },
    { key: 'tasks', label: 'General To-Do', path: TASKS },
    { key: 'shopping', label: 'Shopping', path: 'Lists/Shopping.md' },
  ].filter((q) => q && vault.exists(q.path));
};
function quickChips(redraw) {
  return h('div', { class: 'quick-chips', role: 'group', 'aria-label': 'Where it goes' },
    QUICK().map((q) => h('button', { type: 'button', class: 'chip' + (quickTarget === q.key ? ' on' : ''), 'aria-pressed': String(quickTarget === q.key),
      onclick: () => { quickTarget = quickTarget === q.key ? null : q.key; redraw(); } }, q.label)));
}
// a written card goes to the picked place (a day prefix still wins over Today/Tomorrow), or onto the Filer
function placeCard(text, due, notes = '') {
  const q = QUICK().find((x) => x.key === quickTarget);
  const d = due || q?.due;
  const path = q ? (q.path === TASKS && d ? THISWEEK : q.path) : INBOX;  // a day sends it to This week, never into the backlog
  update(path, (t) => {
    // a list of plain items (no tick boxes) gets a plain item
    const segs = md.parseList(t), checkbox = segs.some((x) => x.kind === 'item' && x.checkbox) || !segs.some((x) => x.kind === 'item');
    t = md.addItem(t, text + (d ? ` 📅 ${d}` : ''), { top: true, checkbox });
    const item = notes.trim() && md.parseList(t).find((x) => x.kind === 'item');
    return item ? md.setItemNotes(t, item, notes) : t;
  });
  quickTarget = null;
  return q ? q.label : null;
}

// "More" in the tab bar: the sheet with Planner, Lists and Collections, on Planner (swipe sideways for the others)
function toggleMoreMenu() {
  if (document.body.classList.contains('drawer-open')) { closeDrawer(); return; }
  ui.tab = 'planner'; saveUi(); renderSide(); openDrawer();
}

// quick capture from any page: text or voice, onto the Filer (a day prefix still sets the date)
// writing something down, from any page: text, voice, a drawing, and where it goes (none = the Filer)
function openQuickAdd() {
  $('.sheet-back')?.remove();
  quickTarget = QUICK().some((q) => q.key === 'here') ? 'here' : null;
  const close = () => { live?.rec.abort(); live = null; back.remove(); window.__sheetRedraw = null; pad = null; drawOpen = false; };
  // like Google Tasks: the keyboard's return key sends it (Shift+Return on the Mac starts a line of notes)
  const grow = () => { area.style.height = 'auto'; area.style.height = area.scrollHeight + 'px'; };
  const area = h('textarea', { rows: 1, placeholder: 'New card', class: 'qa-text', 'aria-label': 'New card', enterkeyhint: 'done',
    title: 'MO:, morgen:, 7.11: at the start sets the day',
    oninput: grow, onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } } });
  const body = h('div', {});
  // (wrapped in h() so an empty slot stays empty: replaceChildren would print "null")
  const draw = () => {
    body.replaceChildren(h('div', {},
      drawOpen && pad?.canvas,
      !drawOpen && pad?.box && h('div', { class: 'sketch-chip' },
        h('img', { src: padImage().toDataURL(), alt: 'Drawing', title: 'Keep drawing', onclick: toggleDraw }),
        h('button', { type: 'button', class: 'quiet', 'aria-label': 'Remove drawing', onclick: clearPad }, '×')),
      voice && h('div', { class: 'voice-chip' }, h('audio', { controls: true, src: voice.url }),
        h('button', { type: 'button', class: 'quiet', 'aria-label': 'Remove voice note', onclick: () => { URL.revokeObjectURL(voice.url); voice = null; draw(); } }, '×')),
      quickChips(() => draw()),
      h('div', { class: 'capture-tools qa-tools' },
        // speaking writes into the field as you talk; where the phone can't, it records and GitHub writes it out later
        SR && !liveFailed ? liveButtons(area, () => draw()) : recordButton(),
        h('button', { type: 'button', class: 'pen' + (drawOpen ? ' on' : ''), 'aria-label': drawOpen ? 'Close drawing' : 'Draw', 'aria-pressed': String(drawOpen), onclick: toggleDraw }, penIcon()),
        drawOpen && h('button', { type: 'button', class: 'quiet clear-pad', 'aria-label': 'Clear the drawing', title: 'Clear', onclick: clearPad }, '⌫'),
        h('button', { class: 'send', 'aria-label': 'Add', title: 'Add (Return)', onclick: submit }, h('i', { class: 'tick-icon', 'aria-hidden': 'true' })))));
    if (drawOpen) setTimeout(fitPad, 0);
  };
  async function submit() {
    if (recording) recording.rec.stop();
    live?.rec.stop(); live = null;
    const [first = '', ...rest] = area.value.trim().split('\n');
    const drawn = pad?.box;
    if (!first.trim() && !voice && !drawn) return;
    const now = new Date();
    let { text, due } = parseCapture(first.trim(), now);
    if (drawn) {
      const blob = await new Promise((ok) => padImage().toBlob(ok, 'image/png'));
      const name = `Sketch ${stamp(now)}.png`;
      await vault.write(`attachments/${name}`, blob);
      text = [text, `![[${name}]]`].filter(Boolean).join(' ');
    }
    if (voice) {
      const name = `Voice ${stamp(now)}.${voice.ext}`;
      await vault.write(`attachments/${name}`, voice.blob);
      text = [text, `![[${name}]]`].filter(Boolean).join(' ');
      URL.revokeObjectURL(voice.url); voice = null;
    }
    const where = placeCard(text, due, rest.join('\n'));
    close(); toast(where ? `Added to ${where}` : 'On the Filer');
  }
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'sheet qa', role: 'dialog', 'aria-label': 'Write something down' },
      area, body));
  window.__sheetRedraw = draw;
  draw();
  document.body.append(back);
  // focused at once, inside the tap: the iPhone only brings up the keyboard then
  area.focus({ preventScroll: true });
}

// ---------- a task's details, in a sheet from the bottom (as in Google Tasks) ----------
const REPEATS = [['every day', 'Daily'], ['every weekday', 'Weekdays'], ['every week', 'Weekly'], ['every month', 'Monthly'], ['every year', 'Yearly']];
const grow = (el) => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; };
function openTaskSheet(path, item) {
  $('.sheet-back')?.remove();
  let cur = { line: item.line, text: item.text, indent: item.indent }, focusAdd = false;
  const get = () => md.findItem(vault.read(path) || '', cur);
  const follow = () => { const f = get(); if (f) cur = { line: f.line, text: f.text, indent: f.indent }; };
  // change the task in its file; `redraw` false while typing (redrawing would take the cursor away)
  const op = (fn, { undo = null, redraw = true } = {}) => {
    const run = () => update(path, (t) => { const f = md.findItem(t, cur); return f ? fn(t, f) : t; });
    undo ? withUndo(undo, [path], run) : run();
    follow(); if (redraw) draw();
  };
  const close = () => back.remove();
  const setDate = (date) => {
    const f = get(); if (!f) return;
    if (path === TASKS && date) {  // the backlog has no days: with one, the task moves into This week
      moveToWeek(path, f, date); path = THISWEEK; cur = { line: -1, text: f.text, indent: 0 }; follow(); draw(); return;
    }
    op((t, g) => md.setItemFields(t, g.line, date ? { due: date } : { due: null, time: null, repeat: null }));
  };
  const body = h('div', {});
  let tTimer, nTimer;
  const draw = () => {
    const f = get(); if (!f) { close(); return; }
    const now = new Date(), today = iso(now), tomorrow = iso(addDays(now, 1)), monday = iso(addDays(now, ((8 - now.getDay()) % 7) || 7));
    const chip = (label, on, fn, extra = {}) => h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: fn, ...extra }, label);
    const titleEl = h('textarea', { class: 'ts-title', rows: 1, enterkeyhint: 'done', 'aria-label': 'Task', spellcheck: true,
      oninput: (e) => { grow(e.target); clearTimeout(tTimer); tTimer = setTimeout(() => saveTitle(e.target.value), 600); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      onblur: (e) => { clearTimeout(tTimer); saveTitle(e.target.value); } });
    titleEl.value = f.text;
    const saveTitle = (v) => { v = v.replace(/\s*\n\s*/g, ' ').trim(); if (v && v !== cur.text) op((t, g) => md.setItemText(t, g.line, v), { redraw: false }); };
    const notesEl = h('textarea', { class: 'ts-notes', rows: 1, placeholder: 'Details', 'aria-label': 'Details',
      oninput: (e) => { grow(e.target); clearTimeout(nTimer); nTimer = setTimeout(() => saveNotes(e.target.value), 600); },
      onblur: (e) => { clearTimeout(nTimer); saveNotes(e.target.value); } });
    notesEl.value = f.notes.map((n) => n.text).join('\n');
    const saveNotes = (v) => { const g = get(); if (g && v.trim() !== g.notes.map((n) => n.text).join('\n').trim()) op((t, x) => md.setItemNotes(t, x, v), { redraw: false }); };
    const kids = f.children.filter((c) => c.kind !== 'md');
    const addEl = h('input', { class: 'ts-add', placeholder: 'Add sub-task', enterkeyhint: 'done', 'aria-label': 'Add sub-task',
      onkeydown: (e) => { if (e.key !== 'Enter') return; e.preventDefault(); const v = e.target.value.trim(); if (!v) return; focusAdd = true; op((t, g) => md.addItem(t, v, { parent: g })); } });
    body.replaceChildren(h('div', {},
      titleEl, notesEl,
      h('div', { class: 'ts-row' }, h('span', { class: 'ts-icon', 'aria-hidden': 'true' }, h('i', { class: 'clock' })),
        h('div', { class: 'quick-chips' },
          chip('Today', f.due === today, () => setDate(f.due === today ? null : today)),
          chip('Tomorrow', f.due === tomorrow, () => setDate(f.due === tomorrow ? null : tomorrow)),
          chip('Next week', f.due === monday, () => setDate(f.due === monday ? null : monday)),
          h('label', { class: 'chip chip-date' + (f.due && ![today, tomorrow, monday].includes(f.due) ? ' on' : '') },
            f.due && ![today, tomorrow, monday].includes(f.due) ? dayLabel(f.due) : 'Pick',
            h('input', { type: 'date', value: f.due || '', 'aria-label': 'Pick a day', onchange: (e) => setDate(e.target.value || null) })),
          f.due && h('label', { class: 'chip chip-date' + (f.time ? ' on' : '') }, f.time || 'Time',
            h('input', { type: 'time', value: f.time || '', 'aria-label': 'Time', onchange: (e) => op((t, g) => md.setItemFields(t, g.line, { time: e.target.value || null })) })))),
      h('div', { class: 'ts-row' }, h('span', { class: 'ts-icon', 'aria-hidden': 'true' }, '↻'),
        h('div', { class: 'quick-chips' }, REPEATS.map(([rule, label]) => chip(label, f.repeat === rule, () => {
          const off = f.repeat === rule;
          if (!off && !f.due) setDate(today);  // a repeat needs a first day
          op((t, g) => md.setItemFields(t, g.line, { repeat: off ? null : rule }));
        })))),
      h('div', { class: 'ts-subs' },
        kids.map((c) => h('div', { class: 'ts-sub' + (c.checked ? ' done' : '') },
          c.checkbox && checkbox(c.checked, () => op((t) => { const g = md.findItem(t, c); return g ? md.toggleItem(t, g.line) : t; }), true),
          editableText(c.text, (v) => op((t) => { const g = md.findItem(t, c); return !g ? t : v ? md.setItemText(t, g.line, v) : md.deleteItem(t, g); })))),
        addEl),
      h('div', { class: 'ts-bar' },
        h('button', { type: 'button', class: 'ts-btn star' + (f.starred ? ' on' : ''), 'aria-label': f.starred ? 'Unstar' : 'Star', 'aria-pressed': String(f.starred),
          onclick: () => op((t, g) => md.setItemFields(t, g.line, { starred: !f.starred })) }, f.starred ? '★' : '☆'),
        h('button', { type: 'button', class: 'ts-btn', 'aria-label': 'File into another list', title: 'File into…', onclick: () => { close(); openMoveSheet(path, get()); } }, '⇢'),
        h('button', { type: 'button', class: 'ts-btn danger', 'aria-label': 'Delete', title: 'Delete', onclick: () => { const g = get(); close(); withUndo('Deleted', [path], () => update(path, (t) => { const x = md.findItem(t, g); return x ? md.deleteItem(t, x) : t; })); } }, '⌫'),
        f.checkbox && h('button', { type: 'button', class: 'send', 'aria-label': f.checked ? 'Mark not done' : 'Mark done', title: f.checked ? 'Not done' : 'Done',
          onclick: () => { const g = get(); close(); withUndo('Done', [path], () => update(path, (t) => { const x = md.findItem(t, g); return x ? md.toggleItem(t, x.line) : t; })); } },
          h('i', { class: 'tick-icon', 'aria-hidden': 'true' })))));
    requestAnimationFrame(() => { grow(titleEl); grow(notesEl); if (focusAdd) { focusAdd = false; addEl.focus(); } });
  };
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) { document.activeElement?.blur?.(); close(); } } },
    h('div', { class: 'sheet task-sheet', role: 'dialog', 'aria-label': 'Task details' }, body));
  draw();
  document.body.append(back);
}

// lists you filed into lately come first in "File into"
function noteRecent(p) { ui.recent = [p, ...(ui.recent || []).filter((x) => x !== p)].slice(0, 4); saveUi(); }

// ---------- undo: every swipe and move can be taken back for a few seconds ----------
let toastTimer = null;
// with an undo: just the Undo button (the change itself is on screen); without: a short note that goes quickly
function toast(text, undo, ms = undo ? 4000 : 1400) {
  $('.toast')?.remove();
  const el = undo
    ? h('div', { class: 'toast toast-only-undo', role: 'status', 'aria-live': 'polite' },
      h('button', { class: 'toast-undo', 'aria-label': `Undo: ${text}`, onclick: () => { undo(); el.remove(); } }, 'Undo'))
    : h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, h('span', {}, text));
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), ms);
}
// run `fn`, remembering how `paths` looked before, and offer to put them back
function withUndo(text, paths, fn) {
  const before = paths.map((p) => [p, vault.read(p)]);
  fn();
  toast(text, () => { for (const [p, t] of before) if (t != null) vault.write(p, t); });
}

// ---------- pull down at the top of a page to sync now ----------
(() => {
  let y0 = null, x0 = 0, pull = 0;
  const bar = () => $('.pull') || document.body.appendChild(h('div', { class: 'pull', 'aria-hidden': 'true' }, h('span', { class: 'menu-flame' })));
  document.addEventListener('touchstart', (e) => {
    if (scrollY > 0 || document.body.classList.contains('drawer-open') || $('.sheet-back') || e.target.closest?.('textarea, input, .pad-canvas')) { y0 = null; return; }
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; pull = 0;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    const dy = e.touches[0].clientY - y0, dx = Math.abs(e.touches[0].clientX - x0);
    if (dy <= 0 || dx > dy) { pull = 0; bar().style.transform = ''; return; }
    pull = dy;
    bar().style.transform = `translate(-50%, ${Math.min(dy * 0.5, 64)}px)`;
    bar().classList.toggle('ready', dy > 90);
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (y0 === null) return;
    y0 = null;
    const b = bar();
    if (pull > 90) {
      b.classList.add('busy'); b.style.transform = 'translate(-50%, 40px)';
      await vault.sync();
      const st = vault.status.state;
      toast(st === 'synced' ? 'Up to date' : st === 'offline' ? 'Offline: changes wait on this device' : 'Sync problem', null, st === 'synced' ? 900 : 3000);
    }
    b.classList.remove('busy', 'ready'); b.style.transform = '';
  });
})();

// ---------- keyboard on the Mac: N new card, T today, W this week, L lab, [ sidebar, Esc close ----------
addEventListener('keydown', (e) => {
  // Cmd+T (Ctrl+T) writes something down, from anywhere in the app, even while typing
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't' && vault.backend) { e.preventDefault(); if (!$('.sheet.qa')) openQuickAdd(); else $('.qa-text')?.focus(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') { closeDrawer(); $('.sheet-back')?.remove(); return; }
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  const go = { n: '#/', t: '#/day', w: fileHref(THISWEEK), l: '#/lab', c: '#/calendar' }[e.key.toLowerCase()];
  if (e.key.toLowerCase() === 'n') { e.preventDefault(); openQuickAdd(); return; }
  if (go) { e.preventDefault(); location.hash = go; }
  if (e.key === '[') { e.preventDefault(); setCollapsed(!ui.sideCollapsed); renderSide(); }
});

// sheets close with a swipe down, a tap beside them, or Esc
document.addEventListener('touchstart', (e) => {
  const sheet = e.target.closest?.('.sheet'); if (!sheet || sheet.scrollTop > 0) return;
  const y0 = e.touches[0].clientY;
  const end = (ev) => { if (ev.changedTouches[0].clientY - y0 > 90) sheet.closest('.sheet-back')?.remove(); };
  sheet.addEventListener('touchend', end, { once: true });
}, { passive: true });

// ---------- drag and drop in the sidebar: reorder, into folders, between Planner and Lists ----------
let dragPath = null;
async function setMeta(path, kv) {
  let t = vault.read(path) || '';
  const data = md.splitFrontmatter(t).data;
  for (const [k, v] of Object.entries(kv)) if (v !== null || k in data) t = md.setFrontmatterKey(t, k, v);
  await vault.write(path, t);
}
// put `path` where a target is: its section (moving the file if needed), area and folder, then in order before `before`
async function placeFile(path, { sectionName, planner = false, folder = null, before = null, group = null }) {
  let p = path;
  if (sectionName && section(p) !== sectionName) {
    const to = `${sectionName}/${p.split('/').pop()}`;
    try { await vault.rename(p, to); } catch (e) { alert(e.message); return; }
    p = to;
  }
  await setMeta(p, { area: planner ? 'planner' : null, folder });
  if (group) {
    const list = group.filter((x) => x !== path && x !== p);
    const i = before ? list.indexOf(before) : -1;
    list.splice(i < 0 ? list.length : i, 0, p);
    for (const [k, q] of list.entries()) if (Number(md.splitFrontmatter(vault.read(q) || '').data.order) !== k + 1) await setMeta(q, { order: k + 1 });
  }
  if (route().view === 'file' && route().path === path && p !== path) location.hash = fileHref(p);
}
function dropZone(el, onDrop) {
  el.addEventListener('dragover', (e) => { if (!dragPath) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('drop-over'); const p = dragPath; dragPath = null; if (p) onDrop(p); });
  return el;
}

function fileLink(path, active, group = null) {
  const el = h('a', { class: 'nav-item' + (path === active ? ' active' : ''), href: fileHref(path), draggable: 'true' },
    h('span', { class: 'nav-name' }, title(path)), h('span', { class: 'nav-badge' }, badge(path)));
  el.addEventListener('dragstart', (e) => { dragPath = path; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', title(path)); el.classList.add('dragging'); });
  el.addEventListener('dragend', () => { dragPath = null; el.classList.remove('dragging'); });
  // dropped on another item: join its place (Planner or Lists, its folder) just above it
  return dropZone(el, (p) => p !== path && placeFile(p, { sectionName: section(path), planner: area(path) === 'planner',
    folder: md.splitFrontmatter(vault.read(path) || '').data.folder || null, before: path, group }));
}

// `label` is set for folders made from `folder:` labels (nested with "/", e.g. "To get/Watch List")
function folderBlock(name, node, active, prefix, depth, label = null) {
  const key = prefix + name;
  const open = !!ui.open[key] || (active && (active.startsWith(key + '/') || node.files.includes(active)));
  const files = [...node.files].sort(byOrder);
  const count = files.length + Object.keys(node.dirs).length;
  const head = h('div', { class: 'folder' },
    h('button', { class: 'folder-head' + (open ? ' open' : ''), style: depth ? `margin-left:${depth * 14}px; width:calc(100% - ${depth * 14}px)` : null,
      onclick: () => { ui.open[key] = !open; saveUi(); renderSide(); } },
      h('span', { class: 'caret' }, open ? '–' : '+'), h('span', { class: 'nav-name' }, name), h('span', { class: 'nav-badge' }, count)),
    open && h('div', { class: 'folder-body', style: depth ? `margin-left:${depth * 14}px` : null },
      Object.keys(node.dirs).sort().map((d) => folderBlock(d, node.dirs[d], active, key + '/', label ? depth + 1 : 0, label && `${label}/${d}`)),
      files.map((p) => fileLink(p, active, files))));
  // a labelled folder: dropping a list on its heading files it there
  if (label) dropZone(head.firstChild, (p) => placeFile(p, { sectionName: prefix.split('/')[0], folder: label, group: files }));
  return head;
}

// the app icon's 10×10 flame, drawn in ink with a grey core
const flameMark = () => h('span', { class: 'flame', html: `<svg viewBox="0 0 10 10" shape-rendering="crispEdges" width="100%" height="100%"><path fill="var(--ink)" d="M4 1h1v1h-1zM5 1h1v1h-1zM4 2h1v1h-1zM5 2h1v1h-1zM4 3h1v1h-1zM5 3h1v1h-1zM6 3h1v1h-1zM8 3h1v1h-1zM2 4h1v1h-1zM3 4h1v1h-1zM4 4h1v1h-1zM6 4h1v1h-1zM7 4h1v1h-1zM8 4h1v1h-1zM2 5h1v1h-1zM3 5h1v1h-1zM6 5h1v1h-1zM7 5h1v1h-1zM8 5h1v1h-1zM1 6h1v1h-1zM2 6h1v1h-1zM7 6h1v1h-1zM8 6h1v1h-1zM2 7h1v1h-1zM7 7h1v1h-1zM8 7h1v1h-1zM2 8h1v1h-1zM3 8h1v1h-1zM6 8h1v1h-1zM7 8h1v1h-1zM3 9h1v1h-1zM4 9h1v1h-1zM5 9h1v1h-1zM6 9h1v1h-1z"/><path fill="var(--faint)" d="M5 4h1v1h-1zM4 5h1v1h-1zM5 5h1v1h-1zM3 6h1v1h-1zM4 6h1v1h-1zM5 6h1v1h-1zM6 6h1v1h-1zM3 7h1v1h-1zM4 7h1v1h-1zM5 7h1v1h-1zM6 7h1v1h-1zM4 8h1v1h-1zM5 8h1v1h-1z"/></svg>` });

const TABS = [['planner', 'Planner'], ['lists', 'Lists'], ['collections', 'Collections']];
// switching tabs; `dir` slides the new one in from that side (a swipe on the phone)
function showTab(k, dir = 0) {
  ui.tab = k; saveUi(); renderSide();
  const nav = $('#side .nav');
  if (nav) nav.scrollTop = 0;
  if (dir && nav) { nav.classList.add(dir > 0 ? 'from-right' : 'from-left'); nav.addEventListener('animationend', () => nav.classList.remove('from-right', 'from-left'), { once: true }); }
}

function renderSide() {
  if (!vault.backend) { $('#side').replaceChildren(h('div', { class: 'brand' }, h('a', { href: '#/' }, APP_NAME))); return; }
  const r = route();
  const active = r.view === 'file' ? r.path : null;
  const side = $('#side');
  const q = query.trim().toLowerCase();
  let nav, tabs = null;
  if (q) {
    const hits = vault.list().filter((f) => /\.md$/i.test(f.path)).map((f) => {
      const t = f.content || '';
      const inTitle = title(f.path).toLowerCase().includes(q);
      const i = t.toLowerCase().indexOf(q);
      if (!inTitle && i < 0) return null;
      const snip = i >= 0 ? t.slice(Math.max(0, i - 30), i + 60).replace(/\s+/g, ' ') : '';
      return { path: f.path, inTitle, snip };
    }).filter(Boolean).sort((a, b) => b.inTitle - a.inTitle).slice(0, 60);
    nav = h('nav', { class: 'nav' },
      h('div', { class: 'label' }, `Results · ${hits.length}`),
      hits.map((x) => h('a', { class: 'nav-item hit' + (x.path === active ? ' active' : ''), href: fileHref(x.path) },
        h('span', { class: 'nav-name' }, title(x.path)), h('span', { class: 'hit-where' }, section(x.path)),
        x.snip && h('span', { class: 'hit-snip' }, '…' + x.snip + '…'))));
  } else {
    const t = tree();
    const open = (md.parseList(vault.read(INBOX) || '')).filter((s) => s.kind === 'item' && !s.checked).length;
    const others = Object.keys(t.dirs).filter((d) => !SECTIONS.includes(d)).sort((a, b) => (a === 'Archive') - (b === 'Archive') || a.localeCompare(b));
    const planner = vault.list().map((f) => f.path).filter((p) => /\.md$/i.test(p) && ![INBOX, QUESTIONS, TODOS, RESEARCH].includes(p) && !HIDDEN.includes(section(p)) && area(p) === 'planner').sort(byOrder);
    const kept = (files) => [...files].filter((p) => area(p) !== 'planner').sort(byOrder);
    const plannerLoose = [], plannerGroups = {};
    for (const p of planner) { const g = md.splitFrontmatter(vault.read(p) || '').data.folder; g ? (plannerGroups[g] ||= []).push(p) : plannerLoose.push(p); }
    const sectionBlock = (s) => h('div', { class: 'section' },
        dropZone(h('div', { class: 'label' }, h('span', {}, s), h('button', { class: 'add', title: `New in ${s}`, onclick: () => newFile(s) }, '+')), (p) => placeFile(p, { sectionName: s })),
        // `folder:` in a file's frontmatter groups it in the sidebar; the file itself stays put (other tools read it by path)
        (() => {
          const loose = [], labelled = {};
          for (const p of kept(t.dirs[s]?.files || [])) {
            const f = md.splitFrontmatter(vault.read(p) || '').data.folder;
            if (!f) { loose.push(p); continue; }
            const [top, ...sub] = f.split('/').map((x) => x.trim());
            let node = labelled[top] ||= { files: [], dirs: {} };
            for (const d of sub) node = node.dirs[d] ||= { files: [], dirs: {} };
            node.files.push(p);
          }
          return [
            Object.keys(labelled).sort().map((f) => folderBlock(f, labelled[f], active, s + '/~', 0, f)),
            loose.map((p) => fileLink(p, active, loose)),
          ];
        })(),
        Object.keys(t.dirs[s]?.dirs || {}).sort().map((d) => folderBlock(d, t.dirs[s].dirs[d], active, s + '/', 0)));
    const tab = ['lists', 'collections'].includes(ui.tab) ? ui.tab : 'planner';
    tabs = h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, name]) =>
      // drop a list or note on Planner or Lists to move it there; hovering a tab while dragging opens it
      k === 'collections' ? h('button', { class: 'tab' + (tab === k ? ' active' : ''), role: 'tab', 'aria-selected': String(tab === k), onclick: () => showTab(k) }, name)
        : dropZone(h('button', { class: 'tab' + (tab === k ? ' active' : ''), role: 'tab', 'aria-selected': String(tab === k), onclick: () => showTab(k) }, name),
          (p) => placeFile(p, { sectionName: 'Lists', planner: k === 'planner' }))));
    nav = h('nav', { class: 'nav' }, tab === 'planner' ? [
      h('a', { class: 'nav-item today' + (r.view === 'today' ? ' active' : ''), href: '#/' }, h('span', { class: 'nav-name' }, 'Filer'), h('span', { class: 'nav-badge' }, open || '')),
      h('a', { class: 'nav-item' + (r.view === 'calendar' ? ' active' : ''), href: '#/calendar' }, h('span', { class: 'nav-name' }, 'Calendar'),
        h('span', { class: 'nav-badge' }, calendarEvents().filter((e) => e.date === iso(new Date())).length || '')),
      h('a', { class: 'nav-item recent-link' + (r.view === 'recent' ? ' active' : ''), href: '#/recent' }, h('span', { class: 'nav-name' }, 'Recent'), h('span', { class: 'nav-badge' }, h('i', { class: 'clock', 'aria-hidden': 'true' }))),
      h('a', { class: 'nav-item' + (r.view === 'lab' ? ' active' : ''), href: '#/lab' }, h('span', { class: 'nav-name' }, 'Lab'),
        h('span', { class: 'nav-badge' }, labCount() || '')),
      h('div', { class: 'section' },
        h('div', { class: 'label' }, h('span', {}, 'Lists'), h('button', { class: 'add', title: 'New list', onclick: () => newFile('Lists', true) }, '+')),
        h('a', { class: 'nav-item' + (r.view === 'day' ? ' active' : ''), href: '#/day' }, h('span', { class: 'nav-name' }, 'Today'),
          h('span', { class: 'nav-badge' }, dueItems().filter((x) => x.due <= iso(new Date())).length || '')),
        (() => { const n = starredItems().length; return n > 0 && h('a', { class: 'nav-item' + (r.view === 'starred' ? ' active' : ''), href: '#/starred' }, h('span', { class: 'nav-name' }, 'Starred'), h('span', { class: 'nav-badge' }, String(n))); })(),
        plannerLoose.map((p) => fileLink(p, active, plannerLoose))),
      // planner lists with a `folder:` label get their own heading (Egghead: work and research)
      Object.entries(plannerGroups).map(([g, files]) => h('div', { class: 'section' },
        dropZone(h('div', { class: 'label' }, h('span', {}, g)), (p) => placeFile(p, { sectionName: 'Lists', planner: true, folder: g, group: files })),
        files.map((p) => fileLink(p, active, files)))),
      (() => {
        const tags = Object.entries(tagIndex()).sort((a, b) => b[1].length - a[1].length);
        return tags.length > 0 && h('div', { class: 'section' }, h('div', { class: 'label' }, 'Tags'),
          tags.map(([k, v]) => h('a', { class: 'nav-item' + (r.view === 'tag' && r.name === k ? ' active' : ''), href: `#/tag/${encodeURIComponent(k)}` },
            h('span', { class: 'nav-name' }, '#' + k), h('span', { class: 'nav-badge' }, String(v.length)))));
      })(),
    ] : tab === 'lists' ? sectionBlock('Lists') : [
      SECTIONS.filter((s) => s !== 'Lists').map((s) => sectionBlock(s)),
      people().length > 0 && h('div', { class: 'section' }, h('a', { class: 'label', href: fileHref(PEOPLE) }, 'People'),
        people().map((p) => h('a', { class: 'nav-item' + (r.view === 'person' && r.name === p.name ? ' active' : ''), href: `#/people/${encodeURIComponent(p.name)}` }, h('span', { class: 'nav-name' }, p.name)))),
      t.files.length > 0 && h('div', { class: 'section' }, h('div', { class: 'label' }, 'Unfiled'), kept(t.files).map((p) => fileLink(p, active))),
      others.map((d) => h('div', { class: 'section' }, h('div', { class: 'label' }, d),
        kept(t.dirs[d].files).map((p) => fileLink(p, active)),
        Object.keys(t.dirs[d].dirs).sort().map((sub) => folderBlock(sub, t.dirs[d].dirs[sub], active, d + '/', 0)))),
    ]);
  }

  const st = vault.status;
  const statusText = {
    idle: 'Not synced yet', syncing: st.progress ? `Loading ${st.progress}` : 'Syncing…', local: 'On this device only', offline: 'Offline',
    synced: `Synced ${st.at ? new Date(st.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`,
    error: 'Sync problem',
  }[st.state] + (st.pending ? ` · ${st.pending} to send` : '');

  const navTop = $('.nav', side)?.scrollTop || 0;
  const searchEl = $('.search', side);
  const hadFocus = document.activeElement === searchEl;
  side.replaceChildren(
    h('div', { class: 'brand' }, flameMark(), h('a', { href: '#/' }, APP_NAME),
      h('button', { class: 'tuck', 'aria-label': ui.sideCollapsed ? 'Keep the sidebar open' : 'Tuck the sidebar away', title: ui.sideCollapsed ? 'Keep open' : 'Tuck away', onclick: () => setCollapsed(!ui.sideCollapsed) }, ui.sideCollapsed ? '›' : '‹')),
    h('input', { class: 'search', type: 'search', placeholder: 'Search', value: query, autocomplete: 'off', spellcheck: false,
      oninput: (e) => { query = e.target.value; renderSide(); } }),
    tabs,
    nav,
    h('footer', { class: 'side-foot' },
      h('button', { class: 'status ' + st.state, title: st.error || '', onclick: () => vault.sync() }, statusText),
      h('span', { class: 'foot-links' },
        h('button', { class: 'theme-switch', onclick: () => { setPref(KEYS.theme, isDark() ? 'light' : 'dark'); applyTheme(); render(); } }, isDark() ? 'Light' : 'Dark'),
        h('a', { href: '#/settings', class: r.view === 'settings' ? 'active' : '' }, 'Settings'))));
  const newNav = $('.nav', side); if (newNav) newNav.scrollTop = navTop;
  if (hadFocus) { const s = $('.search', side); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

async function newFile(sec, planner = false) {
  const name = prompt(`New ${sec === 'Lists' ? 'list' : sec === 'Trackers' ? 'tracker' : 'note'}`);
  if (!name?.trim()) return;
  const path = `${sec}/${name.trim().replace(/[\\/:]/g, '-')}.md`;
  const body = planner ? '---\narea: planner\n---\n' : sec === 'Trackers' ? '| Date | Note |\n| --- | --- |\n' : '';
  try { await vault.create(path, body); } catch (e) { alert(e.message); return; }
  location.hash = fileHref(path);
}

// ---------- main ----------
function renderMain() {
  const r = route();
  const main = $('#main');
  document.body.dataset.view = r.view;
  let view;
  if (!vault.backend) view = settingsView(true);
  else if (r.view === 'settings') view = settingsView();
  else if (r.view === 'index') view = h('div');
  else if (r.view === 'file') view = fileView(r.path);
  else if (r.view === 'lab') view = labView();
  else if (r.view === 'calendar') view = calendarView();
  else if (r.view === 'day') view = dayView();
  else if (r.view === 'review') view = weeklyReview();
  else if (r.view === 'recent') view = recentView();
  else if (r.view === 'person') view = personView(r.name);
  else if (r.view === 'tag') view = tagView(r.name);
  else if (r.view === 'starred') view = starredView();
  else if (r.view === 'sort') view = sortView(r.path);
  else view = todayView();
  main.replaceChildren(view);
  hydrateImages(vault, main);
}

function pageHead(kicker, heading, meta) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'meta-row' },
      h('button', { class: 'menu-btn', 'aria-label': 'Open the sidebar', onclick: () => openDrawer() }, h('span', { class: 'menu-flame' }), 'Index'),
      h('span', { class: 'kicker' }, kicker),
      h('span', { class: 'meta' }, meta || '')),
    heading && h('h1', { class: 'title' }, heading));
}

// ---------- voice notes: recorded here, turned into text on GitHub (tools/transcribe.py) ----------
let voice = null; // { blob, ext, url } once recorded
let recording = null; // { rec, started, timer, target } while recording; target: 'board' or 'answer' (the Lab)

// ---------- live dictation: the phone's own speech recognition writes into the field while you speak ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let live = null, liveFailed = false;  // live: { rec } while listening; liveFailed: not allowed here, so recording instead
const LANGS = { en: 'en-GB', de: 'de-DE' };
function liveButtons(area, redraw) {
  const lang = ui.dictLang === 'de' ? 'de' : 'en';
  return [
    h('button', { type: 'button', class: 'rec' + (live ? ' on live' : ''), 'aria-label': live ? 'Stop' : 'Speak', title: live ? 'Stop' : 'Speak',
      onclick: () => (live ? live.rec.stop() : startLive(area, redraw)) }, live ? h('span', { class: 'live-wave' }) : recIcon()),
    h('button', { type: 'button', class: 'lang-chip', 'aria-label': `Language: ${lang === 'en' ? 'English' : 'German'}`, title: 'Switch language',
      onclick: () => { ui.dictLang = lang === 'en' ? 'de' : 'en'; saveUi(); if (live) { live.rec.stop(); setTimeout(() => startLive(area, redraw), 250); } redraw(); } }, lang.toUpperCase()),
  ];
}
function startLive(area, redraw) {
  const rec = new SR();
  rec.lang = LANGS[ui.dictLang === 'de' ? 'de' : 'en'];
  rec.continuous = true;
  rec.interimResults = true;
  const base = area.value.replace(/\s+$/, '');
  // the whole transcript so far, rebuilt on every result (the iPhone revises earlier words as you go)
  rec.onresult = (e) => {
    const said = [...e.results].map((r) => r[0].transcript).join('').trim();
    area.value = [base, said ? said[0].toUpperCase() + said.slice(1) : ''].filter(Boolean).join(base && said ? ' ' : '');
    area.dispatchEvent(new Event('input'));
  };
  rec.onerror = (e) => {
    if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
      liveFailed = true; live = null; redraw(); toast('Recording instead; it becomes text in a minute', null, 3000);
      toggleRecording();
    }
  };
  rec.onend = () => { if (live?.rec === rec) { live = null; redraw(); } };
  try { rec.start(); } catch { liveFailed = true; redraw(); return; }
  live = { rec };
  redraw();
  area.focus({ preventScroll: true });
}
const recIcon = () => h('span', { class: 'rec-dot' });
const stamp = (d) => `${iso(d)} ${[d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('')}`;
function recordButton(target = 'board') {
  const on = recording?.target === target;
  return h('button', { type: 'button', class: 'rec' + (on ? ' on' : ''), 'aria-label': on ? 'Stop recording' : 'Speak', title: on ? 'Stop' : 'Speak', onclick: () => toggleRecording(target) },
    on ? h('span', { class: 'rec-time' }, '0:00') : recIcon());
}
async function toggleRecording(target = 'board') {
  if (recording) { recording.rec.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    alert('Recording needs the secure address (the padlock), which GitHub hasn’t switched on yet.');
    return;
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { alert('Mother Flame needs microphone access to record.'); return; }
  const type = ['audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(recording?.timer);
    recording = null;
    const blob = new Blob(chunks, { type: rec.mimeType || type });
    const ext = /mp4/.test(blob.type) ? 'm4a' : 'webm';
    if (blob.size && target === 'answer') queueVoiceAnswer(blob, ext);
    else if (blob.size) {
      if (voice) URL.revokeObjectURL(voice.url);
      voice = { blob, ext, url: URL.createObjectURL(blob) };
    }
    redrawCapture();
  };
  rec.start();
  recording = { rec, started: Date.now(), target };
  recording.timer = setInterval(() => {
    const s = Math.floor((Date.now() - recording.started) / 1000), el = $('.rec-time');
    if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
  redrawCapture();
}

// item text with its voice notes split off: the text stays editable, the players sit beside it
function textWithVoice(raw, save, cls) {
  const notes = [...raw.matchAll(/!\[\[([^\]]+)\]\]/g)].map((m) => m[1]).filter((n) => AUDIO.test(n));
  if (!notes.length) return editableText(raw, save, cls);
  const embeds = notes.map((n) => `![[${n}]]`);
  const bare = embeds.reduce((t, e) => t.replace(e, ''), raw).replace(/\s{2,}/g, ' ').trim();
  return h('div', { class: 'with-voice' },
    editableText(bare, (v) => save([v, ...embeds].filter(Boolean).join(' ')), cls),
    notes.map((n) => h('audio', { controls: true, preload: 'none', 'data-vault-src': resolveLink(vault, n, []) || `attachments/${n}` })),
    h('div', { class: 'meta' }, 'Transcribing…'));
}

// ---------- drawing: the capture field opens into a pad; the drawing rides along with the next card ----------
let pad = null; // { canvas, box } — kept across redraws so strokes survive
let drawOpen = false;
const penIcon = () => h('span', { html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/></svg>' });
function redrawCapture() {
  if (window.__sheetRedraw) { window.__sheetRedraw(); return; }
  const v = $('.capture textarea')?.value || '';
  renderMain();
  const f = $('.capture textarea'); if (f) f.value = v;
}

function makePad() {
  const canvas = h('canvas', { class: 'pad-canvas', 'aria-label': 'Drawing' });
  const p = { canvas, box: null };
  const ctx = () => canvas.getContext('2d');
  const pt = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const grow = ([x, y]) => { p.box = p.box ? [Math.min(p.box[0], x), Math.min(p.box[1], y), Math.max(p.box[2], x), Math.max(p.box[3], y)] : [x, y, x, y]; };
  let last = null;
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault(); canvas.setPointerCapture(e.pointerId);
    last = pt(e); grow(last); const c = ctx(); c.beginPath(); c.arc(last[0], last[1], 1.5, 0, 7); c.fill();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!last) return;
    const c = ctx();
    for (const ev of e.getCoalescedEvents?.() || [e]) { const q = pt(ev); c.beginPath(); c.moveTo(...last); c.lineTo(...q); c.stroke(); last = q; grow(q); }
  });
  const up = () => { last = null; };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  return p;
}
// match the bitmap to the canvas's size on screen, keeping what's drawn
function fitPad() {
  if (!pad) return;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const r = pad.canvas.getBoundingClientRect();
  const w = Math.round(r.width * dpr), hh = Math.round(r.height * dpr);
  if (!w || (pad.canvas.width === w && pad.canvas.height === hh)) return;
  pad.dpr = dpr;
  const old = pad.canvas.width ? Object.assign(document.createElement('canvas'), { width: pad.canvas.width, height: pad.canvas.height }) : null;
  old?.getContext('2d').drawImage(pad.canvas, 0, 0);
  Object.assign(pad.canvas, { width: w, height: hh });
  const c = pad.canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  Object.assign(c, { lineCap: 'round', lineJoin: 'round', lineWidth: 3, strokeStyle: '#111', fillStyle: '#111' });
  if (old) c.drawImage(old, 0, 0, old.width / dpr, old.height / dpr);
}
// what was drawn, cropped, black on white
function padImage() {
  const dpr = pad.dpr || 1;
  const m = 16, W = pad.canvas.width / dpr, H = pad.canvas.height / dpr, b = pad.box;
  const sx = Math.max(0, b[0] - m), sy = Math.max(0, b[1] - m);
  const w = Math.min(W, b[2] + m) - sx, hh = Math.min(H, b[3] + m) - sy;
  const out = Object.assign(document.createElement('canvas'), { width: Math.round(w * dpr), height: Math.round(hh * dpr) });
  const o = out.getContext('2d');
  o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height);
  o.drawImage(pad.canvas, sx * dpr, sy * dpr, w * dpr, hh * dpr, 0, 0, out.width, out.height);
  return out;
}
function toggleDraw() {
  drawOpen = !drawOpen;
  if (drawOpen) pad ||= makePad();
  if (!drawOpen && pad && !pad.box) pad = null;
  redrawCapture();
  if (drawOpen) setTimeout(fitPad, 0);
}
function clearPad() { pad = drawOpen ? makePad() : null; redrawCapture(); if (drawOpen) setTimeout(fitPad, 0); }

// ---------- Today and This week: dated tasks from every list, with the calendar ----------
// Nothing is moved: a task dated today (or earlier and not done) simply shows in Today.
function dueItems() {
  const out = [];
  for (const f of vault.list()) {
    if (!/\.md$/i.test(f.path) || HIDDEN.includes(section(f.path)) || !f.content?.includes('📅')) continue;
    const walk = (nodes) => { for (const n of nodes) { if (n.kind === 'md') continue; if (n.checkbox && !n.checked && n.due) out.push({ ...n, path: f.path }); walk(n.children || []); } };
    walk(md.parseList(f.content));
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99'));
}
const eventRow = (e) => h('div', { class: 'event' }, h('span', { class: 'time' }, e.start ? e.start + (e.end ? '–' + e.end : '') : 'All day'), h('span', {}, e.title));
// a dated task with a tick box; `file` is where it lives, `from` whether to name that list under it
function taskRow(x, today, { file = x.path, from = true, extra = null, swipeable = true } = {}) {
  const tomorrow = iso(addDays(new Date(), 1));
  const row = h('div', { class: 'task-row' },
    checkbox(false, () => update(file, (t) => { const f = md.findItem(t, x); return f ? md.toggleItem(t, f.line) : t; })),
    h('span', { class: 'task-text' },
      // the text stays editable wherever a task shows (Today, This week, planning the week)
      textWithVoice(x.text, (v) => { if (v && v !== x.text) update(file, (t) => { const f = md.findItem(t, x); return f ? md.setItemText(t, f.line, v) : t; }); }, 'item-text'),
      from && h('a', { class: 'from' + (x.due && x.due < today ? ' late' : ''), href: fileHref(file) }, (x.time ? `${x.time} · ` : '') + (x.due && x.due < today ? `${dayLabel(x.due)} · ` : '') + (x.repeat ? '↻ ' : '') + (file === INBOX ? 'Filer' : title(file)))),
    extra,
    swipeable && h('button', { class: 'more', 'aria-label': 'Details', onclick: () => openTaskSheet(file, x) }, '···'));
  // inside the sideways-scrolling week a horizontal swipe scrolls the days, so rows there don't swipe
  return swipeable ? swipe(row, {
    left: { label: 'Done', run: () => withUndo('Done', [file], () => update(file, (t) => { const f = md.findItem(t, x); return f ? md.toggleItem(t, f.line) : t; })) },
    right: { label: 'Tomorrow', run: () => withUndo('Moved to tomorrow', [file, THISWEEK], () => setDay(file, x, tomorrow)) },
  }) : row;
}

function dayView() {
  const now = new Date(), today = iso(now);
  const due = dueItems().filter((x) => x.due <= today);
  const evs = calendarEvents().filter((e) => e.date === today).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const late = due.filter((x) => x.due < today).length;
  const questions = vault.exists(QUESTIONS) ? md.countOpen(vault.read(QUESTIONS)) : 0;
  const brief = [
    evs.length ? `${evs.length} in the calendar${evs.find((e) => e.start) ? `, first at ${evs.find((e) => e.start).start}` : ''}` : 'Nothing in the calendar',
    due.length ? `${due.length} to do${late ? `, ${late} from earlier days` : ''}` : 'nothing due',
    questions ? `${questions} question${questions > 1 ? 's' : ''} waiting in the Lab` : '',
  ].filter(Boolean).join(' · ');
  const sunday = [0, 1].includes(now.getDay());
  // Stella's one-line status (System/Health.md): quiet when all is well, loud when it needs you
  const ht = vault.read(HEALTH);
  const health = ht && ht.slice(md.splitFrontmatter(ht).bodyStart).trim().split('\n')[0];
  return h('div', { class: 'page day-page' },
    pageHead('Planner', 'Today', longDate(now)),
    h('p', { class: 'brief' }, brief),
    health && h('p', { class: 'health' + (/^Stella needs you/i.test(health) ? ' alert' : '') }, health),
    sunday && h('a', { class: 'review-link', href: '#/review' }, 'Weekly review →'),
    evs.length > 0 && h('section', { class: 'agenda' }, evs.map(eventRow)),
    due.length > 0 && h('section', { class: 'agenda' }, due.map((x) => taskRow(x, today))),
    !evs.length && !due.length && h('p', { class: 'empty-note' }, 'Nothing for today.'),
    !sunday && h('a', { class: 'review-link quiet-link', href: '#/review' }, 'Weekly review →'));
}

// ---------- weekly review: what got done, what slipped, what waits ----------
function doneItems(since) {
  const out = [];
  for (const f of vault.list()) {
    if (!/\.md$/i.test(f.path) || HIDDEN.includes(section(f.path)) || !f.content?.includes('✅')) continue;
    const walk = (nodes) => { for (const n of nodes) { if (n.kind === 'md') continue; if (n.checked && n.done && n.done >= since) out.push({ ...n, path: f.path }); walk(n.children || []); } };
    walk(md.parseList(f.content));
  }
  return out.sort((a, b) => b.done.localeCompare(a.done));
}
function weeklyReview() {
  const now = new Date(), today = iso(now), since = iso(addDays(now, -7));
  const done = doneItems(since);
  const slipped = dueItems().filter((x) => x.due < today);
  const waiting = md.parseList(vault.read(TASKS) || '').filter((s) => s.kind === 'item' && s.checkbox && !s.checked && !s.due);
  const plain = (x) => h('div', { class: 'task-row' }, h('span', { class: 'task-text' }, h('span', { html: renderInline(vault, x.text) }),
    h('a', { class: 'from', href: fileHref(x.path) }, `${x.done ? dayLabel(x.done) + ' · ' : ''}${title(x.path)}`)));
  return h('div', { class: 'page review-page' },
    pageHead('Planner', 'Weekly review', `since ${dayLabel(since)}`),
    h('section', { class: 'week-day' }, h('div', { class: 'day-head' }, h('span', { class: 'label' }, `Done · ${done.length}`)),
      done.length ? (ui.reviewAll ? done : done.slice(0, 12)).map(plain) : h('div', { class: 'empty' }, '—'),
      done.length > 12 && h('button', { class: 'link', onclick: () => { ui.reviewAll = !ui.reviewAll; renderMain(); } }, ui.reviewAll ? 'Show fewer' : `Show all ${done.length}`)),
    h('section', { class: 'week-day' }, h('div', { class: 'day-head' }, h('span', { class: 'label' }, `Slipped · ${slipped.length}`)),
      slipped.length ? slipped.map((x) => taskRow(x, today)) : h('div', { class: 'empty' }, '—')),
    h('section', { class: 'week-day' }, h('div', { class: 'day-head' }, h('span', { class: 'label' }, `Waiting in General To-Do · ${waiting.length}`)),
      h('p', { class: 'meta' }, 'Still want them? Give the ones for this week a day; delete the rest in General To-Do.'),
      h('a', { class: 'review-link', href: fileHref(THISWEEK), onclick: () => { ui.planWeek = true; } }, 'Plan the week →')));
}

// ---------- people: every mention of someone, across lists, logs and notes ----------
// Notes/People.md lists them, one per line: "- Smo: Smi" (name, then other names for the same person)
function people() {
  return (vault.read(PEOPLE) || '').split('\n').map((l) => l.match(/^\s*[-*]\s+([^:]+?)\s*(?::\s*(.*))?$/)).filter(Boolean)
    .map((m) => ({ name: m[1].trim(), names: [m[1], ...(m[2] || '').split(',')].map((x) => x.trim()).filter(Boolean) }));
}
function personView(name) {
  const p = people().find((x) => x.name === name) || { name, names: [name] };
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\p{L}])(${p.names.map(esc).join('|')})(?![\\p{L}])`, 'u');
  const hits = [];
  for (const f of vault.list()) {
    if (!/\.md$/i.test(f.path) || ['System', 'Backups'].includes(section(f.path)) || f.path === PEOPLE || !f.content) continue;
    const lines = f.content.slice(md.splitFrontmatter(f.content).bodyStart).split('\n').filter((l) => re.test(l));
    if (lines.length) hits.push({ path: f.path, lines });
  }
  const total = hits.reduce((n, x) => n + x.lines.length, 0);
  return h('div', { class: 'page person-page' },
    pageHead('People', p.name, `${total} mention${total === 1 ? '' : 's'}`),
    p.names.length > 1 && h('p', { class: 'meta' }, 'Also: ' + p.names.slice(1).join(', ')),
    hits.map((x) => h('section', { class: 'week-day' },
      h('div', { class: 'day-head' }, h('a', { class: 'label', href: fileHref(x.path) }, title(x.path)), h('span', { class: 'meta' }, String(x.lines.length))),
      x.lines.slice(0, 50).map((l) => h('div', { class: 'mention', html: renderInline(vault, l.replace(/^\s*([-*+]\s+)?(\[[ xX]\]\s+)?|^#+\s+|^\|/g, '').replace(/\s*\|\s*/g, ' · ').trim()) })))),
    !hits.length && h('p', { class: 'empty-note' }, 'No mentions yet.'));
}

// ---------- starred tasks, from every list ----------
function starredItems() {
  const out = [];
  for (const f of vault.list()) {
    if (!/\.md$/i.test(f.path) || ['System', 'Backups'].includes(section(f.path)) || !f.content?.includes('⭐')) continue;
    const walk = (nodes) => { for (const n of nodes) { if (n.kind === 'md') continue; if (n.checkbox && !n.checked && n.starred) out.push({ ...n, path: f.path }); walk(n.children || []); } };
    walk(md.parseList(f.content));
  }
  return out.sort((a, b) => (a.due || '9').localeCompare(b.due || '9'));
}
function starredView() {
  const items = starredItems(), today = iso(new Date());
  return h('div', { class: 'page starred-page' },
    pageHead('Planner', 'Starred', `${items.length} open`),
    items.length ? h('section', { class: 'agenda' }, items.map((x) => taskRow(x, today)))
      : h('p', { class: 'empty-note' }, 'Nothing starred. ☆ in a task\'s details stars it.'));
}

// ---------- tags: #smo, #work anywhere in a line; a page per tag gathers them from every list and note ----------
let tagCache = null;  // rebuilt whenever files change (render())
function tagIndex() {
  if (tagCache) return tagCache;
  const idx = {};  // tag → [{ path, node }] (open tasks and plain lines, not ticked ones)
  for (const f of vault.list()) {
    if (!/\.md$/i.test(f.path) || ['System', 'Backups'].includes(section(f.path)) || !f.content?.includes('#')) continue;
    const walk = (nodes) => { for (const n of nodes) {
      if (n.kind === 'md') continue;
      if (!n.checked) {
        // tags in a link's words or address don't count (a video titled "… #fitness")
        const bare = n.text.replace(/\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|\[\[[^\]]*\]\]/g, ' ');
        for (const m of bare.matchAll(TAG)) { const k = m[2].toLowerCase(); if (!(idx[k] ||= []).some((x) => x.node === n)) idx[k].push({ path: f.path, node: n }); }
      }
      walk(n.children || []);
    } };
    walk(md.parseList(f.content));
  }
  return (tagCache = idx);
}
function tagView(name) {
  const hits = tagIndex()[name] || [], today = iso(new Date());
  const byFile = {};
  for (const x of hits) (byFile[x.path] ||= []).push(x.node);
  const others = Object.entries(tagIndex()).filter(([k]) => k !== name).sort((a, b) => b[1].length - a[1].length);
  return h('div', { class: 'page tag-page' },
    pageHead('Tags', '#' + name, `${hits.length} open`),
    Object.entries(byFile).map(([path, nodes]) => h('section', { class: 'week-day' },
      h('div', { class: 'day-head' }, h('a', { class: 'label', href: fileHref(path) }, path === INBOX ? 'Filer' : title(path)), h('span', { class: 'meta' }, String(nodes.length))),
      nodes.map((n) => n.checkbox ? taskRow({ ...n, path }, today, { from: false })
        : h('div', { class: 'mention', html: renderInline(vault, n.text) })))),
    !hits.length && h('p', { class: 'empty-note' }, `Nothing tagged #${name} yet. Write #${name} anywhere in a card.`),
    others.length > 0 && h('p', { class: 'tag-others' }, others.map(([k, v]) => h('a', { class: 'tag', href: `#/tag/${encodeURIComponent(k)}` }, `#${k} ${v.length}`))));
}

// giving a task a day: General To-Do is the undated backlog, so a task there that gets a day moves into This week
function setDay(file, it, date) {
  if (file === TASKS && date) return moveToWeek(file, it, date);
  update(file, (t) => { const f = md.findItem(t, it); return f ? md.setItemDue(t, f.line, date) : t; });
}

// move a task from another list (Tasks) into This week, with its day
function moveToWeek(from, it, date) {
  const src = vault.read(from) || '';
  const f = md.findItem(src, it); if (!f) return;
  const block = md.extractBlock(src, f);
  block[0] = md.setItemDue(block[0], 0, date);
  update(THISWEEK, (t) => md.insertBlock(t, block, { top: true }));
  update(from, (t) => { const g = md.findItem(t, it); return g ? md.deleteItem(t, g) : t; });
}

function weekView(path, text) {
  const now = new Date(), today = iso(now);
  const days = [...Array(7)].map((_, i) => iso(addDays(now, i)));
  const name = (d, i) => (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : weekday(d));
  const op = (fn) => update(path, fn);
  const due = dueItems(), evs = calendarEvents();
  const open = md.parseList(text).filter((s) => s.kind === 'item' && s.checkbox && !s.checked);
  const dayPick = (onpick) => h('select', { class: 'day-pick', 'aria-label': 'Day', onchange: (e) => e.target.value && onpick(e.target.value) },
    h('option', { value: '' }, 'Day…'), days.map((d, i) => h('option', { value: d }, name(d, i))));
  const later = due.filter((x) => x.due > days[6] && x.path === path);
  const backlog = ui.planWeek ? md.parseList(vault.read(TASKS) || '').filter((s) => s.kind === 'item' && s.checkbox && !s.checked && !s.due) : [];
  return h('div', { class: 'week' },
    h('form', { class: 'add-item', onsubmit: async (e) => {
      e.preventDefault(); const i = $('input', e.target); const raw = i.value.trim();
      if (recording) recording.rec.stop();
      if (voice) {
        // a spoken plan ("Monday … Tuesday …") goes to the Filer as a This week card: once it is text,
        // Stella splits it into one dated task per day
        const now = new Date();
        const name = `Voice ${iso(now)} ${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.${voice.ext}`;
        await vault.write(`attachments/${name}`, voice.blob);
        update(INBOX, (t) => md.addItem(t, ['This week:', raw, `![[${name}]]`].filter(Boolean).join(' '), { top: true }));
        URL.revokeObjectURL(voice.url); voice = null; i.value = ''; renderMain();
        return;
      }
      if (!raw) return;
      const { text: v, due: d } = parseCapture(raw);
      op((t) => md.addItem(t, v + (d ? ` 📅 ${d}` : ''), { top: true }));
      i.value = ''; setTimeout(() => $('.week .add-item input')?.focus(), 30);
    } }, h('span', { class: 'plus' }, '+'), h('input', { type: 'text', placeholder: 'Add to this week, or speak your plan', title: 'MO:, DI:, morgen: … at the start sets the day', enterkeyhint: 'done', autocomplete: 'off', 'data-keep': 'add-week' }),
      recordButton()),
    voice && h('div', { class: 'voice-chip' }, h('audio', { controls: true, src: voice.url }), h('span', { class: 'meta' }, 'becomes tasks for each day it names'),
      h('button', { class: 'link', onclick: () => $('.week .add-item').requestSubmit() }, 'Add')),
    // the week at a glance: a column per day (all seven on the Mac, sideways on the phone)
    h('div', { class: 'week-grid' }, days.map((d, i) => {
      const ts = due.filter((x) => (i === 0 ? x.due <= d : x.due === d));
      const es = evs.filter((e) => e.date === d).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
      return h('section', { class: 'week-col' + (i === 0 ? ' today' : '') },
        h('div', { class: 'day-head' }, h('span', { class: 'label' }, name(d, i)), h('span', { class: 'meta' }, `${+d.slice(8)}.${+d.slice(5, 7)}.`)),
        es.map((e) => h('div', { class: 'wk-event' }, h('span', { class: 'time' }, e.start || 'All day'), h('span', {}, e.title))),
        ts.map((x) => taskRow(x, today, { swipeable: false })),
        !es.length && !ts.length && h('div', { class: 'empty' }, '—'));
    })),
    later.length > 0 && h('section', { class: 'week-day' }, h('div', { class: 'day-head' }, h('span', { class: 'label' }, 'Later')), later.map((x) => taskRow(x, today))),
    open.some((s) => !s.due) && h('section', { class: 'week-day' },
      h('div', { class: 'day-head' }, h('span', { class: 'label' }, 'No day yet')),
      open.filter((s) => !s.due).map((it) => taskRow(it, today, { file: path, from: false,
        extra: dayPick((d) => op((t) => { const f = md.findItem(t, it); return f ? md.setItemDue(t, f.line, d) : t; })) }))),
    h('button', { class: 'new-entry', onclick: () => { ui.planWeek = !ui.planWeek; renderMain(); } }, ui.planWeek ? 'Done planning' : 'Plan the week: pick from General To-Do'),
    ui.planWeek && h('section', { class: 'plan' },
      backlog.length ? backlog.map((it) => taskRow(it, today, { file: TASKS, from: false, extra: dayPick((d) => moveToWeek(TASKS, it, d)) }))
        : h('p', { class: 'meta' }, 'General To-Do has nothing without a day.')));
}

// ---------- calendar: a read-only mirror of your calendars (System/Calendar.md, refreshed hourly on GitHub) ----------
function calendarEvents() {
  const out = [];
  for (const l of (vault.read(CALENDAR) || '').split('\n')) {
    const m = l.match(/^-\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2})(?:\s*[–-]\s*(\d{1,2}:\d{2}))?)?\s+(.+)$/);
    if (m) out.push({ date: m[1], start: m[2], end: m[3], title: m[4] });
  }
  return out;
}

function calendarView() {
  const text = vault.read(CALENDAR);
  const updated = text && md.splitFrontmatter(text).data.updated;
  const today = iso(new Date());
  const evs = calendarEvents().filter((e) => e.date >= today)
    .sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
  const months = new Map();
  for (const e of evs) {
    const days = months.get(e.date.slice(0, 7)) || months.set(e.date.slice(0, 7), new Map()).get(e.date.slice(0, 7));
    (days.get(e.date) || days.set(e.date, []).get(e.date)).push(e);
  }
  const monthName = (ym) => new Date(+ym.slice(0, 4), +ym.slice(5) - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  return h('div', { class: 'page calendar-page' },
    pageHead('Planner', 'Calendar', updated ? `updated ${updated.slice(11) || updated}` : ''),
    !evs.length && h('p', { class: 'empty-note' }, text == null ? 'No calendar connected yet.' : 'Nothing coming up.'),
    [...months].map(([ym, days]) => h('section', { class: 'cal-month' },
      h('h2', { class: 'label big' }, monthName(ym)),
      [...days].map(([d, list]) => h('div', { class: 'cal-day' + (d === today ? ' today' : '') },
        h('div', { class: 'cal-date' }, h('span', { class: 'cal-dnum' }, String(+d.slice(8))), h('span', { class: 'meta' }, dayLabel(d))),
        h('div', { class: 'cal-events' }, list.map((e) => h('div', { class: 'event' },
          h('span', { class: 'time' }, e.start ? e.start + (e.end ? '–' + e.end : '') : 'All day'),
          h('span', {}, e.title)))))))));
}

// ---------- journal: write or speak an entry; it lands under today's date (voice becomes text on GitHub) ----------
function journalBox() {
  return h('form', { class: 'capture journal-box', onsubmit: async (e) => {
    e.preventDefault();
    const input = $('textarea', e.target);
    let entry = input.value.trim();
    if (recording) recording.rec.stop();
    if (!entry && !voice) return;
    const now = new Date();
    if (voice) {
      const name = `Voice ${iso(now)} ${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.${voice.ext}`;
      await vault.write(`attachments/${name}`, voice.blob);
      entry = [entry, `![[${name}]]`].filter(Boolean).join(' ');
      URL.revokeObjectURL(voice.url); voice = null;
    }
    const heading = `## ${longDate(now)} ${now.getFullYear()}`;
    update(JOURNAL, (t) => {
      const fm = md.splitFrontmatter(t), head = t.slice(0, fm.bodyStart), body = t.slice(fm.bodyStart).replace(/^\n+/, '');
      const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const line = `**${stamp}** ${entry}`;
      return body.startsWith(heading)
        ? head + heading + '\n\n' + line + '\n\n' + body.slice(heading.length).replace(/^\n+/, '')
        : head + heading + '\n\n' + line + '\n\n' + body;
    });
    input.value = '';
    redrawCapture();
  } },
    h('textarea', { rows: 3, placeholder: 'Write or speak today’s entry.', 'data-keep': 'journal' }),
    voice && h('div', { class: 'voice-chip' }, h('audio', { controls: true, src: voice.url }), h('span', { class: 'meta' }, 'becomes text')),
    h('div', { class: 'capture-tools' }, h('span', { class: 'hint' }, ''), recordButton(), h('button', { type: 'submit', class: 'add-card' }, 'Add')));
}

// ---------- sorting one by one: one item at a time, big; done, file, delete or skip ----------
function sortView(path) {
  const text = vault.read(path);
  if (text == null) return h('div', { class: 'page' }, pageHead('', 'Not found'));
  const skip = (ui.sortSkip ||= {})[path] ||= [];
  const open = md.parseList(text).filter((s) => s.kind === 'item' && !s.checked);
  const it = open.find((s) => !skip.includes(s.text));
  const left = open.filter((s) => !skip.includes(s.text)).length;
  const back = path === INBOX ? '#/' : fileHref(path);
  const next = () => renderMain();
  if (!it) return h('div', { class: 'page sort-page' }, pageHead('Sorting', path === INBOX ? 'Filer' : title(path), ''),
    h('p', { class: 'empty-note' }, skip.length ? `All sorted, ${skip.length} skipped.` : 'All sorted.'),
    skip.length > 0 && h('button', { class: 'review-link', onclick: () => { ui.sortSkip[path] = []; next(); } }, 'Go through the skipped ones'),
    h('p', {}, h('a', { class: 'review-link', href: back }, 'Back →')));
  const act = (label, fn) => h('button', { class: 'sort-btn', onclick: fn }, label);
  const card = swipe(h('div', { class: 'sort-card' },
    h('div', { class: 'sort-text', html: renderInline(vault, it.text) }),
    it.due && h('div', { class: 'meta' }, dayLabel(it.due)),
    it.notes.length > 0 && h('div', { class: 'notes-block' }, it.notes.map((n) => h('p', { html: renderInline(vault, n.text) }))),
    it.children.length > 0 && h('div', { class: 'meta' }, `${it.children.length} sub-item${it.children.length > 1 ? 's' : ''} go with it`)), {
    left: { label: 'Done', run: () => withUndo('Done', [path], () => update(path, (t) => { const f = md.findItem(t, it); return f ? md.toggleItem(t, f.line) : t; })) },
    right: { label: 'File', run: () => openMoveSheet(path, it) },
  });
  return h('div', { class: 'page sort-page' },
    pageHead('Sorting', path === INBOX ? 'Filer' : title(path), `${left} left`),
    card,
    h('div', { class: 'sort-actions' },
      act('File into…', () => openMoveSheet(path, it)),
      act('Done', () => withUndo('Done', [path], () => update(path, (t) => { const f = md.findItem(t, it); return f ? md.toggleItem(t, f.line) : t; }))),
      act('Skip', () => { skip.push(it.text); next(); }),
      act('Delete', () => withUndo('Deleted', [path], () => update(path, (t) => { const f = md.findItem(t, it); return f ? md.deleteItem(t, f) : t; })))),
    h('p', { class: 'meta sort-hint' }, 'Swipe left for done, right to file it.'),
    h('a', { class: 'review-link quiet-link', href: back }, 'Stop sorting'));
}

// ---------- Recent: what changed lately, and who did it (from the vault's history) ----------
let recentCache = null;
const SOURCE = [[/^(Update|Add|Delete) /, 'You'], [/^Filed from the board/, 'Filer'], [/^Voice notes transcribed/, 'Voice'], [/^Nightly/, 'Nightly'],
  [/^Calendar/, 'Calendar'], [/^(Mac |Update from Mac)/, 'Mac: Stella and Claude']];
const sourceOf = (msg) => (SOURCE.find(([re]) => re.test(msg)) || [0, 'Other'])[1];
// a commit's patch → what happened to items: added (+), ticked (✓), removed (−)
function changesIn(files) {
  const out = [];
  for (const f of files || []) {
    const p = f.filename || '';
    if (/^System\/(Activity|Calendar|Health|link-titles)|^\.github\//.test(p)) continue;
    if (/^attachments\//.test(p)) { if (/Voice /.test(p)) continue; out.push({ path: p, lines: [['+', p.split('/').pop()]] }); continue; }
    if (!/\.md$/.test(p)) continue;
    const core = (l) => { const m = l.match(/^\s*[-*] (?:\[([ xX])\] )?(.*?)(?:\s+📅\s*\S+)?(?:\s+✅\s*\S+)?\s*$/); return m ? { done: /[xX]/.test(m[1] || ''), box: !!m[1], text: m[2] } : null; };
    const plus = [], minus = [];
    for (const l of (f.patch || '').split('\n')) {
      if (/^\+(?!\+\+ )/.test(l)) { const c = core(l.slice(1)); if (c && c.text) plus.push(c); }
      if (/^-(?!-- )/.test(l)) { const c = core(l.slice(1)); if (c && c.text) minus.push(c); }
    }
    const lines = [];
    for (const c of plus) {
      const was = minus.find((x) => x.text === c.text);
      if (was) { if (c.done && !was.done) lines.push(['✓', c.text]); was.used = true; }
      else lines.push(['+', c.text]);
    }
    for (const c of minus) if (!c.used) lines.push(['−', c.text]);
    if (lines.length) out.push({ path: p, lines });
  }
  return out;
}
async function loadRecent() {
  const b = vault.backend;
  if (!b?.history) { recentCache = { error: 'Recent needs the connection to GitHub.' }; return; }
  try {
    const list = await b.history(40);
    const top = list.slice(0, 25);
    const details = await Promise.all(top.map((c) => b.commit(c.sha).catch(() => null)));
    recentCache = { at: Date.now(), items: top.map((c, i) => ({ msg: c.commit.message.split('\n')[0], at: c.commit.author?.date || c.commit.committer?.date, changes: changesIn(details[i]?.files) })) };
  } catch (e) { recentCache = { error: e.message }; }
  if (route().view === 'recent') renderMain();
}
function recentView() {
  if (!recentCache || Date.now() - (recentCache.at || 0) > 60000) { if (!recentCache?.loading) { recentCache = { ...(recentCache || {}), loading: true }; loadRecent(); } }
  const items = (recentCache?.items || []).filter((x) => x.changes.length);
  // consecutive changes from the same source within 15 minutes read as one moment
  const blocks = [];
  for (const it of items) {
    const last = blocks.at(-1), src = sourceOf(it.msg);
    if (last && last.src === src && Math.abs(new Date(last.at) - new Date(it.at)) < 15 * 60000) { last.changes.push(...it.changes); last.at = it.at; }
    else blocks.push({ src, at: it.at, first: it.at, changes: [...it.changes] });
  }
  const time = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = new Map();
  for (const b of blocks) { const d = iso(new Date(b.first)); (days.get(d) || days.set(d, []).get(d)).push(b); }
  const merged = (changes) => { const byPath = new Map(); for (const c of changes) byPath.set(c.path, [...(byPath.get(c.path) || []), ...c.lines]); return [...byPath]; };
  return h('div', { class: 'page recent-page' },
    pageHead('Planner', 'Recent', recentCache?.loading ? 'Loading…' : ''),
    recentCache?.error && h('p', { class: 'empty-note' }, recentCache.error),
    !recentCache?.error && !items.length && !recentCache?.loading && h('p', { class: 'empty-note' }, 'Nothing has changed lately.'),
    [...days].map(([d, bs]) => h('section', { class: 'week-day' },
      h('div', { class: 'day-head' }, h('span', { class: 'label' }, dayLabel(d))),
      bs.map((b) => h('div', { class: 'moment' },
        h('div', { class: 'moment-head' }, h('span', { class: 'time' }, time(b.first)), h('span', { class: 'who' }, b.src)),
        merged(b.changes).map(([p, lines]) => h('div', { class: 'moment-file' },
          /\.md$/.test(p) ? h('a', { class: 'from', href: fileHref(p) }, title(p)) : h('span', { class: 'from' }, 'attachment'),
          lines.slice(0, 6).map(([k, t]) => h('div', { class: 'change' }, h('span', { class: 'mark' }, k), h('span', { html: renderInline(vault, t) }))),
          lines.length > 6 && h('div', { class: 'meta' }, `and ${lines.length - 6} more`))))))));
}

// ---------- Today: the board ----------
function todayView() {
  const now = new Date();
  const inbox = vault.read(INBOX) || '';
  const items = md.parseList(inbox).filter((s) => s.kind === 'item');
  const open = items.filter((s) => !s.checked);
  const done = items.filter((s) => s.checked);



  const targets = vault.list().map((f) => f.path).filter((p) => /\.md$/i.test(p) && ['Lists', 'Notes'].includes(section(p))).sort(byOrder);
  const card = (it) => swipe(h('article', { class: 'card' },
    textWithVoice(it.text, (v) => { if (v && v !== it.text) update(INBOX, (t) => { const f = md.findItem(t, it); return f ? md.setItemText(t, f.line, v) : t; }); }, 'card-text'),
    it.notes.length > 0 && h('div', { class: 'card-notes' }, it.notes.map((n) => n.text).join(' ')),
    h('div', { class: 'card-foot' },
      h('span', { class: 'card-due' }, it.due ? dayLabel(it.due, now) : ''),
      h('span', { class: 'card-actions' },
        h('button', { onclick: (e) => { const toggle = () => update(INBOX, (t) => { const f = md.findItem(t, it); return f ? md.toggleItem(t, f.line) : t; }); fallAway(e.currentTarget.closest('.card'), () => { toggle(); toast('Done', toggle); }); } }, 'Done'),
        h('label', { class: 'file-to' }, 'File',
          h('select', { onchange: (e) => fileAway(it, e.target.value) },
            h('option', { value: '' }, 'File under…'),
            ['Lists', 'Notes'].map((s) => h('optgroup', { label: s }, targets.filter((p) => section(p) === s).map((p) => h('option', { value: p }, title(p))))))),
        h('button', { class: 'quiet', onclick: () => update(INBOX, (t) => { const f = md.findItem(t, it); return f ? md.deleteItem(t, f) : t; }) }, '×')))), {
    left: { label: 'Done', run: () => withUndo('Done', [INBOX], () => update(INBOX, (t) => { const f = md.findItem(t, it); return f ? md.toggleItem(t, f.line) : t; })) },
    right: { label: 'File', run: () => openMoveSheet(INBOX, it) },
  });

  const questions = vault.exists(QUESTIONS) ? md.countOpen(vault.read(QUESTIONS)) : 0;
  return h('div', { class: 'page today-page' },
    pageHead('Filer', longDate(now), `${open.length} on the board`),
    !open.length && h('button', { class: 'empty-note filer-empty', onclick: () => openQuickAdd() }, 'The Filer is empty. Write something down →'),
    (questions > 0 || open.length > 1) && h('div', { class: 'filer-links' },
      questions > 0 && h('a', { href: '#/lab' }, `${questions} question${questions === 1 ? '' : 's'} →`),
      open.length > 1 && h('a', { href: `#/sort/${encodeURIComponent(INBOX)}` }, 'Sort one by one →')),
    h('div', { class: 'board' }, open.map(card)),
    done.length > 0 && h('div', { class: 'board-done' }, `${done.length} done · `,
      h('button', { class: 'link', onclick: () => update(INBOX, (t) => { let x = t; for (const it of [...md.parseList(t)].filter((s) => s.kind === 'item' && s.checked).reverse()) x = md.deleteItem(x, it); return x; }) }, 'clear')));
}

function fileAway(it, target) {
  if (!target) return;
  const inbox = vault.read(INBOX);
  const f = md.findItem(inbox, it); if (!f) return;
  const block = md.extractBlock(inbox, f);
  const isList = md.fileType(target, vault.read(target) || '') === 'list';
  update(target, (t) => md.insertBlock(t, block, { top: isList }));
  update(INBOX, (t) => md.deleteItem(t, f));
}

// a ticked row falls away (tick, strike, fade, fold), as in Google Tasks; then the change is saved, with Undo
function fallAway(row, run) {
  if (!row || matchMedia('(prefers-reduced-motion: reduce)').matches) { run(); return; }
  row.classList.add('completing');
  setTimeout(() => { row.style.height = `${row.offsetHeight}px`; void row.offsetHeight; row.classList.add('collapsing'); }, 360);
  setTimeout(run, 600);
}
function checkbox(checked, onclick, plain = false) {
  return h('button', { class: 'check' + (checked ? ' on' : '') + (plain ? ' plain' : ''), 'aria-label': checked ? 'Mark not done' : 'Mark done', role: 'checkbox', 'aria-checked': String(checked),
    onclick: (e) => {
      if (checked) { onclick(e); return; }
      const btn = e.currentTarget;
      btn.classList.add('on'); btn.setAttribute('aria-checked', 'true');
      // ticking again toggles back, so Undo is the same action once more
      fallAway(btn.closest('.item, .task-row, .card'), () => { onclick(e); toast('Done', () => onclick(e)); });
    } });
}

// ---------- file views ----------
function fileView(path) {
  const text = vault.read(path);
  if (text == null) return h('div', { class: 'page' }, pageHead('', 'Not found'), h('p', { class: 'meta' }, path));
  const type = md.fileType(path, text);
  const body = ui.editing === path ? editorView(path, text)
    : path === THISWEEK ? weekView(path, text)
    : path === JOURNAL ? [journalBox(), noteView(path, text)]
    : type === 'list' ? listView(path, text)
    : type === 'tracker' ? trackerView(path, text)
    : noteView(path, text);
  return h('div', { class: `page ${type}-page` },
    pageHead(path === RULES ? 'Lab' : area(path) === 'planner' ? 'Planner' : section(path) || 'Vault', title(path),
      type === 'note' || ui.editing === path
        ? h('button', { class: 'edit-top', onclick: () => { ui.editing = ui.editing === path ? null : path; renderMain(); } }, ui.editing === path ? 'Done' : 'Edit')
        : type === 'list' && /^\s*[-*+] \[[ xX]\]/m.test(text) ? `${md.countOpen(text)} open` : ''),
    body, path !== RULES && fileActions(path, type));
}

function fileActions(path, type) {
  const editing = ui.editing === path;
  return h('footer', { class: 'file-actions' },
    type === 'list' && h('a', { href: `#/sort/${encodeURIComponent(path)}` }, 'Sort one by one'),
    h('button', { onclick: () => { ui.editing = editing ? null : path; renderMain(); } }, editing ? 'Done editing' : 'Edit text'),
    h('button', { onclick: async () => {
      const name = prompt('Rename', stem(path)); if (!name?.trim() || name === stem(path)) return;
      const to = (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '') + name.trim().replace(/[\\/:]/g, '-') + '.md';
      try { await vault.rename(path, to); location.hash = fileHref(to); } catch (e) { alert(e.message); }
    } }, 'Rename'),
    type === 'list' && h('button', { onclick: () => setArea(path, area(path) === 'planner' ? 'lists' : 'planner') },
      area(path) === 'planner' ? 'To Lists' : 'To Planner'),
    h('label', { class: 'move' }, 'Move',
      h('select', { onchange: async (e) => {
        const to = `${e.target.value}/${path.split('/').pop()}`;
        try { await vault.rename(path, to); location.hash = fileHref(to); } catch (err) { alert(err.message); }
      } }, h('option', { value: '' }, 'Move to…'), [...SECTIONS, 'Archive'].filter((s) => s !== section(path)).map((s) => h('option', { value: s }, s)))),
    h('button', { class: 'danger', onclick: async () => {
      if (!confirm(`Delete “${title(path)}”? It stays in the repository history.`)) return;
      await vault.remove(path); location.hash = '#/';
    } }, 'Delete'));
}

function editorView(path, text) {
  let timer;
  const ta = h('textarea', { class: 'editor', spellcheck: true, value: text,
    oninput: (e) => { clearTimeout(timer); const v = e.target.value; timer = setTimeout(() => vault.write(path, v), 500); },
    onblur: (e) => { clearTimeout(timer); vault.write(path, e.target.value); } });
  ta.value = text;
  requestAnimationFrame(() => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  return ta;
}

// a note reads as formatted text and is edited as formatted text, one block (paragraph, heading, list) at a time;
// only an edited block is turned back into Markdown, so the rest of the file stays exactly as written.
// "Edit" shows the Markdown itself; tables and code are edited there.
const EDITABLE = new Set(['paragraph', 'heading', 'list', 'blockquote']);
function noteView(path, text) {
  const start = md.splitFrontmatter(text).bodyStart, body = text.slice(start);
  const blocks = noteBlocks(body);
  if (!blocks) return h('article', { class: 'prose', html: renderMarkdown(vault, body) });  // (never seen: a note the splitter can't take apart)
  // save one block: its new Markdown replaces its old Markdown in the file as it is now
  const save = (i, md2) => {
    const old = blocks[i].raw, tail = old.match(/\s*$/)[0];
    const next = md2.trim() ? md2.trim() + tail : '';
    if (next === old) return;
    const at = blocks.slice(0, i).reduce((n, b) => n + b.raw.length, start);
    update(path, (t) => t.slice(at, at + old.length) === old ? t.slice(0, at) + next + t.slice(at + old.length)
      : t.includes(old) ? t.replace(old, next) : t + (t.endsWith('\n') ? '' : '\n') + next);
  };
  const blockEl = (b, i) => {
    if (b.type === 'space') return null;
    const el = h('div', { class: 'blk', html: renderMarkdown(vault, b.raw, body) });
    if (!EDITABLE.has(b.type)) return el;
    return editableBlock(el, (v) => save(i, v));
  };
  const els = blocks.map(blockEl).filter(Boolean);
  // a last, empty line to write on (and the whole note, when it is empty)
  els.push(editableBlock(h('div', { class: 'blk blk-new', 'data-placeholder': body.trim() ? '' : 'Write…' }), (v) => {
    if (!v.trim()) return;
    update(path, (t) => t.replace(/\s*$/, '') + (t.trim() ? '\n\n' : '') + v.trim() + '\n');
  }));
  const el = h('article', { class: 'prose note-edit' }, els);
  const lines = md.taskLines(text);
  el.querySelectorAll('input[type=checkbox]').forEach((box, i) => {
    box.disabled = false; box.contentEditable = 'false';
    box.addEventListener('change', () => update(path, (t) => md.toggleItem(t, lines[i])));
  });
  return el;
}
// one block of a note, editable in place; links open on a tap while it isn't being edited
function editableBlock(el, save) {
  let before = null;
  el.contentEditable = 'true';
  el.spellcheck = true;
  el.addEventListener('mousedown', (e) => {
    const a = e.target.closest('a');
    if (a && document.activeElement !== el) { e.preventDefault(); a.target === '_blank' || /^https?:/.test(a.href) ? open(a.href, '_blank', 'noopener') : (location.hash = a.getAttribute('href')); }
  });
  el.addEventListener('focus', () => { before = el.innerHTML; });
  el.addEventListener('blur', () => { if (before !== null && el.innerHTML !== before) save(blockToMarkdown(el)); before = null; });
  // pasted text comes in plain (formatting from web pages would turn into odd Markdown)
  el.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
  return el;
}
// leaving the app while writing saves what was written
document.addEventListener('visibilitychange', () => { if (document.hidden && document.activeElement?.classList?.contains('blk')) document.activeElement.blur(); });

// an item's text: formatted when reading, raw Markdown while editing; links open on tap
function editableText(raw, save, cls = 'item-text') {
  const el = h('div', { class: cls, contenteditable: 'plaintext-only', spellcheck: false, html: renderInline(vault, raw),
    onmousedown: (e) => {
      const a = e.target.closest('a');
      if (a && document.activeElement !== el) { e.preventDefault(); a.target === '_blank' || /^https?:/.test(a.href) ? open(a.href, '_blank', 'noopener') : (location.hash = a.getAttribute('href')); }
    },
    onfocus: () => { el.textContent = raw; },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } },
    onblur: () => { const v = el.textContent.trim(); if (v === raw) el.innerHTML = renderInline(vault, raw); save(v); } });
  return el;
}

// ---------- lists ----------
let expanded = null;
function listView(path, text) {
  const segs = md.parseList(text);
  const showDone = !!ui.showDone[path];
  const op = (fn) => update(path, fn);
  const at = (it, fn) => op((t) => { const f = md.findItem(t, it); return f ? fn(t, f) : t; });

  const selecting = !!ui.selecting?.[path];
  const sel = (ui.selected ||= {})[path] ||= {};
  const row = (it, depth = 0) => {
    const key = `${path}:${it.line}:${it.text}`;
    const isOpen = expanded === key;
    if (selecting) {  // select mode: tap rows to pick them, then act on all at once
      const on = !!sel[it.text];
      return h('div', { class: 'item' + (on ? ' selected' : ''), style: depth ? `margin-left:${depth * 28}px` : null },
        h('button', { class: 'item-row select-row', onclick: () => { if (on) delete sel[it.text]; else sel[it.text] = true; renderMain(); } },
          h('span', { class: 'sel' + (on ? ' on' : '') }), h('span', { class: 'item-text', html: renderInline(vault, it.text) })),
        it.children.filter((c) => !c.checked || !c.checkbox).map((c) => row(c, depth + 1)));
    }
    const lift = !it.checked && { start: (x, y) => liftRow(path, it, el, x, y), move: moveDrag, end: endDrag };
    const el = h('div', { class: 'item' + (it.checked ? ' done' : '') + (isOpen ? ' expanded' : ''), style: depth ? `margin-left:${depth * 28}px` : null },
      swipe(h('div', { class: 'item-row' },
        lift && dragGrip(lift.start),
        it.checkbox ? checkbox(it.checked, () => at(it, (t, f) => md.toggleItem(t, f.line))) : /\d/.test(it.marker) ? h('span', { class: 'bullet' }, it.marker) : h('span', { class: 'bullet dot' }),
        h('div', { class: 'item-main' },
          textWithVoice(it.text, (v) => { if (!v) at(it, (t, f) => md.deleteItem(t, f)); else if (v !== it.text) at(it, (t, f) => md.setItemText(t, f.line, v)); }),
          (it.due || it.notes.length > 0) && h('div', { class: 'item-sub' },
            it.due && h('span', { class: 'due' + (it.due < iso(new Date()) && !it.checked ? ' late' : '') }, dayLabel(it.due) + (it.time ? ' ' + it.time : '') + (it.repeat ? ' ↻' : '')),
            // long notes (summaries) each on their own line; short ones run together
            it.notes.length > 0 && (it.notes.some((n) => n.text.length > 80)
              ? h('div', { class: 'notes notes-block' }, it.notes.map((n) => h('p', { html: renderInline(vault, n.text) })))
              : h('span', { class: 'notes', html: renderInline(vault, it.notes.map((n) => n.text).join(' · ')) })))),
        it.starred && h('button', { class: 'star-mark', 'aria-label': 'Unstar', onclick: () => at(it, (t, f) => md.setItemFields(t, f.line, { starred: false })) }, '★'),
        h('button', { class: 'more', 'aria-label': 'Details', onclick: () => openTaskSheet(path, it) }, '···')), {
        left: it.checkbox ? (it.checked
          ? { label: 'Delete', run: () => withUndo('Deleted', [path], () => at(it, (t, f) => md.deleteItem(t, f))) }
          : { label: 'Done', run: () => withUndo('Done', [path], () => at(it, (t, f) => md.toggleItem(t, f.line))) }) : null,
        right: { label: 'File', run: () => openMoveSheet(path, it) },
        hold: { run: () => { (ui.selecting ||= {})[path] = true; ui.selected[path] = { [it.text]: true }; renderMain(); } },
        lift: lift || null,
      }),
      // ticked sub-tasks leave their parent for Completed (as in Google Tasks), unless the parent is done too
      it.children.filter((c) => !c.checked || !c.checkbox || it.checked).map((c) => row(c, depth + 1)));
    el.dataset.depth = depth; el._it = it;  // for dragging
    return el;
  };

  const live = [], done = [], doneSubs = [];
  const gather = (it) => { for (const c of it.children || []) { if (c.checkbox && c.checked) doneSubs.push({ c, parent: it.text }); else gather(c); } };
  for (const s of segs) {
    if (s.kind === 'md') live.push(h('div', { class: 'prose list-prose', html: renderMarkdown(vault, s.text) }));
    else if (s.checked) done.push(s);
    else { live.push(row(s)); gather(s); }
  }
  const nDone = done.length + doneSubs.length;
  const hasCheckboxes = segs.some((s) => s.kind === 'item' && s.checkbox) || !segs.some((s) => s.kind === 'item');

  return h('div', { class: 'list' },
    h('form', { class: 'add-item', onsubmit: (e) => {
      e.preventDefault(); const i = $('input', e.target); const raw = i.value.trim(); if (!raw) return;
      const { text: v, due } = parseCapture(raw);
      op((t) => md.addItem(t, v + (due ? ` 📅 ${due}` : ''), { top: true, checkbox: hasCheckboxes }));
      i.value = ''; setTimeout(() => $('.add-item input')?.focus(), 30);
    } }, h('span', { class: 'plus' }, '+'), h('input', { type: 'text', placeholder: hasCheckboxes ? 'Add a task' : 'Add an item', enterkeyhint: 'done', autocomplete: 'off', 'data-keep': 'add-item' }),
      h('button', { type: 'button', class: 'select-toggle', onclick: () => { (ui.selecting ||= {})[path] = !selecting; ui.selected[path] = {}; renderMain(); } }, selecting ? 'Cancel' : 'Select')),
    live,
    selecting && h('div', { class: 'select-bar' },
      h('span', {}, `${Object.keys(sel).length} selected`),
      h('button', { onclick: () => { const items = pickSelected(path, sel); if (items.length) openMoveSheet(path, items[0], items); } }, 'File into…'),
      h('button', { onclick: () => { const items = pickSelected(path, sel); withUndo(`${items.length} done`, [path], () => { for (const x of items) update(path, (t) => { const f = md.findItem(t, x); return f && !f.checked ? md.toggleItem(t, f.line) : t; }); }); ui.selected[path] = {}; renderMain(); } }, 'Done'),
      h('button', { class: 'danger', onclick: () => { const items = pickSelected(path, sel); withUndo(`${items.length} deleted`, [path], () => { for (const x of items) update(path, (t) => { const f = md.findItem(t, x); return f ? md.deleteItem(t, f) : t; }); }); ui.selected[path] = {}; renderMain(); } }, 'Delete'),
      h('button', { class: 'sel-close', 'aria-label': 'Stop selecting', onclick: () => { ui.selecting[path] = false; ui.selected[path] = {}; renderMain(); } }, '×')),
    nDone > 0 && h('div', { class: 'completed' },
      h('button', { class: 'completed-head', onclick: () => { ui.showDone[path] = !showDone; saveUi(); renderMain(); } },
        h('span', { class: 'label' }, `Completed · ${nDone}`), h('span', { class: 'caret' }, showDone ? '–' : '+')),
      showDone && done.map((s) => row(s)),
      showDone && doneSubs.map(({ c, parent }) => h('div', { class: 'done-sub' },
        h('div', { class: 'meta' }, 'in ' + parent.replace(/[*_`[\]]/g, '').slice(0, 60)), row(c))),
      showDone && h('button', { class: 'link clear-done', onclick: () => {
        if (!confirm(`Delete ${nDone} completed?`)) return;
        op((t) => {
          // one at a time from the bottom, re-reading after each, so nested ones stay in step
          const lastDone = (nodes) => nodes.reduce((hit, n) => (n.kind === 'item' && lastDone(n.children || [])) || (n.kind === 'item' && n.checkbox && n.checked ? n : null) || hit, null);
          let x = t, it;
          while ((it = lastDone(md.parseList(x)))) x = md.deleteItem(x, it);
          return x;
        });
      } }, 'Clear completed')));
}

// the items picked in select mode, as they are in the file now
function pickSelected(path, sel) {
  const out = [];
  const walk = (nodes) => { for (const n of nodes) { if (n.kind === 'item' && sel[n.text]) out.push(n); walk(n.children || []); } };
  walk(md.parseList(vault.read(path) || ''));
  return out;
}

// ---------- trackers ----------
const isDateCol = (c) => /^(date|datum|day of|tag)$/i.test(c.trim()) || /date|datum/i.test(c);
const isWeekdayCol = (c) => /^(weekday|wochentag|day|tag)$/i.test(c.trim());
const WD_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function trackerView(path, text) {
  const tables = md.parseTables(text);
  const op = (fn) => update(path, fn);
  const intro = text.slice(md.splitFrontmatter(text).bodyStart).split('\n').filter((l) => !/^\s*\|/.test(l) && !/^#/.test(l)).join('\n').trim();
  if (!tables.length) {
    return h('div', {}, intro && h('div', { class: 'prose', html: renderMarkdown(vault, intro) }),
      h('button', { class: 'link', onclick: () => {
        const cols = prompt('Columns, separated by commas', 'Date, Note'); if (!cols) return;
        const c = cols.split(',').map((s) => s.trim()).filter(Boolean);
        op((t) => t.trimEnd() + `\n\n${md.joinRow(c)}\n${md.joinRow(c.map(() => '---'))}\n`);
      } }, 'Start a table'));
  }
  return h('div', { class: 'tracker' },
    intro && h('div', { class: 'prose', html: renderMarkdown(vault, intro) }),
    tables.map((tb, ti) => trackerTable(path, tb, ti, tables.length)));
}

function trackerTable(path, tb, ti, nTables) {
  const op = (fn) => update(path, fn);
  const dateIdx = tb.header.findIndex(isDateCol);
  const wdIdx = tb.header.findIndex(isWeekdayCol);
  const now = new Date(), y = String(now.getFullYear()), ym = iso(now).slice(0, 7);
  const dates = new Set(tb.rows.map((r) => r.cells[dateIdx]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '')));
  const ds = [...dates];
  // standing payments: with an Amount and a Cycle column, show what it all costs
  const amtIdx = tb.header.findIndex((c) => /^(amount|betrag|price|preis|cost|kosten)$/i.test(c.trim()));
  const cycIdx = tb.header.findIndex((c) => /^(cycle|interval|rhythmus|turnus)$/i.test(c.trim()));
  const PER_MONTH = { daily: 30.44, weekly: 4.35, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12, annually: 1 / 12,
    täglich: 30.44, wöchentlich: 4.35, monatlich: 1, quartalsweise: 1 / 3, jährlich: 1 / 12 };
  let costs = null;
  if (amtIdx >= 0 && cycIdx >= 0) {
    let month = 0, cur = '';
    for (const r of tb.rows) {
      const m = (r.cells[amtIdx] || '').match(/([A-Za-z€$£]*)\s*([\d'.,]+)/);
      const f = PER_MONTH[(r.cells[cycIdx] || '').trim().toLowerCase()];
      if (!m || !f) continue;
      cur ||= m[1];
      month += Number(m[2].replace(/'/g, '').replace(',', '.')) * f;
    }
    const fmt = (n) => `${cur ? cur + ' ' : ''}${n.toFixed(2)}`;
    costs = [['Per month', fmt(month)], ['Per year', fmt(month * 12)]];
  }
  const stats = costs || dateIdx >= 0 && [
    ['This month', ds.filter((d) => d.startsWith(ym)).length],
    ['This year', ds.filter((d) => d.startsWith(y)).length],
    ['All', ds.length],
  ];

  // prefill: today's date, its weekday (in the language the column already uses), next running number
  const last = tb.rows.at(-1)?.cells || [];
  const german = tb.rows.some((r) => WD_DE.includes(r.cells[wdIdx]));
  const prefill = tb.header.map((c, i) => {
    if (i === dateIdx) return iso(now);
    if (i === wdIdx) return german ? WD_DE[now.getDay()] : weekday(iso(now));
    const nums = tb.rows.map((r) => Number(r.cells[i])).filter((n) => Number.isInteger(n) && n > 0);
    if (nums.length > 3 && nums.length >= tb.rows.length * 0.4 && /^(#|nr\.?|no\.?|amount|count|n)$/i.test(c.trim())) {
      // a second row for the same day (e.g. the other person) keeps the session number
      return last[dateIdx] === iso(now) && last[i] ? last[i] : String(Math.max(...nums) + 1);
    }
    return '';
  });
  const formKey = `${path}#${ti}`;
  const entryOpen = !!ui.entryOpen?.[formKey];
  const toggleEntry = () => { (ui.entryOpen ||= {})[formKey] = !entryOpen; saveUi(); renderMain(); };
  const form = entryOpen ? h('form', { class: 'entry', onsubmit: (e) => {
    e.preventDefault();
    const cells = [...e.target.querySelectorAll('input')].map((i) => i.value.trim());
    // only the prefilled date, weekday and number: nothing to add yet
    if (!cells.some((c, i) => c && c !== prefill[i])) return;
    op((t) => { const fresh = md.parseTables(t)[ti]; return fresh ? md.addRow(t, fresh, cells) : t; });
    ui.entryOpen[formKey] = false; saveUi();
  } },
    h('div', { class: 'entry-fields' }, tb.header.map((c, i) => h('label', {}, h('span', {}, c || ' '),
      h('input', { type: i === dateIdx ? 'date' : 'text', value: prefill[i], name: `${formKey}-${i}`, autocomplete: 'off', enterkeyhint: 'next' })))),
    h('div', { class: 'entry-buttons' },
      h('button', { class: 'primary', type: 'submit' }, 'Add entry'),
      h('button', { type: 'button', onclick: toggleEntry }, 'Cancel')))
    : h('button', { class: 'new-entry', onclick: toggleEntry }, '+ New entry');

  // long text (comments, notes) goes on its own line under the row, so the table never runs off to the right
  const avgLen = (i) => tb.rows.reduce((n, r) => n + (r.cells[i] || '').length, 0) / (tb.rows.length || 1);
  const noteIdx = tb.header.map((c, i) => i).filter((i) => /^(comments?|notes?|kommentare?|bemerkungen?|notiz(en)?)$/i.test(tb.header[i].trim()) || avgLen(i) > 30);
  const cols = tb.header.map((c, i) => i).filter((i) => !noteIdx.includes(i));

  const limit = ui.showAll?.[formKey] ? Infinity : 60;
  const rows = [...tb.rows].reverse();
  return h('section', { class: 'tracker-table' },
    (tb.heading || nTables > 1) && h('h2', { class: 'label big' }, tb.heading || `Table ${ti + 1}`),
    stats && h('div', { class: 'stats' }, stats.map(([k, v]) => h('div', { class: 'stat' }, h('span', { class: 'stat-n' }, v), h('span', { class: 'meta' }, k)))),
    form,
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, cols.map((i) => h('th', {}, tb.header[i])), h('th', {}))),
      h('tbody', {}, rows.slice(0, limit).flatMap((r) => {
        const notes = noteIdx.map((i) => r.cells[i]).filter((c) => c && c.trim() && c.trim() !== '/');
        return [h('tr', { class: notes.length ? 'has-note' : '' },
        cols.map((i) => h('td', { html: renderInline(vault, r.cells[i] || '') })),
        h('td', { class: 'row-actions' },
          h('button', { title: 'Edit row', onclick: () => {
            const v = prompt('Edit row (cells separated by |)', r.cells.join(' | ')); if (v == null) return;
            op((t) => md.setRow(t, r, v.split('|').map((s) => s.trim())));
          } }, 'Edit'),
          h('button', { class: 'danger', title: 'Delete row', onclick: () => { if (confirm('Delete this row?')) op((t) => md.deleteRow(t, r)); } }, '×'))),
        notes.length > 0 && h('tr', { class: 'note-row' }, h('td', { colspan: cols.length + 1 },
          h('div', { class: 'row-note', title: 'Show all', onclick: (e) => e.currentTarget.classList.toggle('open'), html: renderInline(vault, notes.join(' · ')) })))];
      })))),
    rows.length > limit && h('button', { class: 'link', onclick: () => { (ui.showAll ||= {})[formKey] = true; renderMain(); } }, `Show all ${rows.length}`));
}


// ---------- Lab: what Stella and the pipelines are doing ----------
const SPRITES = { 'stella-idle': 4, 'stella-think': 4, 'stella-type': 4, 'stella-write': 4, 'stella-walk-left': 4, 'stella-walk-right': 4 };
const stationSprite = (name) => {
  const n = name.toLowerCase();
  return n.includes('ohara') ? 'ohara' : n.includes('punk') ? 'punk-records' : n.includes('paper') ? 'paper-architect'
    : n.includes('museum') ? 'museum' : n.includes('codex') ? 'codex' : n.includes('zotero') ? 'zotero'
    : n.includes('flame') ? 'mother-flame' : 'egghead';
};
const quiet = (state) => !state || /^(idle|done|waiting|ran\b.*|—|-)$/i.test(state);

function readActivity() {
  const t = vault.read(ACTIVITY) || '';
  const fm = md.splitFrontmatter(t);
  const rows = t.slice(fm.bodyStart).split('\n').map((l) => l.match(/^\s*[-*]\s+(.+)$/)).filter(Boolean)
    .map((m) => { const [name, state = '', detail = ''] = m[1].split('|').map((x) => x.trim()); return { name, state, detail }; });
  const stella = rows.find((r) => /^stella$/i.test(r.name));
  let stations = rows.filter((r) => r !== stella);
  if (!stations.length) stations = ['Library of Ohara', 'Punk Records', 'Paper Architect'].map((name) => ({ name, state: '', detail: '' }));
  return { updated: fm.data.updated, stella, stations };
}

// a sprite strip played with CSS steps; `scale` = screen pixels per sprite pixel
function sprite(name, scale, cls = '') {
  const el = h('div', { class: `sprite ${name.startsWith('stella') ? 'stella' : ''} ${cls}`, style: `--px:${scale}px` });
  const img = new Image();
  // Stella has her own dark-mode drawing (grey lines); the stations are simply inverted by CSS
  const file = name.startsWith('stella') && isDark() ? `${name}-dark` : name;
  img.onload = () => {
    const frames = SPRITES[name] || 1, fw = img.naturalWidth / frames;
    Object.assign(el.style, {
      width: `${fw * scale}px`, height: `${img.naturalHeight * scale}px`,
      backgroundImage: `url(sprites/${file}.png)`, backgroundSize: `${img.naturalWidth * scale}px auto`,
    });
    el.style.setProperty('--strip', `${-img.naturalWidth * scale}px`);
    el.style.setProperty('--frames', frames);
    el.classList.toggle('animated', frames > 1);
  };
  img.src = `sprites/${file}.png`;
  return el;
}

let stellaAt = 0; // which station Stella stood at last, so she walks from there
function labView() {
  // opening the Lab counts as seeing what waits there
  ui.seenLab = labItems(); saveUi(); setTimeout(renderTabbar, 0);
  const { updated, stella, stations } = readActivity();
  const small = isMobile();
  const target = stella ? stations.findIndex((s) => s.name.toLowerCase() === stella.state.toLowerCase()) : -1;
  const to = target >= 0 ? target : stellaAt;
  const pos = (i) => `${((i + 0.5) / stations.length) * 100}%`;
  const work = stella && target >= 0 ? (/writ|note|draft/i.test(stella.detail) ? 'stella-write' : 'stella-type') : 'stella-think';
  const walker = h('div', { class: 'walker', style: `left:${pos(stellaAt)}` }, sprite(to === stellaAt ? work : to > stellaAt ? 'stella-walk-right' : 'stella-walk-left', small ? 3 : 4));
  if (to !== stellaAt) {
    requestAnimationFrame(() => requestAnimationFrame(() => { walker.style.left = pos(to); }));
    walker.addEventListener('transitionend', () => walker.replaceChildren(sprite(work, small ? 3 : 4)), { once: true });
    stellaAt = to;
  }
  const questions = vault.read(QUESTIONS);
  const qs = questions != null ? questionsOf(md.parseList(questions).filter((s) => s.kind === 'item')) : [];
  return h('div', { class: 'page lab-page' },
    // Stella's own report time, not the app's sync (that shows at the bottom of the sidebar)
    pageHead('Lab', 'Lab', updated ? `Stella reported ${updated.slice(0, 10) === iso(new Date()) ? updated.slice(11) : dayLabel(updated.slice(0, 10))}` : ''),
    h('section', { class: 'scene' },
      h('div', { class: 'stage' }, walker),
      h('div', { class: 'stations', style: `grid-template-columns: repeat(${stations.length}, 1fr)` },
        stations.map((s) => h('div', { class: 'station' + (quiet(s.state) ? ' quiet' : '') },
          sprite('station-' + stationSprite(s.name), small ? 4 : 6),
          h('div', { class: 'label' }, s.name),
          h('div', { class: 'station-state' }, s.state || 'idle'),
          s.detail && h('div', { class: 'meta' }, s.detail)))),
      // what Stella says; else what's running at a station; only then "nothing running"
      h('p', { class: 'stella-says' }, stella?.detail
        || stations.filter((x) => !quiet(x.state)).map((x) => `${x.name}: ${x.state}${x.detail ? ` (${x.detail})` : ''}`).join(' · ')
        || (vault.exists(ACTIVITY) ? 'Nothing running.' : 'Waiting for Stella’s first report.'))),
    questions != null && h('section', { class: 'lab-questions' },
      h('div', { class: 'label big' }, 'Open questions'),
      answerPanel(qs),
      listView(QUESTIONS, questions)),
    // things a project needs Levin to do or allow (Stella's `stella todo`); his own to-dos live in Tasks
    vault.exists(TODOS) && md.countOpen(vault.read(TODOS)) > 0 && h('section', { class: 'lab-questions' },
      h('div', { class: 'label big' }, 'Needs you'),
      listView(TODOS, vault.read(TODOS))),
    // Stella takes the oldest open topic each night and reports under it
    vault.exists(RESEARCH) && h('section', { class: 'lab-questions lab-research' },
      h('div', { class: 'label big' }, 'Research topics'),
      listView(RESEARCH, vault.read(RESEARCH))),
    vault.exists(RULES) && h('p', { class: 'lab-rules' }, h('a', { href: fileHref(RULES) }, 'How Stella files the board →')));
}

// ---------- answering the Open Questions by voice (or typing) ----------
// A recording goes to attachments/ and onto System/Voice answers.md; GitHub's transcribe job swaps it for its words
// (tools/transcribe.py). The Lab then shows them split onto the questions (answers.js); Save writes each part under
// its question as "Your answer (voice note, 7 Nov): …" and ticks the settled ones, as a typed answer would be.
let answerDraft = '';
let review = null; // { entry, voice, recorded, transcript, parts: [{ qid, text, how }], settled: { Q12: true } }
const VOICE_HEAD = '---\nsource: Mother Flame\n---\n\nVoice notes answering the Open Questions. Each waits here to be transcribed (on GitHub), is matched to its questions in the Lab, and goes once its answers are saved.\n';
const clock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const items = (t) => md.parseList(t).filter((s) => s.kind === 'item');

async function queueVoiceAnswer(blob, ext) {
  const now = new Date();
  const name = `Voice ${stamp(now)}.${ext}`;
  await vault.write(`attachments/${name}`, blob);
  update(VOICE_ANSWERS, (t) => {
    t = md.addItem(t || VOICE_HEAD, `![[${name}]]`, { checkbox: false });
    return md.addNote(t, items(t).find((s) => s.text === `![[${name}]]`), `Recorded: ${iso(now)} ${clock(now)}`);
  });
}

function voiceEntries() {
  return items(vault.read(VOICE_ANSWERS) || '').map((it) => ({
    item: it,
    audio: [...it.text.matchAll(/!\[\[([^\]]+)\]\]/g)].map((m) => m[1]).filter((n) => AUDIO.test(n)),
    recorded: (it.notes.find((n) => n.text.startsWith('Recorded:'))?.text.slice(9).trim() || '').slice(11),
    text: it.text.replace(/!\[\[[^\]]+\]\]/g, '').trim(),
  }));
}

function startReview(text, qs, entry = null) {
  const parts = matchAnswers(text, qs);
  if (!parts.length) parts.push({ qid: null, text: text.trim(), how: null });
  review = { entry: entry?.item || null, voice: !!entry, recorded: entry?.recorded || '', transcript: text, parts, settled: {} };
}

async function discardEntry(e) {
  for (const n of e.audio) await vault.remove(resolveLink(vault, n, []) || `attachments/${n}`);
  update(VOICE_ANSWERS, (t) => { const f = md.findItem(t, e.item); return f ? md.deleteItem(t, f) : t; });
}

function saveAnswers(qs) {
  const r = review;
  const by = new Map();
  for (const p of r.parts) if (p.qid && p.text.trim()) by.set(p.qid, [...(by.get(p.qid) || []), p.text.trim()]);
  if (!by.size) { alert('Nothing is matched to a question yet: choose one for each part you want to keep.'); return; }
  update(QUESTIONS, (t) => {
    for (const [qid, texts] of by) {
      const q = questionsOf(items(t)).find((x) => x.id === qid);
      if (!q) continue;
      t = md.addNote(t, q.item, answerLine(texts.join(' '), { voice: r.voice }));
      if (r.settled[qid] !== false && !q.done) t = md.toggleItem(t, q.item.line);
    }
    return t;
  });
  if (r.entry) update(VOICE_ANSWERS, (t) => { const f = md.findItem(t, r.entry); return f ? md.deleteItem(t, f) : t; });
  else answerDraft = '';
  review = null;
  renderMain();
}

function answerPanel(qs) {
  const entries = voiceEntries();
  const waiting = entries.filter((e) => e.audio.length);
  const ready = entries.filter((e) => !e.audio.length);
  // a transcript that arrived opens by itself; one saved or discarded on another device closes
  if (review?.voice && !ready.some((e) => e.item.text === review.entry.text)) review = null;
  if (!review && ready.length) startReview(ready[0].text, qs, ready[0]);
  if (!review && !waiting.length && !qs.some((q) => !q.done)) return null;
  const listening = recording?.target === 'answer';
  return h('div', { class: 'answer-voice' },
    review ? reviewView(qs) : h('div', { class: 'answer-ask' },
      h('div', { class: 'answer-bar' },
        recordButton('answer'),
        h('span', { class: 'answer-hint' }, listening ? 'Listening. Tap again when you’re done.'
          : 'Answer by voice: say the number (“Q12 …”) or just talk about the question. Several at once is fine.')),
      h('form', { class: 'answer-type', onsubmit: (e) => { e.preventDefault(); if (answerDraft.trim()) { startReview(answerDraft, qs); renderMain(); } } },
        h('textarea', { rows: 1, placeholder: 'Or type them.', value: answerDraft, 'data-keep': 'answer', 'aria-label': 'Answers',
          oninput: (e) => { answerDraft = e.target.value; } }),
        h('button', { type: 'submit', class: 'link' }, 'Match'))),
    waiting.map((e) => h('div', { class: 'answer-wait' },
      h('span', { class: 'meta' }, `Voice note${e.recorded ? ` of ${e.recorded}` : ''}: being transcribed on GitHub, usually a minute or two.`),
      h('button', { class: 'link', onclick: () => { if (confirm('Discard this voice note?')) discardEntry(e); } }, 'Discard'))));
}

function reviewView(qs) {
  const r = review;
  const shortQ = (q) => `${q.id} · ${q.text.length > 72 ? q.text.slice(0, 70) + '…' : q.text}`;
  const how = { number: 'matched by its number', content: 'matched by its words', 'only open question': 'the only open question' };
  const choices = qs.filter((q) => !q.done || r.parts.some((p) => p.qid === q.id));
  const shown = new Set();
  return h('div', { class: 'answer-review' },
    h('div', { class: 'answer-review-head' },
      h('span', { class: 'label' }, r.voice ? `Your voice note${r.recorded ? ` of ${r.recorded}` : ''}` : 'Your answers'),
      h('span', { class: 'meta' }, 'Check where each part goes, then save.')),
    r.voice && h('p', { class: 'answer-transcript' }, r.transcript),
    r.parts.map((p) => {
      const q = qs.find((x) => x.id === p.qid);
      const first = p.qid && !shown.has(p.qid); if (p.qid) shown.add(p.qid);
      return h('div', { class: 'answer-part' + (p.qid ? '' : ' unmatched') },
        h('select', { 'aria-label': 'Question', onchange: (e) => { p.qid = e.target.value || null; p.how = null; renderMain(); } },
          h('option', { value: '' }, 'Leave out'),
          choices.map((c) => h('option', { value: c.id, selected: c.id === p.qid }, shortQ(c)))),
        q && h('div', { class: 'answer-q' }, q.text),
        h('textarea', { rows: Math.min(8, Math.max(2, Math.ceil(p.text.length / (isMobile() ? 34 : 70)))), value: p.text, 'aria-label': 'Answer', oninput: (e) => { p.text = e.target.value; } }),
        h('div', { class: 'answer-part-foot' },
          h('span', { class: 'meta' }, p.qid ? how[p.how] || '' : 'Not matched: choose a question, or it is left out.'),
          first && !q?.done && h('label', { class: 'settle' },
            h('input', { type: 'checkbox', 'aria-label': `${p.qid} settled`, checked: r.settled[p.qid] !== false, onchange: (e) => { r.settled[p.qid] = e.target.checked; } }),
            h('span', {}, 'Settled (tick it)'))));
    }),
    h('div', { class: 'answer-actions' },
      h('button', { class: 'primary', onclick: () => saveAnswers(qs) }, 'Save answers'),
      h('button', { class: 'link', onclick: () => {
        if (!r.voice) { review = null; renderMain(); return; }
        if (!confirm('Discard this voice note? Its words stay in the repository history.')) return;
        const e = voiceEntries().find((x) => x.item.text === r.entry.text);
        review = null;
        if (e) discardEntry(e); else renderMain();
      } }, r.voice ? 'Discard' : 'Back')));
}

// ---------- settings ----------
// a new device: one field. Owner and repository are known; only the token is personal.
function welcomeView() {
  return h('div', { class: 'page welcome' },
    pageHead('', APP_NAME),
    h('form', { class: 'settings', onsubmit: async (e) => {
      e.preventDefault();
      const next = { ...REPO, backend: 'github', token: $('input', e.target).value.trim() };
      const msg = $('.welcome .msg');
      msg.textContent = 'Opening…';
      try {
        await makeBackend(next).check();
        settings = next; store(KEYS.settings, settings);
        await start();
        location.hash = '#/';
      } catch (err) { msg.textContent = /401|Bad credentials/.test(err.message) ? 'That token didn’t work.' : err.message; }
    } },
      h('label', { class: 'field' }, h('span', {}, 'Token'),
        h('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: false, required: true })),
      h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Open'), h('span', { class: 'msg meta' }))),
    h('p', { class: 'meta welcome-help' },
      h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'Create a token ↗'),
      h('br'), `Repository: only ${REPO.repo}. Permission: Contents, read and write.`));
}

function settingsView(first = false) {
  if (first && !window.__folderAvailable) return welcomeView();
  const s = { ...REPO, ...settings };
  const field = (name, label, attrs = {}) => h('label', { class: 'field' }, h('span', {}, label), h('input', { name, value: s[name] || '', autocomplete: 'off', spellcheck: false, ...attrs }));
  const folderOk = !!window.__folderAvailable;
  const st = vault.status;
  return h('div', { class: 'page settings-page' },
    pageHead('Settings', first ? APP_NAME : 'Settings'),
    first && h('p', { class: 'lede' }, 'Your lists, notes and trackers, as plain Markdown in a private GitHub repository.'),
    h('form', { class: 'settings', onsubmit: async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      const next = { ...settings, ...data };
      const msg = $('.settings .msg');
      msg.textContent = 'Checking…';
      try {
        const warn = await makeBackend(next).check();
        settings = next; store(KEYS.settings, settings);
        msg.textContent = warn || 'Connected.';
        await start();
        location.hash = '#/';
      } catch (err) { msg.textContent = err.message; }
    } },
      h('fieldset', {},
        h('legend', { class: 'label' }, 'Storage'),
        [['github', 'GitHub'], ['device', 'This device only'], folderOk && ['folder', 'This Mac (preview)']]
          .filter(Boolean).map(([v, l]) => h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'backend', value: v, checked: (s.backend || 'github') === v, onchange: (e) => { settings.backend = e.target.value; renderMain(); } }), h('span', {}, l)))),
      (s.backend || 'github') === 'github' && h('fieldset', {},
        h('legend', { class: 'label' }, 'Repository'),
        field('owner', 'Owner', { placeholder: 'your-github-name' }),
        field('repo', 'Repository', { placeholder: 'vault' }),
        field('branch', 'Branch'),
        field('root', 'Folder inside the repository (optional)'),
        field('token', 'Access token', { type: 'password', placeholder: 'github_pat_…' }),
        h('p', { class: 'meta' }, 'Fine-grained token, this repository only, Contents: read and write. Stays on this device.')),
      h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save and connect'), h('span', { class: 'msg meta' }))),
    !first && h('section', { class: 'settings-status' },
      h('div', { class: 'label' }, 'Status'),
      h('p', {}, `${vault.backend?.label || '—'} · ${vault.list().length} files · ${st.state}${st.pending ? ` · ${st.pending} waiting` : ''}`),
      st.error && h('p', { class: 'meta' }, st.error),
      h('div', { class: 'row' },
        h('button', { onclick: () => vault.sync() }, 'Sync now'),
        h('button', { onclick: async () => {
          if (vault.status.pending && !confirm(`${vault.status.pending} changes have not been sent yet and will be lost. Continue?`)) return;
          await vault.reset(); location.reload();
        } }, 'Reload all files'))),
    h('section', { class: 'settings-help' },
      h('div', { class: 'label' }, 'Appearance'),
      h('div', { class: 'segmented' }, [['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) =>
        h('button', { class: getPref(KEYS.theme, 'auto') === v ? 'on' : '', onclick: () => { setPref(KEYS.theme, v); applyTheme(); renderMain(); } }, l)))),
    h('section', { class: 'settings-help' },
      h('div', { class: 'label' }, 'Icon'),
      h('div', { class: 'icon-pick' }, ['light', 'dark'].map((v) => {
        const sfx = v === 'dark' ? '-dark' : '';
        const on = getPref(KEYS.icon, 'dark') === v;
        return h('button', { class: 'icon-option' + (on ? ' on' : ''), onclick: () => {
          setPref(KEYS.icon, v);
          $('#touch-icon').href = `icons/apple-touch-icon${sfx}.png`;
          $('#manifest').href = `manifest${sfx}.webmanifest`;
          renderMain();
        } }, h('img', { src: `icons/icon-192${sfx}.png`, alt: '' }), h('span', {}, v === 'dark' ? 'Dark' : 'Light'));
      })),
      h('p', { class: 'meta' }, 'Used when you add the app to the Home Screen or Dock. An icon already there stays until you remove the app and add it again.')),
    h('section', { class: 'settings-help' },
      h('div', { class: 'label' }, 'Install'),
      h('p', {}, 'iPhone: Safari → Share → Add to Home Screen.'),
      h('p', {}, 'Mac: Safari → File → Add to Dock.')));
}

// ---------- boot ----------
function makeBackend(s) {
  if (s.backend === 'folder') return new FolderBackend();
  if (s.backend === 'device') return new DeviceBackend();
  if (!s.owner || !s.repo || !s.token) throw new Error('Owner, repository and token are needed.');
  return new GitHubBackend(s);
}
const backendKey = (s) => (s.backend === 'github' ? `gh:${s.owner}/${s.repo}@${s.branch}/${s.root || ''}` : s.backend);

let started = false;
async function start() {
  vault.backend = null;
  const backend = makeBackend(settings);
  navigator.storage?.persist?.().catch(() => {});  // keep the offline copy: the browser shouldn't clear it to free space
  await vault.open(backend, backendKey(settings));
  if (!started) {
    started = true;
    vault.on(scheduleRender);
    const pull = () => { if (document.visibilityState === 'visible') vault.sync(); };
    addEventListener('focus', pull);
    document.addEventListener('visibilitychange', pull);
    addEventListener('online', pull);
    setInterval(pull, 120000);
  }
  takeShared();
  followTab();
  render();
  writeFromLink();
  vault.sync();
}

// a link or text shared to the app (planner.levinguever.com/?text=…) becomes a card on the Filer
function takeShared() {
  const q = new URLSearchParams(location.search);
  const text = [q.get('title'), q.get('text'), q.get('url')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return;
  history.replaceState(null, '', location.pathname + '#/');
  update(INBOX, (t) => md.addItem(t, text, { top: true }));
}

async function boot() {
  document.title = APP_NAME;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  window.__folderAvailable = local && await fetch('/api/list', { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
  if (!settings.backend && window.__folderAvailable) settings = { backend: 'folder' };
  if (settings.backend) {
    try { await start(); return; } catch (e) { console.error(e); }
  }
  render();
}

if ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  navigator.serviceWorker.register('sw.js');
}
boot();
