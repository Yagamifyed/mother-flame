import { APP_NAME, KEYS, REPO, INBOX, CALENDAR, THISWEEK, TASKS, PEOPLE, JOURNAL, HEALTH, QUESTIONS, TODOS, RESEARCH, FOR_STELLA, TELL_SMO, DAILIES, VOICE_ANSWERS, RULES, ACTIVITY, SECTIONS, HIDDEN } from './config.js?v=1794684588';
import { Vault } from './vault.js?v=1794684588';
import { GitHubBackend, FolderBackend, DeviceBackend } from './backends.js?v=1794684588';
import * as md from './md.js?v=1794684588';
import { renderMarkdown, hydrateImages, renderInline, resolveLink, AUDIO, TAG, noteBlocks, blockToMarkdown } from './render.js?v=1794684588';
import { parseCapture, iso, addDays, dayLabel, longDate, weekday } from './dates.js?v=1794684588';
import { matchAnswers, questionsOf, answerLine } from './answers.js?v=1794684588';
import { merge3 } from './merge.js?v=1794684588';

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
let usualQ = '';  // what is typed in Usual items' Find field (kept across redraws)
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
// Inbox.md is the Filer's file: it is called the Filer everywhere, and its links open the Filer
const title = (path) => (path === INBOX ? 'Filer' : md.splitFrontmatter((typeof vault !== 'undefined' && vault.read(path)) || '').data.title || stem(path));
const section = (path) => (path.includes('/') ? path.split('/')[0] : '');
const fileHref = (path) => (path === INBOX ? '#/' : `#/f/${encodeURIComponent(path)}`);
const update = (path, fn) => { const t = vault.read(path) ?? ''; const n = fn(t); if (n !== t) { vault.write(path, n); nameYouTube(path, n); } };
// a bare YouTube link in anything with a tick box gets the video's title at once (Levin, 11 Nov 2026: "I want to always
// know what video it is I am linking"), as [Title (channel) — YouTube](url), the way tools/link_title.py names links
// each night. YouTube's public oEmbed answers this page directly; no login. Lists other tools read as plain links are left.
const LINK_SKIP = ['Watch List', 'Artist of the Month', 'Museum Posts', 'To-dos from Claude', 'Open Questions'];
const YT = /(?<![(\[<"'=/])\bhttps?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/[^\s<>\])"]+/g;
const ytAsked = new Set();
function nameYouTube(path, text) {
  if (!/\.md$/i.test(path) || !text.includes('youtu') || LINK_SKIP.includes(path.split('/').pop().replace(/\.md$/i, ''))) return;
  const ticks = text.split('\n').filter((l) => /^\s*- \[[ xX]\] /.test(l)).join('\n');
  for (const m of ticks.matchAll(YT)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (ytAsked.has(url)) continue;
    ytAsked.add(url);
    fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url)).then((r) => r.ok ? r.json() : null).then((d) => {
      let t = (d?.title || '').replace(/\s+/g, ' ').trim();
      if (!t) return;
      if (t.length > 90) t = t.slice(0, 89).replace(/\s+\S*$/, '') + '…';
      const label = `[${(t + (d.author_name ? ` (${d.author_name})` : '')).replace(/\[/g, '(').replace(/\]/g, ')')} — YouTube](${url})`;
      const bare = new RegExp(`(?<![(\\[<"'=/])${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/?#&=%~+-])`, 'g');
      update(path, (x) => x.split('\n').map((l) => /^\s*- \[[ xX]\] /.test(l) ? l.replace(bare, () => label) : l).join('\n'));
    }).catch(() => {});
  }
}
// the Watch List and Claude To-do keep plain links in the file (The Museum and Stella read them so), but show each as its
// site's name, "Transient" for https://www.transient.xyz/mint/… (Levin, 11 Nov 2026); editing still gives the address
const SHORT_LINKS = ['Lists/Watch List.md', 'Lists/To-dos from Claude.md'];
const SITE_NAMES = { x: 'X', twitter: 'X', youtube: 'YouTube', youtu: 'YouTube', github: 'GitHub', superrare: 'SuperRare', objkt: 'objkt' };
function shortLinks(root) {
  if (!SHORT_LINKS.includes(route().path)) return;
  for (const a of root.querySelectorAll('a[href^="http"]')) {
    const href = a.getAttribute('href');
    if (a.textContent.trim() !== href) continue;
    let host = ''; try { host = new URL(href).hostname.replace(/^(www|m|mobile)\./, ''); } catch { continue; }
    const base = host.split('.').slice(-2, -1)[0] || host;
    const label = SITE_NAMES[base] || base[0].toUpperCase() + base.slice(1);
    Object.assign(a.dataset, { md: href, label });
    a.textContent = label; a.title = href; a.classList.add('short-link');
  }
}
const isMobile = () => matchMedia('(max-width: 760px)').matches;
// Enter sends (a card, an answer); Shift+Enter starts a new line (Levin, 8 Nov 2026)
const sendOnEnter = (fn) => (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); fn(e); } };

// ---------- routing ----------
function route() {
  const hsh = decodeURIComponent(location.hash.slice(1) || '/');
  if (hsh.startsWith('/f/')) return hsh.slice(3) === INBOX ? { view: 'today' } : { view: 'file', path: hsh.slice(3) };
  if (hsh === '/settings') return { view: 'settings' };
  if (hsh === '/index') return { view: 'today', drawer: true };
  if (hsh === '/new') return { view: 'today', write: true };  // a link that opens the writing sheet (a Mac shortcut can open it)
  if (hsh === '/lab') return { view: 'today' };  // the Lab is the home page now, with the Filer in it (Levin, 8 Nov 2026)
  if (hsh === '/heartbeat') return { view: 'heartbeat' };
  if (hsh === '/questions') return { view: 'questions' };
  if (hsh === '/calendar') return { view: 'file', path: THISWEEK };  // no Calendar page: the calendar is in Week (Levin, 8 Nov 2026)
  if (hsh === '/day') return { view: 'day' };
  if (hsh === '/recent') return { view: 'recent' };
  if (hsh.startsWith('/sort/')) return { view: 'sort', path: hsh.slice(6) };
  if (hsh === '/people') return { view: 'people' };
  if (hsh.startsWith('/people/')) return { view: 'person', name: hsh.slice(8) };
  if (hsh.startsWith('/tag/')) return { view: 'tag', name: hsh.slice(5).toLowerCase() };
  if (hsh === '/library') return { view: 'library' };
  return { view: 'today' };
}

// ---------- render loop ----------
let stale = false, query = '', searchOpen = false;
function editingInMain() {
  const a = document.activeElement;
  return a && $('#main')?.contains(a) && (a.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(a.tagName));
}
const memo = new Map();  // results that scan every file; cleared whenever files change (render)
const memoized = (key, fn) => (memo.has(key) ? memo.get(key) : (memo.set(key, fn()), memo.get(key)));
function render() {
  tagCache = null; memo.clear();
  renderTabbar();
  // no tucking the sidebar away any more (Levin, 8 Nov 2026): its width is dragged at its edge instead, and kept
  if (ui.sideCollapsed) { ui.sideCollapsed = false; saveUi(); }
  document.body.classList.toggle('side-collapsed', false);
  if (ui.sideWidth) document.documentElement.style.setProperty('--side', `${ui.sideWidth}px`);
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
    if (isMobile()) openDrawer();
    openSearch();
  }
});
const writeFromLink = () => { if (!route().write || !vault.backend) return; history.replaceState(history.state, '', '#/'); renderMain(); openQuickAdd(); };
const scrolls = new Map();  // page → how far down it was, for coming back
// depth: how many pages this visit has gone on from the page the app opened on (the back button shows while it is > 0)
let goingBack = false, navN = 0, depth = history.state?.d ?? 0;
// a page reached by Back already carries a number in its history entry; a new one gets one now, and its depth
addEventListener('hashchange', (e) => {
  scrolls.set(new URL(e.oldURL).hash, scrollY);
  goingBack = history.state?.n != null;
  if (goingBack) depth = history.state.d ?? 0;
  else history.replaceState({ n: ++navN, d: ++depth }, '');
});
addEventListener('hashchange', () => { stale = false; weekSel = null; closeDrawer(); if (route().write) return writeFromLink(); if (route().drawer) openDrawer(); followTab(); renderSide(); renderTabbar(); renderMain(); $('#main').scrollTop = 0; const back = goingBack; goingBack = false; scrollTo(0, back ? scrolls.get(location.hash) || 0 : 0); $('#main > .page')?.classList.add(pageDir > 0 ? 'enter-right' : pageDir < 0 ? 'enter-left' : 'enter'); pageDir = 0; if (!back) $('#cal-now, #week-now')?.scrollIntoView({ block: 'start' }); if (pendingFind) setTimeout(jumpToFound, 60); });

// what waits on Levin in the Lab: open questions. Stella's self-check (System/Health.md) shows only when you tap Stella:
// what it needs from Levin arrives as a Claude To-do and is ticked once solved (Levin, 8 Nov 2026: no red banner)
const labCount = () => (vault.exists(QUESTIONS) ? md.countOpen(vault.read(QUESTIONS)) : 0);
const openTexts = (p) => (vault.exists(p) ? md.parseList(vault.read(p)).filter((x) => x.kind === 'item' && x.checkbox && !x.checked).map((x) => x.text) : []);
const health = () => { const t = vault.read(HEALTH); return t ? { line: t.slice(md.splitFrontmatter(t).bodyStart).trim().split('\n')[0], updated: md.splitFrontmatter(t).data.updated } : null; };
const labItems = () => openTexts(QUESTIONS);
// the red numbers: only what arrived since that place was last opened (the Lab; Claude To-do, in Lists › AI)
const forStella = () => vault.exists(FOR_STELLA) && md.parseList(vault.read(FOR_STELLA) || '').some((s) => s.kind === 'item');
const labNew = () => labItems().filter((t) => !(ui.seenLab || []).includes(t)).length;
// cards Stella filed (System/Filed.md, from the filing tool and skill): red in their list until Levin has looked
// (Levin, 8 Nov 2026: red only for what Stella adds or files, never for what he adds himself)
const FILED = 'System/Filed.md';
const filedEntries = () => memoized('filed', () => (vault.read(FILED) || '').split('\n').filter((l) => l.startsWith('- '))
  .map((l) => { const [at, path, ...rest] = l.slice(2).split(' | '); const text = rest.join(' | ').trim(); return { at, path: (path || '').trim(), text, key: `${(path || '').trim()}|${text}` }; }));
function filedFresh(path) {
  if (!ui.seenFiled) { ui.seenFiled = filedEntries().map((e) => e.key); saveUi(); }  // the first time: what is there counts as seen
  const body = vault.read(path) || '';
  return filedEntries().filter((e) => e.path === path && !ui.seenFiled.includes(e.key) && body.includes(e.text));
}
const freshText = (path, text) => (path === TODOS && !(ui.seenTodos || []).includes(text)) || filedFresh(path).some((e) => e.text === text || e.text.endsWith(text));
const todosNew = () => openTexts(TODOS).filter((t) => !(ui.seenTodos ??= [...(ui.seenLab || [])]).includes(t)).length;

// ---------- areas ----------
// a file belongs to the Planner when its frontmatter says `area: planner`
// three areas: Planner (frontmatter `area: planner`), Lists (the other lists) and Collections (notes, trackers)
// `area: lab` (the Museum's lists, which its site reads) shows under the Lab instead of in Lists
const area = (path) => { const a = md.splitFrontmatter(vault.read(path) || '').data.area; return a === 'planner' ? 'planner' : a === 'lab' ? 'lab' : a === 'hidden' ? 'hidden' : section(path) === 'Lists' ? 'lists' : 'collections'; };
function followTab() {
  if (isMobile()) return;  // the phone: ≡ opens on the tab last picked in it, whatever page is open (Levin, 10 Nov 2026)
  const r = route();
  if (r.view === 'file' && vault.exists(r.path)) { const a = area(r.path); ui.tab = a === 'lab' || a === 'hidden' || ['System'].includes(section(r.path)) || [FOR_STELLA, PEOPLE, QUESTIONS, RESEARCH].includes(r.path) || a !== 'collections' ? 'planner' : a; }
  else if (['today', 'lab', 'heartbeat', 'questions', 'calendar', 'day', 'recent', 'tag', 'library', 'settings', 'people', 'person'].includes(r.view)) ui.tab = 'planner';
  else if (['person', 'people'].includes(r.view)) ui.tab = 'planner';
  saveUi();
}
async function setArea(path, to) {
  const text = vault.read(path) || '';
  await vault.write(path, md.setFrontmatterKey(text, 'area', to === 'planner' ? 'planner' : null));
  ui.tab = area(path) === 'collections' ? 'collections' : 'planner'; saveUi(); renderSide(); renderMain();
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

const freshCount = (path) => (path === TODOS ? todosNew() : 0) + filedFresh(path).length;
// what is new in a tab of ≡ (on the phone without the pages that have their own place in the bar)
const inBar = (path) => isMobile() && barKeys().includes(barKey(path));
const freshIn = (tab) => vault.list().map((f) => f.path).filter((p) => /\.md$/i.test(p) && !['System', 'Backups'].includes(section(p)) && p !== INBOX
  && (area(p) === 'collections' ? 'collections' : 'planner') === tab && !inBar(p)).reduce((n, p) => n + freshCount(p), 0);
function badge(path) {
  const n = freshCount(path);
  if (n) return h('i', { class: 'nav-new', 'aria-label': `${n} new` }, String(n));
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
  if (drag?.task) return moveTask(x, y);
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
  edgeScroll(x, y);
}
// near the top or bottom of the screen the page scrolls along, also while the finger rests there (to reach another day)
let edgeTimer = null, edgeXY = null;
const edgeStep = (y) => (y < 90 ? -8 : y > innerHeight - 150 ? 8 : 0);
function edgeScroll(x, y) {
  edgeXY = [x, y];
  if (!edgeStep(y)) return stopEdge();
  edgeTimer ||= setInterval(() => {
    const [ex, ey] = edgeXY, n = edgeStep(ey);
    if (!drag || !n) return stopEdge();
    scrollBy(0, n); const m = $('#main'); if (m) m.scrollTop += n;
    moveDrag(ex, ey);
  }, 16);
}
function stopEdge() { clearInterval(edgeTimer); edgeTimer = null; }
function endDrag(cancel = false) {
  if (drag?.task) return endTask(cancel);
  const d = drag; drag = null; stopEdge();
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
// This week (Levin, 8 Nov 2026): a task held (phone) or by its grip (Mac) can go anywhere among the coming days:
// dropped on another day it gets that day; its place among that day's tasks is kept in This week's order
function liftTask(it, rowEl, x, y) {
  const b = rowEl.getBoundingClientRect(), ghost = rowEl.cloneNode(true);
  ghost.classList.add('drag-ghost');
  Object.assign(ghost.style, { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px' });
  const line = h('div', { class: 'drop-line' });
  document.body.append(ghost, line);
  document.body.classList.add('dragging');
  document.activeElement?.blur?.();
  rowEl.classList.add('drag-src');
  drag = { task: true, it, rowEl, ghost, line, x0: x, y0: y, slot: null, moved: false };
  moveTask(x, y);
}
function moveTask(x, y) {
  const d = drag;
  if (Math.abs(y - d.y0) > 6) d.moved = true;
  d.ghost.style.transform = `translate(0, ${y - d.y0}px)`;
  const letter = document.elementsFromPoint(x, y).map((el) => el.closest?.('[data-drop-day]')).find(Boolean);
  document.querySelectorAll('.ws-day.drop').forEach((el) => el !== letter && el.classList.remove('drop'));
  if (letter) { stopEdge(); letter.classList.add('drop'); d.line.style.display = 'none'; d.slot = { day: letter.dataset.dropDay, before: null, after: null }; return; }
  d.line.style.display = '';
  edgeScroll(x, y);
  const secs = [...document.querySelectorAll('section[data-day]')];
  const sec = secs.filter((s) => s.getBoundingClientRect().top <= y).at(-1) || secs[0];
  if (!sec) return;
  const rows = [...sec.querySelectorAll('.task-row')].filter((r) => r !== d.rowEl);
  const below = rows.find((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 > y; });
  const above = below ? rows[rows.indexOf(below) - 1] : rows.at(-1);
  const ref = (below || above || [...sec.querySelectorAll('.day-head, .event')].at(-1) || sec).getBoundingClientRect(), sb = sec.getBoundingClientRect();
  Object.assign(d.line.style, { top: (below ? ref.top : ref.bottom) - 1 + 'px', left: sb.left + 12 + 'px', width: sb.width - 24 + 'px' });
  d.slot = { day: sec.dataset.day, before: below?._it || null, after: !below && above ? above._it : null };
}
function endTask(cancel) {
  const d = drag; drag = null; stopEdge();
  d.ghost.remove(); d.line.remove(); d.rowEl.classList.remove('drag-src'); document.body.classList.remove('dragging');
  document.querySelectorAll('.ws-day.drop').forEach((el) => el.classList.remove('drop'));
  if (cancel || !d.moved || !d.slot) { if (stale) { stale = false; renderMain(); } return false; }
  const { day, before, after } = d.slot, it = d.it;
  withUndo(it.due !== day ? `Moved to ${dayLabel(day).toLowerCase()}` : 'Moved', [...new Set([it.path, THISWEEK])], () => {
    if (it.due !== day) setDay(it.path, it, day);  // (from General To-Do it moves into This week, as any task given a day)
    const nb = before?.path === THISWEEK && before, na = after?.path === THISWEEK && after;
    if ((nb || na) && !it.indent) update(THISWEEK, (t) => md.dropItem(t, it, nb ? { before: nb, depth: 0 } : { after: na, depth: 0 }));
  });
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
  if (target === TASKS && f.due) target = THISWEEK;  // General To-Do has no days: a dated task goes to This week
  if (target === SHOP) { update(SHOP, (t) => shopAdd(t, f.text)); update(from, (t) => { const g = md.findItem(t, it); return g ? md.deleteItem(t, g) : t; }); noteRecent(target); return; }
  const block = md.extractBlock(src, f);
  const isList = md.fileType(target, vault.read(target) || '') === 'list';
  update(target, (t) => md.insertBlock(t, block, { top: isList }));
  update(from, (t) => { const g = md.findItem(t, it); return g ? md.deleteItem(t, g) : t; });
  noteRecent(target);
}
// a sheet from the bottom: where should this go?
// File into (Levin, 10 Nov 2026): as the flame's sheet. The planner's chips first (Today, Week, General, Shopping, Smo,
// Stella; no Research); Week opens its days in their place (tap Week again to go back); then every other list as small
// chips under its folder's name, in the sidebar's order, recent ones first, and the collections at the end
function openMoveSheet(from, it, many = null) {
  const files = vault.list().map((f) => f.path).filter((p) => /\.md$/i.test(p) && ['Lists', 'Notes'].includes(section(p)) && p !== from && p !== QUESTIONS);
  const recent = (ui.recent || []).filter((p) => files.includes(p));
  const lists = fileable().filter(({ p }) => p !== from);
  const fm = (p) => md.splitFrontmatter(vault.read(p) || '').data.folder || '';
  const notes = files.filter((p) => section(p) !== 'Lists' && area(p) === 'collections').sort((a, b) => fm(a).localeCompare(fm(b)) || byOrder(a, b));
  let week = false;
  const close = () => back.remove();
  const done = (msg, paths, fn) => { close(); withUndo(msg, paths, () => { for (const x of many || [it]) fn(x); if (many) { ui.selected = {}; renderMain(); } }); };
  const file = (p) => done(`Filed in ${title(p)}`, [from, p], (x) => moveTo(from, x, p));
  const put = (due) => done(due ? `Moved to ${dayLabel(due).toLowerCase()}` : 'Filed in Week', [from, THISWEEK], (x) => {
    if (from === THISWEEK) update(THISWEEK, (t) => { const f = md.findItem(t, x); if (!f) return t; const u = md.setItemFields(t, f.line, { due }); return due && due !== f.due ? md.toTop(u, f) : u; });
    else if (due) moveToWeek(from, x, due); else moveTo(from, x, THISWEEK);
  });
  const chip = (label, fn, on = false) => h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: fn }, label);
  // lists as chips, a row a folder, its name in grey at the row's start (a line saved per folder)
  const grouped = (items, name) => {
    const gs = [];
    items.forEach(({ p, folder }, i) => { if (i === 0 || folder !== items[i - 1].folder) gs.push({ name: name(folder, i), ps: [] }); gs.at(-1).ps.push(p); });
    return gs.map((g) => h('div', { class: 'fi-group' }, h('span', { class: 'fi-label' }, g.name.replace(/\s*\/\s*/g, ' › ')), g.ps.map((p) => chip(title(p), () => file(p)))));
  };
  const body = h('div', {});
  const draw = () => {
    const now = new Date(), d = (n) => iso(addDays(now, n));
    const quick = QUICK().filter((q) => !['here', 'picked', 'research'].includes(q.key) && (q.due || q.key === 'week' || q.path !== from));
    body.replaceChildren(h('div', {},
      week
        ? h('div', { class: 'quick-chips' }, chip('Week', () => { week = false; draw(); }, true),
          [1, 2, 3, 4, 5, 6, 7].map((n) => chip(weekday(d(n)), () => put(d(n)))), chip('No day', () => put(null)))
        : h('div', { class: 'quick-chips' }, quick.map((q) => chip(q.label, () => (q.key === 'week' ? ((week = true), draw()) : q.due ? put(q.due) : file(q.path))))),
      h('div', { class: 'fi-all' },
        recent.length > 0 && grouped(recent.map((p) => ({ p, folder: '' })), () => 'Recent'),
        grouped(lists, (f, i) => f || (i === 0 ? 'Planner' : 'Other')),
        notes.length > 0 && [h('div', { class: 'fi-head' }, 'Collections'), grouped(notes.map((p) => ({ p, folder: fm(p) })), (f) => f || 'Notes')])));
  };
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'sheet file-into', role: 'dialog', 'aria-label': 'File into' },
      h('div', { class: 'sheet-head' }, h('span', { class: 'label' }, 'File into'), h('button', { class: 'quiet', 'aria-label': 'Close', onclick: close }, '×')),
      h('p', { class: 'meta sheet-what' }, many ? `${many.length} items` : it.text.replace(/!\[\[[^\]]+\]\]/g, '').slice(0, 90)),
      body));
  draw();
  document.body.append(back);
}

// the iPhone keyboard covers the bottom of the screen without moving it: sheets sit on top of the keyboard (--kb)
// (on scroll too: when the iPhone pans the page to show a field, the old height would put the sheet in the wrong place)
// --vvh: the height of what is on screen. A sheet is never taller than it: when the iPhone pans up to show a field, the
// full height less the keyboard would be too tall by the pan, and the sheet's top went off the screen (Levin, 10 Nov 2026)
const measureKb = () => {
  const kb = Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop);
  document.documentElement.style.setProperty('--kb', kb > 80 ? kb + 'px' : '0px');
  document.documentElement.style.setProperty('--vvh', visualViewport.height + 'px');
  document.documentElement.classList.toggle('kb-open', kb > 80);
};
visualViewport?.addEventListener('resize', measureKb);
visualViewport?.addEventListener('scroll', measureKb);

// ---------- the sidebar as a drawer: on the phone always, on the Mac when tucked away ----------
const drawerMode = () => isMobile() || !!ui.sideCollapsed;
const openDrawer = () => { if (drawerMode()) { lockScroll(true); document.body.classList.add('drawer-open'); renderTabbar(); $('#side .nav-item.active')?.scrollIntoView({ block: 'nearest' }); } };
const closeDrawer = () => {
  const was = document.body.classList.contains('drawer-open');
  if (was) lockScroll(false);
  document.body.classList.remove('drawer-open');
  if (was && (query || searchOpen)) { query = ''; searchOpen = false; document.activeElement?.blur?.(); renderSide(); }  // leaving ≡ clears its search
  // leaving ≡ shuts every folder opened in it; the one holding the page you are on opens again by itself (Levin, 11 Nov 2026)
  if (was && isMobile() && (Object.keys(ui.open || {}).length || Object.keys(ui.shutOn || {}).length)) { ui.open = {}; ui.shutOn = {}; saveUi(); renderSide(); }
  if ($('.fab')) renderTabbar();
};
// while the panel is open the page behind it stays put (iPhone would otherwise scroll it when a list ends)
let lockedAt = null;
function lockScroll(on) {
  if (!isMobile()) return;
  if (on && lockedAt === null) { lockedAt = scrollY; Object.assign(document.body.style, { position: 'fixed', top: `-${lockedAt}px`, left: '0', right: '0' }); }
  if (!on && lockedAt !== null) { Object.assign(document.body.style, { position: '', top: '', left: '', right: '' }); scrollTo(0, lockedAt); lockedAt = null; }
}
document.addEventListener('click', (e) => { if (e.target.closest?.('#side a')) closeDrawer(); });
function setCollapsed(on) { ui.sideCollapsed = on; saveUi(); closeDrawer(); document.body.classList.toggle('side-collapsed', on); }
// swipe in from the left edge to open it; swipe it back to the left (or tap beside it) to close it.
// On the phone it is a sheet from the bottom: swipe sideways on it to change tab, swipe it down to close it. Pulled
// down, it follows the finger and closes only when let go far enough down (or flicked), as the other sheets; a swipe
// that scrolls its list back up to the top only scrolls (Levin, 8 Nov 2026)
(() => {
  let x0 = null, y0 = 0, closing = false, sheet = false, mode = null, top0 = true, pull = 0, yl = 0, tl = 0, v = 0;
  const free = (el) => !el.closest?.('.swipe-row, .pad-canvas, input, textarea, select, .table-wrap, .week-grid, .quick-chips, .sheet, [contenteditable]');
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0], open = document.body.classList.contains('drawer-open');
    closing = open; sheet = isMobile(); mode = null;
    if (open && sheet && (!e.target.closest?.('#side') || e.target.closest('input'))) { x0 = null; return; }  // beside it: a tap closes it
    x0 = open || (drawerMode() && !sheet && (t.clientX < 44 || free(e.target))) ? t.clientX : null; y0 = yl = t.clientY;
    tl = e.timeStamp; v = 0; pull = 0; top0 = !e.target.closest?.('#side .nav') || $('#side .nav').scrollTop <= 0;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (x0 === null) return;
    const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0, side = $('#side');
    if (!mode) { if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return; mode = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'; }
    if (sheet) {
      if (!closing || mode !== 'y') return;  // opening rises on release; a sideways swipe changes tab on release
      const y = e.touches[0].clientY;
      if (e.timeStamp > tl) v = (y - yl) / (e.timeStamp - tl);
      yl = y; tl = e.timeStamp;
      if (dy > 0 && top0 && (!e.target.closest('.nav') || $('#side .nav').scrollTop <= 0)) {
        // typing a search: the pull only puts the keyboard away, the results stay (Levin, 10 Nov 2026); the next one closes
        if (document.activeElement?.matches?.('#side .search')) { document.activeElement.blur(); mode = 'scroll'; return; }
        e.preventDefault(); pull = Math.max(0, dy - 12); side.style.transition = 'none'; side.style.transform = `translateY(${pull}px)`;
      } else { mode = 'scroll'; pull = 0; side.style.transform = ''; }
      return;
    }
    if (mode === 'y') return;  // a scroll, not a swipe
    side.style.transition = 'none';
    side.style.transform = closing ? `translateX(${Math.min(0, dx)}px)` : `translateX(${Math.min(0, dx - side.offsetWidth)}px)`;
  }, { passive: false });
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
      if (mode === 'y' && (pull >= Math.min(120, side.offsetHeight * 0.3) || (v > 0.5 && pull > 24))) closeDrawer();  // else it springs back
      return;
    }
    if (!closing && mode === 'x' && dx > 60 && Math.abs(dy) < Math.max(80, dx * 0.6)) openDrawer();
    if (closing && mode === 'x' && dx < -60 && Math.abs(dy) < 80) closeDrawer();
  });
  document.addEventListener('touchcancel', () => { if (x0 === null) return; x0 = null; const side = $('#side'); side.style.transition = ''; side.style.transform = ''; });
})();

// the write button's icon: the pixel flame (Levin's pick, 7 Nov 2026)
const writeIcon = () => h('span', { class: 'tb-flame', 'aria-hidden': 'true', html: '<svg viewBox="0 1 12 11" width="100%" height="100%" shape-rendering="crispEdges"><path fill="currentColor" d="M5 2h1v1h-1zM6 2h1v1h-1zM5 3h1v1h-1zM6 3h1v1h-1zM5 4h1v1h-1zM6 4h1v1h-1zM7 4h1v1h-1zM9 4h1v1h-1zM3 5h1v1h-1zM4 5h1v1h-1zM5 5h1v1h-1zM7 5h1v1h-1zM8 5h1v1h-1zM9 5h1v1h-1zM3 6h1v1h-1zM4 6h1v1h-1zM7 6h1v1h-1zM8 6h1v1h-1zM9 6h1v1h-1zM2 7h1v1h-1zM3 7h1v1h-1zM8 7h1v1h-1zM9 7h1v1h-1zM3 8h1v1h-1zM8 8h1v1h-1zM9 8h1v1h-1zM3 9h1v1h-1zM4 9h1v1h-1zM7 9h1v1h-1zM8 9h1v1h-1zM4 10h1v1h-1zM5 10h1v1h-1zM6 10h1v1h-1zM7 10h1v1h-1z"/><path fill="currentColor" opacity=".55" d="M6 5h1v1h-1zM5 6h1v1h-1zM6 6h1v1h-1zM4 7h1v1h-1zM5 7h1v1h-1zM6 7h1v1h-1zM7 7h1v1h-1zM4 8h1v1h-1zM5 8h1v1h-1zM6 8h1v1h-1zM7 8h1v1h-1zM5 9h1v1h-1zM6 9h1v1h-1z"/></svg>' });

// ---------- the Mac: the flame bottom right; the phone has it in its quick bar ----------
function renderTabbar() {
  if (!vault.backend) { $('.fab')?.remove(); $('.pages')?.remove(); return; }
  if (!$('.fab')) document.body.append(h('button', { class: 'fab', 'aria-label': 'Write something down (N)', title: 'Write something down (N)', onclick: () => openQuickAdd() }, writeIcon()));
  renderPages();
}

// the phone's quick bar, on every page (Levin, 8 Nov 2026): ≡ on the left, the flame on the right, and between them
// symbols for the pages he keeps at hand; swipe sideways anywhere to go to the next or previous one.
// Long-press a page or list (here or in ≡) to add it to the bar or take it off; at most six.
// (11 Nov 2026: Recent left the bar for a card in the Lab, so the bar's symbols can be larger)
const BAR_DEFAULT = ['lab', 'day', 'week', 'todo', 'shopping'], BAR_MAX = 6;
const barKey = (path) => ({ [THISWEEK]: 'week', [TASKS]: 'todo', 'Lists/Shopping.md': 'shopping', [INBOX]: 'lab' })[path] || path;
const barKeys = () => {
  if (ui.bar && !ui.barLab) {  // once (8 Nov 2026): the Filer is in the Lab now; its place goes to the Lab, the Lab's to Recent
    ui.bar = [...new Set(ui.bar.map((k) => (k === 'filer' ? 'lab' : k === 'calendar' ? null : k)).filter(Boolean))];
    if (!ui.bar.includes('recent') && ui.bar.length < BAR_MAX) ui.bar.push('recent');
    ui.barLab = true; saveUi();
  }
  if (ui.bar && !ui.barNoRecent) { ui.bar = ui.bar.filter((k) => k !== 'recent'); ui.barNoRecent = true; saveUi(); }
  return ui.bar || BAR_DEFAULT;
};
function BAR() {
  const pages = PAGES();
  return barKeys().map((k) => pages.find((pg) => pg.key === k)
    || (vault.exists(k) && { key: k, label: title(k), href: fileHref(k), on: (r) => r.view === 'file' && r.path === k, count: () => md.fileType(k, vault.read(k) || '') === 'list' ? md.countOpen(vault.read(k) || '') || '' : '' })).filter(Boolean);
}
// the menu line that adds a page to the bar or takes it off (phone only: the Mac has no bar)
function barToggle(key) {
  if (!isMobile()) return null;
  const keys = barKeys(), on = keys.includes(key);
  return [on ? 'Remove from the bar' : 'Add to the bar', () => {
    if (!on && keys.length >= BAR_MAX) return toast('The bar is full: remove one first');
    ui.bar = on ? keys.filter((k) => k !== key) : [...keys, key]; saveUi(); renderPages();
  }];
}
// pixel symbols, drawn row by row (# = a pixel), like the flame
// an empty place (a list with nothing open, the Filer with no cards, no open questions): a small tick and a word,
// in a quiet panel, instead of a blank box (Levin, 8 Nov 2026)
const emptyState = (text) => h('div', { class: 'empty-state' }, h('span', {}, text));
const pix = (rows) => `<svg viewBox="0 0 ${rows[0].length} ${rows.length}" width="100%" height="100%" shape-rendering="crispEdges"><path fill="currentColor" d="${rows.flatMap((row, y) => [...row].map((c, x) => (c === '#' ? `M${x} ${y}h1v1h-1z` : ''))).join('')}"/></svg>`;
const ICONS = {
  filer: ['............', '..########..', '..#......#..', '.#........#.', '.#........#.', '#..........#', '####....####', '#..#....#..#', '#...####...#', '#..........#', '############', '............'],
  day: ['.....##.....', '.#...##...#.', '..#......#..', '....####....', '...######...', '##.######.##', '##.######.##', '...######...', '....####....', '..#......#..', '.#...##...#.', '.....##.....'],
  week: ['...#....#...', '.##########.', '.##########.', '.#........#.', '.#........#.', '.#.######.#.', '.#.######.#.', '.#........#.', '.#........#.', '.#........#.', '.##########.', '............'],
  todo: ['............', '.###........', '.#.#.######.', '.###........', '............', '.###........', '.#.#.######.', '.###........', '............', '.###........', '.#.#.######.', '.###........'],
  shopping: ['............', '##..........', '.#..........', '.##########.', '..#.......#.', '..#.......#.', '...#######..', '...#........', '...########.', '............', '...##...##..', '...##...##..'],
  lab: ['...######...', '....#..#....', '....#..#....', '....#..#....', '...#....#...', '...#....#...', '..#......#..', '..#.####.#..', '.#.######.#.', '.#.######.#.', '.##########.', '............'],
  calendar: ['...#....#...', '.##########.', '.##########.', '.#........#.', '.#.##..##.#.', '.#.##..##.#.', '.#........#.', '.#.##..##.#.', '.#.##..##.#.', '.#........#.', '.##########.', '............'],
  recent: ['....####....', '..##....##..', '.#........#.', '.#...#....#.', '#....#.....#', '#....#.....#', '#....####..#', '#..........#', '.#........#.', '.#........#.', '..##....##..', '....####....'],
  heart: ['............', '.###....###.', '#####..#####', '############', '############', '############', '.##########.', '..########..', '...######...', '....####....', '.....##.....', '............'],
  done: ['............', '............', '..........##', '.........##.', '........##..', '##.....##...', '.##...##....', '..##.##.....', '...###......', '....#.......', '............', '............'],
  back: ['............', '.....#......', '....##......', '...##.......', '..##........', '.##########.', '.##########.', '..##........', '...##.......', '....##......', '.....#......', '............'],
  search: ['..####......', '.######.....', '##....##....', '##....##....', '##....##....', '##....##....', '.######.....', '..######....', '......###...', '.......###..', '........###.', '.........##.'],
  undo: ['............', '...#........', '..##........', '.########...', '.#########..', '..##.....##.', '...#......##', '..........##', '..........##', '.........##.', '...#######..', '...######...'],
  moon: ['............', '...###......', '..###.......', '.###........', '.###........', '.###........', '.####.......', '.#####....#.', '.##########.', '..########..', '...######...', '............'],
  gear: ['.....##.....', '.##.####.##.', '.##########.', '..########..', '.####..####.', '####....####', '####....####', '.####..####.', '..########..', '.##########.', '.##.####.##.', '.....##.....'],
  page: ['.#######....', '.#.....##...', '.#.....#.#..', '.#.....####.', '.#........#.', '.#.######.#.', '.#........#.', '.#.######.#.', '.#........#.', '.#.######.#.', '.#........#.', '.##########.'],
};
const footIcon = (rows) => h('span', { class: 'fi', 'aria-hidden': 'true', html: pix(rows) });
const SWIPE = () => BAR();
function renderPages() { try { renderPagesNow(); } catch (err) { console.error(err); } }
function renderPagesNow() {
  const r = route(), pages = SWIPE(), at = pages.findIndex((pg) => pg.on(r)), n = freshIn('planner') + freshIn('collections') + (barKeys().includes('lab') ? 0 : labNew());
  const pagePath = (k) => ({ week: THISWEEK, todo: TASKS, shopping: SHOP })[k] || (vault.exists(k) ? k : null);
  document.body.classList.toggle('has-pages', true);
  let bar = $('.pages');
  if (!bar) bar = document.body.appendChild(h('nav', { class: 'pages', 'aria-label': 'Quick bar' }));
  bar.replaceChildren(
    h('button', { class: 'pg pg-menu' + (document.body.classList.contains('drawer-open') ? ' on' : ''), 'aria-label': 'Planner, Lists and Collections', onclick: toggleMoreMenu },
      h('span', { class: 'menu-lines', 'aria-hidden': 'true' }), n ? h('i', { class: 'tb-badge', 'aria-label': `${n} new` }, String(n)) : null),
    // the pages in a group of their own, centred, with room on both sides: ≡ and the flame stand apart
    h('div', { class: 'pg-mid' }, pages.map((pg, i) => h('a', { class: 'pg pg-page' + (i === at ? ' on' : ''), href: pg.href, 'aria-label': pg.label, title: pg.label, 'aria-current': i === at ? 'page' : null,
      oncontextmenu: (e) => contextMenu(e, [barToggle(pg.key)]),
      onclick: (e) => { if (i === at) { e.preventDefault(); if ($('.week') && weekSel) { weekSel = null; renderMain(); } scrollTo({ top: 0, behavior: 'smooth' }); } else pageDir = i > at ? 1 : -1; } },
      h('span', { class: 'pg-icon', 'aria-hidden': 'true', html: pix(ICONS[pg.key] || ICONS.page) }),
      (() => {  // red: new questions on the Lab, cards Stella filed on a list (no plain counts: Levin, 11 Nov 2026)
        const f = pg.key === 'lab' ? labNew() : pagePath(pg.key) ? freshCount(pagePath(pg.key)) : 0;
        return f ? h('i', { class: 'tb-badge pg-new', 'aria-label': `${f} new` }, String(f)) : null;
      })()))),
    h('button', { class: 'pg pg-write', 'aria-label': 'Write something down', onclick: () => openQuickAdd() }, writeIcon()),
    // one page back, above the flame for the right thumb (Levin, 9 Nov 2026); only when there is a page to go back to
    depth > 0 ? h('button', { class: 'pg-back', 'aria-label': 'Back', title: 'Back', onclick: () => { pageDir = -1; history.back(); } },
      h('span', { class: 'pg-icon', 'aria-hidden': 'true', html: pix(ICONS.back) })) : '');
}
// a sheet (a task's details, Stella, the Index …) pulled down at its top follows the finger and closes only when let go
// far enough down (or flicked); a short pull springs back. A swipe that scrolls back up to the top only scrolls: the
// pull starts in a new touch at the top (Levin, 8 Nov 2026). Pulling inside a text field or a drawing only moves that
// (a list that scrolls inside the sheet, as the flame's list of lists, counts: scrolled down, a pull only scrolls it back)
(() => {
  let y0 = null, sh = null, top0 = false, pull = 0, yl = 0, tl = 0, v = 0;
  const scrolled = (el) => { for (let n = el; n && n !== sh.parentElement; n = n.parentElement) if (n.scrollTop > 0) return true; return false; };
  const settle = (el) => { el.style.transition = 'transform .2s ease'; el.style.transform = ''; setTimeout(() => { if (!el.style.transform) el.style.transition = ''; }, 220); };
  document.addEventListener('touchstart', (e) => {
    y0 = null; pull = 0; sh = e.target.closest?.('.sheet');
    if (!sh || e.touches.length > 1 || e.target.closest('textarea, input, select, .pad-canvas, [contenteditable="true"]')) return;
    y0 = yl = e.touches[0].clientY; tl = e.timeStamp; v = 0; top0 = !scrolled(e.target);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (y0 === null || !sh) return;
    const y = e.touches[0].clientY, dy = y - y0;
    if (e.timeStamp > tl) v = (y - yl) / (e.timeStamp - tl);
    yl = y; tl = e.timeStamp;
    if (!pull && (!top0 || dy < 8 || scrolled(e.target))) return;
    e.preventDefault();
    pull = Math.max(0, dy - 8);
    sh.style.transition = 'none'; sh.style.transform = `translateY(${pull}px)`;
  }, { passive: false });
  const end = (cancel) => {
    const el = sh, p = pull;
    y0 = null; pull = 0;
    if (!el || !p) return;
    if (cancel || (p < Math.min(120, el.offsetHeight * 0.3) && !(v > 0.5 && p > 24))) return settle(el);
    el.style.transition = 'transform .18s ease'; el.style.transform = 'translateY(110%)';
    setTimeout(() => el.closest('.sheet-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true })), 170);  // the sheet's own close (as a tap beside it)
  };
  document.addEventListener('touchend', () => end(false));
  document.addEventListener('touchcancel', () => end(true));
})();
let pageDir = 0;  // which side the next page slides in from
// the phone's own back and forward swipes from the screen's edges are switched off (Levin, 8 Nov 2026: a swipe on a
// collection opens ≡ and must not also take you back to the page before); our swipes below still run
document.addEventListener('touchstart', (e) => {
  const x = e.touches[0]?.clientX ?? 50;
  if (isMobile() && (x < 24 || x > innerWidth - 24) && !e.target.closest?.('button, a, input, textarea, select, label, [contenteditable="true"], .pages, .sheet-back, #side')) e.preventDefault();
}, { passive: false });
(() => {
  let x0 = null, y0 = 0, horiz = false;
  // (a note's text can be edited in place, but only the block being edited keeps the swipe from starting)
  const blocked = (el) => el.closest?.('input, textarea, select, [contenteditable="true"]:focus, .pad-canvas, .table-wrap, .sheet, .sheet-back, #side, .pages, .drag-ghost, .ws-fixed');  // (Week's day row swipes days)
  document.addEventListener('touchstart', (e) => {
    x0 = null;
    // nor while any text is being edited or selected: dragging a selection's handle is no swipe (Levin, 11 Nov 2026)
    const ae = document.activeElement, editing = ae?.matches?.('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]') || !document.getSelection()?.isCollapsed;
    if (!isMobile() || !document.body.classList.contains('has-pages') || document.body.classList.contains('drawer-open') || e.touches.length > 1 || blocked(e.target) || editing) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; horiz = false;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (x0 === null || drag) return;
    const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
    if (!horiz && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.5) horiz = true;
    if (!horiz && Math.abs(dy) > 14) { x0 = null; return; }  // a scroll
    // the page follows the finger only when the swipe changes page (not when it opens ≡)
    if (horiz && !opensMenu(dx)) { const pg = $('#main > .page'); if (pg) { pg.style.transition = 'none'; pg.style.transform = `translateX(${dx * 0.35}px)`; pg.style.opacity = String(1 - Math.min(0.4, Math.abs(dx) / 600)); } }
  }, { passive: true });
  // Levin, 8 Nov 2026: a swipe to the right (finger moving right) opens ≡, from the Filer and from every page that is not
  // in the bar; on the bar's other pages (Today, Week, General, Shopping) it goes to the page before. A swipe to the
  // left goes to the next page in the bar, from Shopping round to the Filer.
  const here = () => SWIPE().findIndex((p) => p.on(route()));
  const opensMenu = (dx) => dx > 0 && here() <= 0;
  document.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, pg = $('#main > .page');
    x0 = null;
    if (pg) { pg.style.transition = 'transform .15s ease, opacity .15s ease'; pg.style.transform = ''; pg.style.opacity = ''; }
    if (!horiz || drag || Math.abs(dx) < 70) return;
    if (opensMenu(dx)) { toggleMoreMenu(); return; }
    const pages = SWIPE(), at = here(), next = at >= 0 && pages.length > 1 && pages[dx < 0 ? (at + 1) % pages.length : at - 1];
    if (!next) return;
    pageDir = dx < 0 ? 1 : -1;
    location.hash = next.href;
  });
})();

// ---------- quick destinations: where a new card goes, picked while writing (none = the Filer) ----------
let quickTarget = null, quickPicked = null;  // quickPicked: a list chosen under ⋯
const QUICK = () => {
  const now = new Date(), r = route();
  // on a list's page, that list comes first (and is picked when the sheet opens)
  const here = r.view === 'file' && ![INBOX, THISWEEK, TASKS, 'Lists/Shopping.md', TELL_SMO, FOR_STELLA, RESEARCH].includes(r.path) && md.fileType(r.path, vault.read(r.path) || '') === 'list';
  return [
    here && { key: 'here', label: title(r.path), path: r.path },
    quickPicked && quickPicked !== (here && r.path) && { key: 'picked', label: title(quickPicked), path: quickPicked },
    { key: 'today', label: 'Today', path: THISWEEK, due: iso(now) },
    { key: 'week', label: 'Week', path: THISWEEK },  // Week and General: Levin's names (8 Nov 2026)
    { key: 'tasks', label: 'General', path: TASKS },
    { key: 'shopping', label: 'Shopping', path: 'Lists/Shopping.md' },
    { key: 'smo', label: title(TELL_SMO), path: TELL_SMO },
    { key: 'stella', label: 'Stella', path: FOR_STELLA },  // hand it to Stella: he does it and reports under it
    { key: 'research', label: title(RESEARCH), chip: 'Research', path: RESEARCH, under: 'stella' },  // Stella takes one each night
  ].filter((q) => q && vault.exists(q.path));
};
// every other list a card can be filed into, under ⋯, in the sidebar's order (Levin, 8 Nov 2026): the planner's own
// lists, then the folders as arranged there (sub-folders after their folder), then the lists in no folder
function fileable() {
  const all = vault.list().map((f) => f.path).filter((p) => /\.md$/i.test(p)
    && ![INBOX, QUESTIONS, TODOS, RESEARCH, FOR_STELLA, THISWEEK, TASKS, 'Lists/Shopping.md', TELL_SMO, DAILIES, VOICE_ANSWERS].includes(p)
    && !HIDDEN.includes(section(p)) && ['planner', 'lists'].includes(area(p)) && md.fileType(p, vault.read(p) || '') === 'list');
  const folderOf = (p) => (area(p) === 'planner' ? null : md.splitFrontmatter(vault.read(p) || '').data.folder || null);
  const planner = all.filter((p) => area(p) === 'planner').sort(byOrder), loose = all.filter((p) => area(p) !== 'planner' && !folderOf(p)).sort(byOrder);
  const folders = [...new Set(all.map(folderOf).filter(Boolean))];
  const tops = sortFolders([...new Set(folders.map((f) => f.split('/')[0].trim()))]);
  const ordered = tops.flatMap((top) => [top, ...folders.filter((f) => f.split('/')[0].trim() === top && f.includes('/')).sort()]);
  return [...planner.map((p) => ({ p, folder: '' })),
    ...ordered.flatMap((f) => all.filter((p) => folderOf(p) === f).sort(byOrder).map((p) => ({ p, folder: f }))),
    ...loose.map((p) => ({ p, folder: '' }))];
}
let quickDay = null;  // with This week picked: which day (none = no day yet)
function quickChips(redraw) {
  const now = new Date(), d = (n) => iso(addDays(now, n));
  // This week picked: only it stays (tap it again to go back), with the coming days to choose from
  const keep = (e) => e.preventDefault();  // a chip never takes the focus from the text: the keyboard stays up
  if (quickTarget === 'week') return h('div', {},
    h('div', { class: 'quick-chips', role: 'group', 'aria-label': 'Which day' },
      h('button', { type: 'button', class: 'chip on', 'aria-pressed': 'true', onpointerdown: keep, onmousedown: keep, onclick: () => { quickTarget = null; quickDay = null; redraw(); } }, 'Week'),
      // the next seven days from tomorrow, by name (Levin, 8 Nov 2026: Today has its own chip; always the days that come next)
      [1, 2, 3, 4, 5, 6, 7].map((n) => h('button', { type: 'button', class: 'chip' + (quickDay === d(n) ? ' on' : ''), 'aria-pressed': String(quickDay === d(n)), onpointerdown: keep, onmousedown: keep,
        onclick: () => { quickDay = quickDay === d(n) ? null : d(n); redraw(); } }, weekday(d(n))))));
  const chip = (label, on, fn, extra = {}) => h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: fn, onpointerdown: keep, onmousedown: keep, ...extra }, label);
  // Stella picked: a task for him, or a research topic for his nightly run (like This week and its days)
  if (['stella', 'research'].includes(quickTarget)) return h('div', {},
    h('div', { class: 'quick-chips', role: 'group', 'aria-label': 'For Stella' },
      chip('Stella', true, () => { quickTarget = null; redraw(); }),
      QUICK().filter((q) => ['stella', 'research'].includes(q.key)).map((q) => chip(q.key === 'stella' ? 'Task' : q.chip, quickTarget === q.key, () => { quickTarget = q.key; redraw(); }))));
  // ⋯: every other list, one tap to pick it
  if (quickTarget === 'pick') return h('div', {},
    h('div', { class: 'quick-pick fi-all', role: 'group', 'aria-label': 'Another list' },
      h('div', { class: 'fi-group' }, chip('⋯', true, () => { quickTarget = null; redraw(); }, { 'aria-label': 'Back', title: 'Back' })),
      // a row a folder, its name in grey at the row's start, as in File into (Levin, 10 Nov 2026)
      (() => { const all = fileable(), gs = [];
        all.forEach(({ p, folder }, i) => { if (i === 0 || folder !== all[i - 1].folder) gs.push({ name: folder, ps: [] }); gs.at(-1).ps.push(p); });
        return gs.map((g) => h('div', { class: 'fi-group' }, g.name && h('span', { class: 'fi-label' }, g.name.replace(/\s*\/\s*/g, ' › ')),
          g.ps.map((p) => chip(title(p), quickPicked === p, () => { quickPicked = p; quickTarget = 'picked'; redraw(); })))); })()));
  return h('div', {},
    h('div', { class: 'quick-chips', role: 'group', 'aria-label': 'Where it goes' },
      // the Filer first: picked while nothing else is (that is where a card goes by default)
      chip('Filer', !quickTarget, () => { quickTarget = null; quickDay = null; redraw(); }),
      QUICK().filter((q) => !q.under).map((q) => chip(q.chip || q.label, quickTarget === q.key, () => { quickTarget = quickTarget === q.key ? null : q.key; quickDay = null; redraw(); })),
      chip('⋯', false, () => { quickTarget = 'pick'; redraw(); }, { 'aria-label': 'Another list', title: 'Another list' })));
}
// a written card goes to the picked place (a day prefix still wins over Today/Tomorrow), or onto the Filer
function placeCard(text, due, notes = '') {
  let q = QUICK().find((x) => x.key === quickTarget);
  // a plan for several days ("Monday gym, Wednesday dentist") goes via the Filer, where Stella splits it into days
  if (q?.key === 'week' && !due && (text.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|tomorrow|morgen)\b/gi) || []).length >= 2) {
    text = 'This week: ' + text; q = null;
  }
  const d = due || q?.due || (q?.key === 'week' ? quickDay : null);
  const path = q ? (q.path === TASKS && d ? THISWEEK : q.path) : INBOX;  // a day sends it to This week, never into the backlog
  if (path === SHOP) { update(SHOP, (t) => shopAdd(t, text)); quickTarget = null; return q.label; }
  update(path, (t) => {
    // a list of plain items (no tick boxes) gets a plain item
    const segs = md.parseList(t), checkbox = segs.some((x) => x.kind === 'item' && x.checkbox) || !segs.some((x) => x.kind === 'item');
    t = md.addItem(t, text + (d ? ` 📅 ${d}` : ''), { top: true, checkbox });
    const item = notes.trim() && md.parseList(t).find((x) => x.kind === 'item');
    return item ? md.setItemNotes(t, item, notes) : t;
  });
  quickTarget = null; quickDay = null; quickPicked = null;
  return q ? q.label : null;
}

// ≡ in the bar: the sheet with Planner and Collections, on the tab last picked in it (Levin, 10 Nov 2026)
function toggleMoreMenu() {
  if (document.body.classList.contains('drawer-open')) { closeDrawer(); return; }
  renderSide(); openDrawer();
}

// quick capture from any page: text or voice, onto the Filer (a day prefix still sets the date)
// writing something down, from any page: text, voice, a drawing, and where it goes (none = the Filer)
function openQuickAdd(preset = null) {
  $('.sheet-back')?.remove();
  // on a list's page, that list is picked (This week, General To-Do, Shopping or any other list); a menu can pick one too
  const r = route(), here = r.view === 'file' && QUICK().find((q) => q.path === r.path && !q.due);
  quickPicked = null;
  // (and on Today, Today: Levin, 13 Nov 2026)
  quickTarget = preset || (here ? here.key : r.view === 'day' ? 'today' : null);
  const close = () => { live?.rec.abort(); live = null; back.remove(); window.__sheetRedraw = null; pad = null; drawOpen = false; };
  // like Google Tasks: the keyboard's return key sends it (Shift+Return on the Mac starts a line of notes)
  const grow = () => { area.style.height = 'auto'; area.style.height = area.scrollHeight + 'px'; };
  const area = h('textarea', { rows: 1, placeholder: 'New card', class: 'qa-text', 'aria-label': 'New card', enterkeyhint: 'done',
    title: 'MO:, morgen:, 7.11: at the start sets the day',
    oninput: grow, onkeydown: (e) => { shiftHeld = e.shiftKey; sendOnEnter(() => submit())(e); },
    // while dictating, the iPhone's tick arrives as a line break, not as Return: it files the card too (Levin, 11 Nov 2026)
    onbeforeinput: (e) => { if (/^insert(LineBreak|Paragraph)$/.test(e.inputType) && !shiftHeld) { e.preventDefault(); submit(); } } });
  let shiftHeld = false;
  const body = h('div', {});
  // (wrapped in h() so an empty slot stays empty: replaceChildren would print "null")
  const draw = () => {
    const typing = document.activeElement === area;
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
    if (typing && document.activeElement !== area) area.focus({ preventScroll: true });
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
    op((t, g) => { const u = md.setItemFields(t, g.line, date ? { due: date } : { due: null, time: null, repeat: null }); return date && date !== g.due && !g.indent ? md.toTop(u, g) : u; });
  };
  const body = h('div', {});
  let tTimer, nTimer, weekOpen = null;
  const draw = () => {
    const f = get(); if (!f) { close(); return; }
    // Week: the seven days from tomorrow, by name, as on the flame (Levin, 11 Nov 2026)
    const now = new Date(), today = iso(now), nextWeek = [1, 2, 3, 4, 5, 6, 7].map((n) => iso(addDays(now, n)));
    if (weekOpen === null) weekOpen = nextWeek.includes(f.due);
    const chip = (label, on, fn, extra = {}) => h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: fn, ...extra }, label);
    const titleEl = h('textarea', { class: 'ts-title', rows: 1, enterkeyhint: 'done', 'aria-label': 'Task', spellcheck: true,
      oninput: (e) => { grow(e.target); clearTimeout(tTimer); tTimer = setTimeout(() => saveTitle(e.target.value), 600); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      onblur: (e) => { clearTimeout(tTimer); saveTitle(e.target.value); } });
    titleEl.value = f.text;
    const saveTitle = (v) => { v = v.replace(/\s*\n\s*/g, ' ').trim(); if (v && v !== cur.text) op((t, g) => md.setItemText(t, g.line, v), { redraw: false }); };
    const notesEl = h('textarea', { class: 'ts-notes', rows: 1, placeholder: 'Details', 'aria-label': 'Details', enterkeyhint: 'done',
      onkeydown: sendOnEnter((e) => e.target.blur()),
      oninput: (e) => { grow(e.target); clearTimeout(nTimer); nTimer = setTimeout(() => saveNotes(e.target.value), 600); },
      onblur: (e) => { clearTimeout(nTimer); saveNotes(e.target.value); } });
    notesEl.value = f.notes.map((n) => n.text).join('\n');
    const saveNotes = (v) => { const g = get(); if (g && v.trim() !== g.notes.map((n) => n.text).join('\n').trim()) op((t, x) => md.setItemNotes(t, x, v), { redraw: false }); };
    const kids = f.children.filter((c) => c.kind !== 'md');
    const addEl = h('input', { class: 'ts-add', placeholder: 'Add sub-task', enterkeyhint: 'done', 'aria-label': 'Add sub-task',
      onkeydown: (e) => { if (e.key !== 'Enter') return; e.preventDefault(); const v = e.target.value.trim(); if (!v) return; focusAdd = true; op((t, g) => md.addItem(t, v, { parent: g })); } });
    body.replaceChildren(h('div', {},
      titleEl, notesEl,
      // only details and sub-tasks (Levin, 13 Nov 2026: no date row; days are set through File into or the flame)
      h('div', { class: 'ts-subs' },
        kids.map((c) => h('div', { class: 'ts-sub' + (c.checked ? ' done' : '') },
          c.checkbox && checkbox(c.checked, () => op((t) => { const g = md.findItem(t, c); return g ? md.toggleItem(t, g.line) : t; }), true),
          editableText(c.text, (v) => op((t) => { const g = md.findItem(t, c); return !g ? t : v ? md.setItemText(t, g.line, v) : md.deleteItem(t, g); })))),
        addEl),
      h('div', { class: 'ts-bar' },
        h('button', { type: 'button', class: 'ts-btn', 'aria-label': 'File into another list', title: 'File into…', onclick: () => { close(); openMoveSheet(path, get()); } }, '⇢'),
        h('button', { type: 'button', class: 'ts-btn danger', 'aria-label': 'Delete', title: 'Delete', onclick: () => { const g = get(); close(); withUndo('Deleted', [path], () => update(path, (t) => { const x = md.findItem(t, g); return x ? md.deleteItem(t, x) : t; })); } }, '⌫'),
        // back: leaves the task as it is, without ticking it and without a tap beside the sheet (little room beside it with
        // the keyboard up) (Levin, 9 Nov 2026); what was typed is saved
        h('button', { type: 'button', class: 'ts-back', 'aria-label': 'Back', title: 'Back', onclick: () => { document.activeElement?.blur?.(); close(); } },
          h('span', { class: 'pg-icon', 'aria-hidden': 'true', html: pix(ICONS.back) })),
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
// `where`: after a move, a short line above Undo says where it went, and fades after two seconds (Levin, 8 Nov 2026)
function toast(text, undo, ms = undo ? 4000 : 1400, where = null) {
  $('.toast')?.remove(); $('.toast-where')?.remove();
  if (where) { const w = h('div', { class: 'toast-where', role: 'status' }, where); document.body.append(w); setTimeout(() => w.remove(), 2500); }
  const el = undo
    ? h('div', { class: 'toast toast-only-undo', role: 'status', 'aria-live': 'polite' },
      h('button', { class: 'toast-undo', 'aria-label': `Undo: ${text}`, onclick: () => { undo(); el.remove(); } }, 'Undo'))
    : h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, h('span', {}, text));
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), ms);
}
// run `fn` as one step of the undo history, and offer to take it back at once
function withUndo(text, paths, fn) {
  steps.push({ at: Date.now(), files: new Map(), held: true });
  try { fn(); } finally { if (steps.at(-1)) steps.at(-1).held = false; }
  // a move says where it went: "Filed in Shopping", "In This week, tomorrow", "Moved to Tuesday"
  toast(text, undoLast, undefined, /^(Filed in|Moved to|Today$|Tomorrow$)/.test(text) ? (/^(Today|Tomorrow)$/.test(text) ? `Moved to ${text.toLowerCase()}` : text) : null);
}

// ---------- the undo history (Levin, 8 Nov 2026: a back button that turns things back more than once) ----------
// every change made here (ticking, writing, moving, filing, deleting) is a step; ↶ (in ≡ on the phone, Cmd+Z on the
// Mac) takes back the last one, again and again. Changes arriving from other devices meanwhile are kept (3-way merge).
const steps = [];
let undoing = false;
for (const [name, after] of [['write', (p, c) => c], ['remove', () => null]]) {
  const orig = vault[name].bind(vault);
  vault[name] = async (path, content) => {
    const before = vault.exists(path) ? vault.read(path) : null, next = after(path, content);
    if (!undoing && !(content instanceof Blob) && before !== next && !/^(attachments|System)\//.test(path)) {
      let step = steps.at(-1);
      if (!step || (!step.held && Date.now() - step.at > 700)) steps.push(step = { at: Date.now(), files: new Map() });
      const f = step.files.get(path);
      step.files.set(path, { before: f ? f.before : before, after: next });
      if (steps.length > 40) steps.shift();
    }
    // what Levin adds himself to Claude To-do or the questions is seen already: red is only for what Stella adds
    const mine = !undoing && [TODOS, QUESTIONS].includes(path) && !(content instanceof Blob) ? openTexts(path) : null;
    const r = await orig(path, content);
    if (mine) {
      const add = openTexts(path).filter((t) => !mine.includes(t)), k = path === TODOS ? 'seenTodos' : 'seenLab';
      if (add.length) { ui[k] = [...(ui[k] || []), ...add]; saveUi(); }
    }
    return r;
  };
}
async function undoLast() {
  const step = steps.pop();
  if (!step) return toast('Nothing to undo');
  undoing = true;
  try {
    for (const [path, { before, after }] of [...step.files].reverse()) {
      const now = vault.exists(path) ? vault.read(path) : null;
      if (before == null) { if (now != null) await vault.remove(path); continue; }  // it was made in this step
      await vault.write(path, now == null || now === after || after == null ? before : merge3(after, now, before));
    }
  } finally { undoing = false; }
  const names = [...new Set([...step.files.keys()].map(title))];
  toast(`Undone · ${names.slice(0, 2).join(', ')}${names.length > 2 ? ' …' : ''}`);
  renderSide(); renderTabbar();
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
  // Cmd+Z takes back the last change, again and again (in a text field the field's own undo applies)
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && vault.backend && !e.target.closest?.('input, textarea, [contenteditable="true"]')) { e.preventDefault(); undoLast(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') { closeDrawer(); $('.sheet-back')?.remove(); return; }
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  const go = { n: '#/', t: '#/day', w: fileHref(THISWEEK), l: '#/lab' }[e.key.toLowerCase()];
  if (e.key.toLowerCase() === 'n') { e.preventDefault(); openQuickAdd(); return; }
  if (go) { e.preventDefault(); location.hash = go; }
});

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

function renameFile(path) {
  const name = prompt('Rename', title(path)); if (!name?.trim() || name.trim() === title(path)) return;
  update(path, (t) => {
    const fm = md.splitFrontmatter(t);
    const head = t.startsWith('---\n') ? t.slice(4, t.indexOf('\n---', 3)) : '';
    const lines = head.split('\n').filter((l) => l.trim() && !/^title:/.test(l));
    return `---\n${[...lines, `title: ${name.trim()}`].join('\n')}\n---\n` + t.slice(fm.bodyStart).replace(/^\n?/, '\n');
  });
}
// a folder is a label in its files' frontmatter: renaming it changes that label in each of them (sub-folders too)
function renameFolder(label) {
  const name = prompt('Rename folder', label.split('/').pop()); if (!name?.trim() || name.trim() === label.split('/').pop()) return;
  const to = [...label.split('/').slice(0, -1), name.trim().replace(/\//g, '-')].join('/');
  for (const f of vault.list()) {
    if (!/\.md$/i.test(f.path)) continue;
    const cur = md.splitFrontmatter(f.content || '').data.folder;
    if (cur && (cur === label || cur.startsWith(label + '/'))) update(f.path, (t) => t.replace(/^folder: .*$/m, `folder: ${to}${cur.slice(label.length)}`));
  }
  const order = folderOrder(); if (order.includes(label)) vault.write(FOLDERS, '---\ntype: order\n---\n' + order.map((x) => `- ${x === label ? to : x}`).join('\n') + '\n');
}
// a list's ticked items, gone (from the bottom, re-reading after each so nested ones stay in step)
function clearCompleted(path) {
  update(path, (t) => {
    const lastDone = (nodes) => nodes.reduce((hit, n) => (n.kind === 'item' && lastDone(n.children || [])) || (n.kind === 'item' && n.checkbox && n.checked ? n : null) || hit, null);
    let x = t, it; while ((it = lastDone(md.parseList(x)))) x = md.deleteItem(x, it); return x;
  });
}
// "Clear completed" where the ticked items come from several lists (Today's one Completed, a day's done items in Week)
function clearItems(items) {
  const paths = [...new Set(items.map((x) => x.path))];
  if (!items.length || !confirm(`Delete ${items.length} completed?`)) return;
  withUndo('Cleared', paths, () => { for (const x of items) update(x.path, (t) => { const f = md.findItem(t, x); return f && f.checked ? md.deleteItem(t, f) : t; }); });
}
const copyText = (text, what = 'Copied') => navigator.clipboard?.writeText(text).then(() => toast(what), () => toast('Couldn’t copy'));
// put a list or note into a folder (its `folder:` label), picked from the folders of its tab, or a new one
function openFolderSheet(path) {
  $('.sheet-back')?.remove();
  const tabOf = (p) => (area(p) === 'lists' ? 'lists' : 'collections');
  const labels = [...new Set(vault.list().map((f) => f.path).filter((p) => /\.md$/i.test(p) && tabOf(p) === tabOf(path) && !['planner', 'lab', 'hidden'].includes(area(p)))
    .map((p) => md.splitFrontmatter(vault.read(p) || '').data.folder).filter(Boolean))].sort();
  const cur = md.splitFrontmatter(vault.read(path) || '').data.folder || null;
  const put = (folder) => { close(); update(path, (t) => md.setFrontmatterKey(t, 'folder', folder)); toast(folder ? `In ${folder.replace(/\//g, ' › ')}` : 'In no folder'); };
  const close = () => back.remove();
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Move to folder' },
      h('div', { class: 'sheet-head' }, h('span', { class: 'label' }, title(path)), h('button', { class: 'quiet', 'aria-label': 'Close', onclick: close }, '×')),
      labels.map((l) => h('button', { class: 'sheet-item' + (l === cur ? ' on' : ''), style: l.includes('/') ? `padding-left:${(l.split('/').length - 1) * 18}px` : null, onclick: () => put(l) }, l.split('/').pop())),
      h('button', { class: 'sheet-item', onclick: () => { const n = prompt('New folder'); if (n?.trim()) put(n.trim()); } }, '+ New folder'),
      cur && h('button', { class: 'sheet-item', onclick: () => put(null) }, 'No folder')));
  document.body.append(back);
}

// a folder into another folder, or to the top: its label changes in every file inside
function relabelFolder(label, to) {
  for (const f of vault.list()) {
    if (!/\.md$/i.test(f.path)) continue;
    const cur = md.splitFrontmatter(f.content || '').data.folder;
    if (cur && (cur === label || cur.startsWith(label + '/'))) update(f.path, (t) => t.replace(/^folder: .*$/m, `folder: ${to}${cur.slice(label.length)}`));
  }
}
function openFolderMoveSheet(label, tab) {
  $('.sheet-back')?.remove();
  const tabOf = (p) => (area(p) === 'lists' ? 'lists' : 'collections');
  const labels = [...new Set(vault.list().map((f) => f.path).filter((p) => /\.md$/i.test(p) && tabOf(p) === tab && !['planner', 'lab', 'hidden'].includes(area(p)))
    .map((p) => md.splitFrontmatter(vault.read(p) || '').data.folder).filter(Boolean)
    .flatMap((l) => l.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))))].filter((l) => l !== label && !l.startsWith(label + '/')).sort();
  const name = label.split('/').pop(), parent = label.includes('/') ? label.slice(0, label.lastIndexOf('/')) : null;
  const put = (into) => { close(); const to = into ? `${into}/${name}` : name; if (to !== label) relabelFolder(label, to); toast(into ? `In ${into.replace(/\//g, ' › ')}` : 'At the top'); };
  const close = () => back.remove();
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Move folder' },
      h('div', { class: 'sheet-head' }, h('span', { class: 'label' }, name), h('button', { class: 'quiet', 'aria-label': 'Close', onclick: close }, '×')),
      parent && h('button', { class: 'sheet-item', onclick: () => put(null) }, 'To the top'),
      labels.filter((l) => l !== parent).map((l) => h('button', { class: 'sheet-item', style: l.includes('/') ? `padding-left:${(l.split('/').length - 1) * 18}px` : null, onclick: () => put(l) }, l.split('/').pop()))));
  document.body.append(back);
}

// the phone: holding a page, list or folder opens the same menu as a right-click on the Mac.
// Not an entry (Levin, 8 Nov 2026): holding an entry lifts it to move it; its options are behind ···
(() => {
  let timer = null, x0 = 0, y0 = 0, fired = false;
  const target = (el) => el.closest?.('#side .nav-item, #side .folder-head, .pages .pg-page, .person-link');
  document.addEventListener('touchstart', (e) => {
    clearTimeout(timer); fired = false;
    const el = isMobile() && target(e.target); if (!el || e.target.closest('input, textarea, select, .check, [contenteditable="true"]:focus')) return;
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY;
    timer = setTimeout(() => { fired = true; navigator.vibrate?.(10); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x0, clientY: y0 })); }, 500);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (Math.abs(t.clientX - x0) > 10 || Math.abs(t.clientY - y0) > 10) clearTimeout(timer); }, { passive: true });
  document.addEventListener('touchend', () => clearTimeout(timer));
  document.addEventListener('click', (e) => { if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); } }, true);  // the hold isn't a tap
})();

// right-click (Mac): a small menu at the pointer
function contextMenu(e, items) {
  if (!items.filter(Boolean).length) return;
  e.preventDefault();
  $('.ctx-menu')?.remove();
  const menu = h('div', { class: 'ctx-menu', role: 'menu' }, items.filter(Boolean).map(([label, fn, cls]) => h('button', { class: 'ctx-item ' + (cls || ''), role: 'menuitem', onclick: () => { menu.remove(); fn(); } }, label)));
  document.body.append(menu);
  const w = menu.offsetWidth, ht = menu.offsetHeight;
  Object.assign(menu.style, { left: Math.min(e.clientX, innerWidth - w - 8) + 'px', top: Math.min(e.clientY, innerHeight - ht - 8) + 'px' });
  setTimeout(() => { addEventListener('click', () => menu.remove(), { once: true }); addEventListener('contextmenu', () => menu.remove(), { once: true, capture: true }); }, 0);
}

function fileLink(path, active, group = null) {
  const el = h('a', { class: 'nav-item' + (path === active ? ' active' : ''), href: fileHref(path), draggable: 'true' },
    h('span', { class: 'nav-name' }, title(path)), h('span', { class: 'nav-badge' }, badge(path)));
  el.addEventListener('dragstart', (e) => { dragPath = path; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', title(path)); el.classList.add('dragging'); });
  el.addEventListener('dragend', () => { dragPath = null; el.classList.remove('dragging'); });
  el.addEventListener('contextmenu', (e) => {
    const type = md.fileType(path, vault.read(path) || ''), done = type === 'list' && md.parseList(vault.read(path) || '').some((x) => x.kind === 'item' && x.checked);
    const core = [THISWEEK, TASKS, SHOP].includes(path);  // the planner's own lists: not moved or deleted from here
    contextMenu(e, [
      type === 'list' && ['Add a task here', () => { location.hash = fileHref(path); setTimeout(() => openQuickAdd(), 50); }],
      ['Rename', () => renameFile(path)],
      area(path) !== 'planner' && ['Move to folder…', () => openFolderSheet(path)],
      type === 'list' && !core && [area(path) === 'planner' ? 'Move to Lists' : 'Move to Planner', () => setArea(path, area(path) === 'planner' ? 'lists' : 'planner')],
      type === 'list' && ['Sort one by one', () => { location.hash = `#/sort/${encodeURIComponent(path)}`; }],
      done && ['Clear completed', () => { if (confirm(`Clear the ticked items in “${title(path)}”?`)) withUndo('Cleared', [path], () => clearCompleted(path)); }],
      ['Copy as text', () => copyText((vault.read(path) || '').slice(md.splitFrontmatter(vault.read(path) || '').bodyStart).trim(), 'Copied as text')],
      barToggle(barKey(path)),
      !core && ['Delete', async () => { if (!confirm(`Delete “${title(path)}”? It stays in the repository history.`)) return; await vault.remove(path); if (route().path === path) location.hash = '#/'; }, 'danger'],
    ]);
  });
  // dropped on another item: join its place (Planner or Lists, its folder) just above it
  return dropZone(el, (p) => p !== path && placeFile(p, { sectionName: section(path), planner: area(path) === 'planner',
    folder: md.splitFrontmatter(vault.read(path) || '').data.folder || null, before: path, group }));
}

// `label` is set for folders made from `folder:` labels (nested with "/", e.g. "To get/Watch List")
const FOLDERS = 'System/Folders.md';  // the panel's folder order, one name per line ("- Academia"); dragging a folder changes it
const folderOrder = () => (vault.read(FOLDERS) || '').split('\n').map((l) => l.match(/^- (.+)$/)?.[1]?.trim()).filter(Boolean);
const sortFolders = (names) => { const o = folderOrder(); return [...names].sort((a, b) => ((o.indexOf(a) + 1 || 1e4) - (o.indexOf(b) + 1 || 1e4)) || a.localeCompare(b)); };
function moveFolder(name, before, all) {
  const order = sortFolders(all).filter((x) => x !== name);
  order.splice(before && order.includes(before) ? order.indexOf(before) : order.length, 0, name);
  const rest = folderOrder().filter((x) => !order.includes(x));
  vault.write(FOLDERS, '---\ntype: order\n---\n' + [...order, ...rest].map((x) => `- ${x}`).join('\n') + '\n');
}
let dragFolder = null;
let folderUpAt = 0;
function folderBlock(name, node, active, prefix, depth, label = null, siblings = null) {
  const key = prefix + name;
  // the folder of the open list opens by itself, but closes when Levin closes it, while he stays on that list (10 Nov 2026)
  const inside = active && (active.startsWith(key + '/') || node.files.includes(active));
  const open = ui.open[key] === true || (inside && !(ui.open[key] === false && ui.shutOn?.[key] === active));
  const files = [...node.files].sort(byOrder);
  const count = files.length + Object.keys(node.dirs).length;
  const toggle = () => { ui.open[key] = !open; (ui.shutOn ||= {})[key] = open ? active : null; saveUi(); renderSide(); };
  const head = h('div', { class: 'folder' },
    h('button', { class: 'folder-head' + (open ? ' open' : ''), style: depth ? `margin-left:${depth * 14}px; width:calc(100% - ${depth * 14}px)` : null,
      onclick: () => { if (Date.now() - folderUpAt > 500) toggle(); } },  // (on the Mac a top folder toggles on mouseup, below)
      h('span', { class: 'caret' }, open ? '–' : '+'), h('span', { class: 'nav-name' }, name),
      (() => { const all = (n) => [...n.files, ...Object.values(n.dirs).flatMap(all)], f = all(node).reduce((k, p) => k + freshCount(p), 0);
        return f ? h('i', { class: 'nav-new', 'aria-label': `${f} new` }, String(f)) : h('span', { class: 'nav-badge' }, count); })()),
    open && h('div', { class: 'folder-body', style: depth ? `margin-left:${depth * 14}px` : null },
      sortFolders(Object.keys(node.dirs)).map((d) => folderBlock(d, node.dirs[d], active, key + '/', label ? depth + 1 : 0, label && `${label}/${d}`)),
      files.map((p) => fileLink(p, active, files))));
  // a labelled folder: dropping a list on its heading files it there (Collections keep the note's own section)
  if (label) dropZone(head.firstChild, (p) => placeFile(p, { sectionName: prefix.startsWith('Collections') ? null : prefix.split('/')[0], folder: label, group: files }));
  if (label) head.firstChild.addEventListener('contextmenu', (e) => contextMenu(e, [
    ['Rename', () => renameFolder(label)],
    ['Move to…', () => openFolderMoveSheet(label, prefix.startsWith('Lists') ? 'lists' : 'collections')],
    prefix.startsWith('Lists') && ['New list here', async () => {
      const n = prompt('New list'); if (!n?.trim()) return;
      const p = `Lists/${n.trim().replace(/[\\/:]/g, '-')}.md`;
      try { await vault.create(p, `---\nfolder: ${label}\n---\n`); location.hash = fileHref(p); } catch (err) { alert(err.message); }
    }],
    !depth && siblings && ['Move to the top', () => moveFolder(name, sortFolders(siblings)[0], siblings)],
  ]));
  // a top-level folder can be dragged up or down with the mouse to reorder them (Safari won't drag a button natively)
  if (label && !depth && siblings && !isMobile()) {
    const b = head.firstChild;
    b.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const y0 = e.clientY; let ghost = null, line = null, before;
      const heads = () => [...document.querySelectorAll('#side .folder-head[data-top]')].filter((x) => x.dataset.top !== name);  // survives a redraw
      const move = (ev) => {
        if (!ghost && Math.abs(ev.clientY - y0) < 6) return;
        if (!ghost) {
          const r = b.getBoundingClientRect();
          ghost = b.cloneNode(true); ghost.classList.add('drag-ghost'); Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px' });
          line = h('div', { class: 'drop-line' }); document.body.append(ghost, line); document.body.classList.add('dragging'); b.classList.add('drag-src-head');
        }
        ghost.style.transform = `translateY(${ev.clientY - y0}px)`;
        const hs = heads(), next = hs.find((x) => { const r = x.getBoundingClientRect(); return r.top + r.height / 2 > ev.clientY; });
        before = next?.dataset.top || null;
        const ref = (next || hs[hs.length - 1])?.getBoundingClientRect();
        if (ref) Object.assign(line.style, { top: (next ? ref.top : ref.bottom) - 1 + 'px', left: ref.left + 'px', width: ref.width + 'px' });
      };
      const up = (ev) => {
        removeEventListener('mousemove', move); removeEventListener('mouseup', up);
        // not dragged: a click. Toggled here, since Safari dropped the click on these (Levin, 10 Nov 2026: the Mac
        // couldn't close a folder); the click that may follow is then ignored
        if (!ghost) { if (b.contains(ev.target)) { folderUpAt = Date.now(); toggle(); } return; }
        ghost.remove(); line.remove(); document.body.classList.remove('dragging'); b.classList.remove('drag-src-head');
        b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopImmediatePropagation(); }, { capture: true, once: true });  // a drag isn't a click
        if (before !== name) moveFolder(name, before, siblings);
      };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
    b.dataset.top = name;
  }
  return head;
}

// the app icon's 10×10 flame, drawn in ink with a grey core
const flameMark = () => h('span', { class: 'flame', html: `<svg viewBox="0 0 10 10" shape-rendering="crispEdges" width="100%" height="100%"><path fill="var(--ink)" d="M4 1h1v1h-1zM5 1h1v1h-1zM4 2h1v1h-1zM5 2h1v1h-1zM4 3h1v1h-1zM5 3h1v1h-1zM6 3h1v1h-1zM8 3h1v1h-1zM2 4h1v1h-1zM3 4h1v1h-1zM4 4h1v1h-1zM6 4h1v1h-1zM7 4h1v1h-1zM8 4h1v1h-1zM2 5h1v1h-1zM3 5h1v1h-1zM6 5h1v1h-1zM7 5h1v1h-1zM8 5h1v1h-1zM1 6h1v1h-1zM2 6h1v1h-1zM7 6h1v1h-1zM8 6h1v1h-1zM2 7h1v1h-1zM7 7h1v1h-1zM8 7h1v1h-1zM2 8h1v1h-1zM3 8h1v1h-1zM6 8h1v1h-1zM7 8h1v1h-1zM3 9h1v1h-1zM4 9h1v1h-1zM5 9h1v1h-1zM6 9h1v1h-1z"/><path fill="var(--faint)" d="M5 4h1v1h-1zM4 5h1v1h-1zM5 5h1v1h-1zM3 6h1v1h-1zM4 6h1v1h-1zM5 6h1v1h-1zM6 6h1v1h-1zM3 7h1v1h-1zM4 7h1v1h-1zM5 7h1v1h-1zM6 7h1v1h-1zM4 8h1v1h-1zM5 8h1v1h-1z"/></svg>` });

// two tabs (Levin, 8 Nov 2026): Planner (the pages and every list, in folders) and Collections (notes and trackers, to look at)
const TABS = [['planner', 'Planner'], ['collections', 'Collections']];
// switching tabs; `dir` slides the new one in from that side (a swipe on the phone)
function showTab(k, dir = 0) {
  ui.tab = k; saveUi(); renderSide();
  const nav = $('#side .nav');
  if (nav) nav.scrollTop = 0;
  if (dir && nav) { nav.classList.add(dir > 0 ? 'from-right' : 'from-left'); nav.addEventListener('animationend', () => nav.classList.remove('from-right', 'from-left'), { once: true }); }
}

// the planner's pages in Levin's order: the sidebar's top on the Mac, the row you swipe through on the phone
const PAGES = () => [
  // the Lab is home: the Filer's cards are in it, so its number is theirs (new questions show in red)
  { key: 'lab', label: 'Lab', href: '#/', on: (r) => r.view === 'today', count: () => md.parseList(vault.read(INBOX) || '').filter((s) => s.kind === 'item' && !s.checked).length || '' },
  { key: 'recent', label: 'Recent', href: '#/recent', on: (r) => r.view === 'recent', count: () => '' },
  { key: 'day', label: 'Today', href: '#/day', on: (r) => r.view === 'day', count: () => dueItems().filter((x) => x.due <= iso(new Date())).length || '' },
  { key: 'week', label: 'Week', href: fileHref(THISWEEK), on: (r) => r.view === 'file' && r.path === THISWEEK, count: () => '' },
  { key: 'todo', label: 'General', href: fileHref(TASKS), on: (r) => r.view === 'file' && r.path === TASKS, count: () => md.countOpen(vault.read(TASKS) || '') || '' },
  { key: 'shopping', label: 'Shopping', href: fileHref('Lists/Shopping.md'), on: (r) => r.view === 'file' && r.path === 'Lists/Shopping.md', count: () => md.countOpen(vault.read('Lists/Shopping.md') || '') || '' },
];

// a search hit opens its page at the very entry it was found in (Levin, 11 Nov 2026): the first place the word appears
// in the page (after its title) comes into the middle of the screen and its line lights up for a moment
let pendingFind = '';
function jumpToFound() {
  const q = pendingFind; pendingFind = '';
  const page = $('#main .page') || $('#main');
  if (!q || !page) return;
  const walk = document.createTreeWalker(page, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement.closest('.page-head, script, style') ? NodeFilter.FILTER_REJECT : n.nodeValue.toLowerCase().includes(q) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
  const node = walk.nextNode();
  if (!node) return;
  for (let d = node.parentElement.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])')) d.open = true;
  const block = node.parentElement.closest('.item, .usual-item, .blk, li, tr, p, h1, h2, h3, h4, h5, h6, td') || node.parentElement;
  block.scrollIntoView({ block: 'center' });
  block.classList.remove('found-flash'); void block.offsetWidth; block.classList.add('found-flash');
  setTimeout(() => block.classList.remove('found-flash'), 2400);
}
function renderSide() { try { renderSideNow(); } catch (err) { console.error(err); } }
function renderSideNow() {
  if (!vault.backend) { $('#side').replaceChildren(h('div', { class: 'brand' }, h('a', { href: '#/' }, APP_NAME))); return; }
  const r = route();
  const active = r.view === 'file' ? r.path : null;
  const side = $('#side');
  const q = query.trim().toLowerCase();
  let nav, tabs = null;
  if (q) {
    // search (Levin, 8 Nov 2026): what is found, in Planner and in Collections; under each, the line it was found in,
    // without its Markdown marks, the word in bold
    const clean = (l) => l.replace(/^\s*([-*+]\s+)?(\[[ xX]\]\s+)?|^\s*#+\s+|^\s*\d+\.\s+/g, '').replace(/\s*(📅|⏰|🔁|✅)\s*\S+/gu, '')
      .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1').replace(/\*\*|__|`|^\s*\|\s*|\s*\|\s*$/g, '').replace(/\s*\|\s*/g, ' · ').trim();
    const hits = vault.list().filter((f) => /\.md$/i.test(f.path) && !['System', 'Backups'].includes(section(f.path)) && area(f.path) !== 'hidden').map((f) => {
      const t = f.content || '', body = t.slice(md.splitFrontmatter(t).bodyStart);
      const inTitle = title(f.path).toLowerCase().includes(q);
      const line = body.split('\n').find((l) => l.toLowerCase().includes(q));
      if (!inTitle && !line) return null;
      const c = line ? clean(line) : '', i = c.toLowerCase().indexOf(q), from = i > 34 ? i - 26 : 0;
      return { path: f.path, inTitle, tab: area(f.path) === 'collections' && f.path !== INBOX ? 'collections' : 'planner',
        snip: i < 0 ? (c ? [c] : []) : [(from ? '…' : '') + c.slice(from, i), h('b', {}, c.slice(i, i + q.length)), c.slice(i + q.length)] };
    }).filter(Boolean).sort((a, b) => b.inTitle - a.inTitle).slice(0, 80);
    const group = (tab, name) => {
      const xs = hits.filter((x) => x.tab === tab);
      return xs.length > 0 && h('div', { class: 'section' }, h('div', { class: 'label' }, h('span', {}, `${name} · ${xs.length}`)),
        xs.map((x) => h('a', { class: 'nav-item hit' + (x.path === active ? ' active' : ''), href: fileHref(x.path),
          onclick: (e) => { pendingFind = q; if (x.path === active) { e.preventDefault(); closeDrawer(); setTimeout(jumpToFound, 60); } } },
          h('span', { class: 'nav-name' }, title(x.path)), x.snip.length > 0 && h('span', { class: 'hit-snip' }, x.snip))));
    };
    nav = h('nav', { class: 'nav' }, group('planner', 'Planner'), group('collections', 'Collections'), !hits.length && h('p', { class: 'empty-note' }, 'Nothing found.'));
  } else {
    const t = tree();
    const open = (md.parseList(vault.read(INBOX) || '')).filter((s) => s.kind === 'item' && !s.checked).length;
    const others = Object.keys(t.dirs).filter((d) => !SECTIONS.includes(d)).sort((a, b) => (a === 'Archive') - (b === 'Archive') || a.localeCompare(b));
    const planner = vault.list().map((f) => f.path).filter((p) => /\.md$/i.test(p) && ![INBOX, QUESTIONS, TODOS, RESEARCH, FOR_STELLA, TELL_SMO, DAILIES].includes(p) && !HIDDEN.includes(section(p)) && area(p) === 'planner').sort(byOrder);
    const kept = (files) => [...files].filter((p) => p !== PEOPLE && !['planner', 'lab', 'hidden'].includes(area(p))).sort(byOrder);  // People sits under the Lab
    const plannerLoose = [], plannerGroups = {};
    for (const p of planner) { const g = md.splitFrontmatter(vault.read(p) || '').data.folder; g ? (plannerGroups[g] ||= []).push(p) : plannerLoose.push(p); }
    const sectionBlock = (s, files = t.dirs[s]?.files || [], prefix = s + '/~') => h('div', { class: 'section' },
        // `folder:` in a file's frontmatter groups it in the sidebar; the file itself stays put (other tools read it by path)
        (() => {
          const loose = [], labelled = {};
          for (const p of kept(files)) {
            const f = md.splitFrontmatter(vault.read(p) || '').data.folder;
            if (!f) { loose.push(p); continue; }
            const [top, ...sub] = f.split('/').map((x) => x.trim());
            let node = labelled[top] ||= { files: [], dirs: {} };
            for (const d of sub) node = node.dirs[d] ||= { files: [], dirs: {} };
            node.files.push(p);
          }
          return [
            sortFolders(Object.keys(labelled)).map((f) => folderBlock(f, labelled[f], active, prefix, 0, f, Object.keys(labelled))),
            loose.map((p) => fileLink(p, active, loose)),
          ];
        })(),
        prefix === s + '/~' && Object.keys(t.dirs[s]?.dirs || {}).sort().map((d) => folderBlock(d, t.dirs[s].dirs[d], active, s + '/', 0)));
    const tab = ui.tab === 'collections' ? 'collections' : 'planner';
    // the phone: ≡ stays where it was in the bar (tap it again to close), the tabs right beside it, close together
    tabs = TABS.map(([k, name]) =>
      // drop a note on Planner to make it a list there; hovering a tab while dragging opens it
      k === 'collections' ? h('button', { class: 'tab' + (tab === k ? ' active' : ''), role: 'tab', 'aria-selected': String(tab === k), onclick: () => showTab(k) }, name,
          (() => { const f = freshIn('collections'); return f ? h('i', { class: 'nav-new tab-new', 'aria-label': `${f} new` }, String(f)) : null; })())
        : dropZone(h('button', { class: 'tab' + (tab === k ? ' active' : ''), role: 'tab', 'aria-selected': String(tab === k), onclick: () => showTab(k) }, name,
          (() => { const f = freshIn('planner'); return f ? h('i', { class: 'nav-new tab-new', 'aria-label': `${f} new` }, String(f)) : null; })()),
          (p) => placeFile(p, { sectionName: 'Lists', planner: false })));
    nav = h('nav', { class: 'nav' }, tab === 'planner' ? [
      // Levin's order (8 Nov 2026): Lab (bold, with the Filer), Recent; Today, This week, General To-Do, Shopping; then the
      // list folders. On the phone only the pages not already in the quick bar, so ≡ is mostly the folders
      (() => {
        const off = (key) => !isMobile() || !barKeys().includes(key);
        const top = PAGES().filter((pg) => pg.key === 'lab' && off(pg.key)).map((pg) => h('a', { class: 'nav-item' + (pg.key === 'lab' ? ' today' : '') + (pg.on(r) ? ' active' : ''), href: pg.href, oncontextmenu: (e) => pageMenu(e, pg.key) },
          h('span', { class: 'nav-name' }, pg.label),
          // new questions: the same red number as on the Lab's icon; opening Questions clears it
          pg.key === 'lab' && labNew() ? h('i', { class: 'nav-new', 'aria-label': `${labNew()} new` }, String(labNew())) : h('span', { class: 'nav-badge' }, pg.count())));
        // one block with Today, Week, General and Shopping (Levin, 11 Nov 2026)
        const off2 = (key) => !isMobile() || !barKeys().includes(key), loose = plannerLoose.filter((p) => off2(barKey(p)));
        const day = PAGES().find((pg) => pg.key === 'day');
        const rows = [
          ...top,
          off2('day') && h('a', { class: 'nav-item' + (day.on(r) ? ' active' : ''), href: day.href, oncontextmenu: (e) => todayMenu(e) }, h('span', { class: 'nav-name' }, day.label), h('span', { class: 'nav-badge' }, day.count())),
          ...loose.map((p) => fileLink(p, active, loose)),
          ...Object.entries(plannerGroups).map(([g, files]) => h('div', { class: 'section' }, h('div', { class: 'label' }, h('span', {}, g)), files.map((p) => fileLink(p, active, files)))),
        ].filter(Boolean);
        return rows.length > 0 && h('div', { class: 'section' }, rows);
      })(),
      // then every list, in its folders (what was the Lists tab)
      sectionBlock('Lists'), newRow([['Lists', 'New list']]),
    ] : [
      // Collections: notes and trackers in one set of folders (Sauna Log sits in Logs with the other logs)
      sectionBlock('Collections', SECTIONS.filter((s) => s !== 'Lists').flatMap((s) => t.dirs[s]?.files || []), 'Collections/~'),
      t.files.length > 0 && h('div', { class: 'section' }, h('div', { class: 'label' }, 'Unfiled'), kept(t.files).map((p) => fileLink(p, active))),
      others.map((d) => h('div', { class: 'section' }, h('div', { class: 'label' }, d),
        kept(t.dirs[d].files).map((p) => fileLink(p, active)),
        Object.keys(t.dirs[d].dirs).sort().map((sub) => folderBlock(sub, t.dirs[d].dirs[sub], active, d + '/', 0)))),
      newRow(SECTIONS.filter((s) => s !== 'Lists').map((s) => [s, s === 'Trackers' ? 'New tracker' : s === 'Notes' ? 'New note' : `New in ${s}`])),
    ]);
  }

  const st = vault.status;
  const statusText = {
    idle: 'Not synced yet', syncing: st.progress ? `Loading ${st.progress}` : 'Syncing…', local: 'On this device only', offline: 'Offline',
    synced: `Synced ${st.at ? new Date(st.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`,
    error: 'Sync problem',
  }[st.state] + (st.pending ? ` · ${st.pending} to send` : '');

  const navTop = $('.nav', side)?.scrollTop || 0;
  const hadFocus = document.activeElement === $('.search', side);
  // search is a magnifier (Levin, 10 Nov 2026): on the Mac in the foot beside undo, on the phone at the bottom right of
  // ≡ under the thumb. Its field is always there, only hidden, so a tap on the magnifier types at once (the iPhone brings
  // up its keyboard only for a field focused inside the tap)
  const mobile = isMobile();
  const searchEl = h('input', { class: 'search', type: 'search', placeholder: 'Search', value: query, autocomplete: 'off', spellcheck: false, enterkeyhint: 'search',
    oninput: (e) => { query = e.target.value; renderSide(); },
    onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } else if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },  // Return: the results stay
    onblur: () => setTimeout(() => { if (!query && document.activeElement !== $('#side .search')) closeSearch(); }, 200) });
  const searchBtn = h('button', { class: 'foot-icon search-btn', 'aria-label': 'Search', title: 'Search (/)', onmousedown: (e) => e.preventDefault(),
    onclick: () => (side.classList.contains('search-open') ? closeSearch() : openSearch()) }, footIcon(ICONS.search));
  const themeBtn = h('button', { class: 'theme-switch foot-icon', 'aria-label': isDark() ? 'Light' : 'Dark', title: isDark() ? 'Light' : 'Dark',
    onclick: () => { setPref(KEYS.theme, isDark() ? 'light' : 'dark'); applyTheme(); render(); } }, footIcon(isDark() ? ICONS.day : ICONS.moon));
  side.classList.toggle('search-open', searchOpen || !!q);
  side.replaceChildren(
    h('div', { class: 'brand' }, flameMark(), h('a', { href: '#/' }, APP_NAME)),
    // the Mac: drag the sidebar's right edge to make it wider or narrower (double-click: back to the usual width)
    isMobile() ? '' : h('div', { class: 'side-resize', 'aria-hidden': 'true', title: 'Drag to resize', ondblclick: () => { delete ui.sideWidth; saveUi(); document.documentElement.style.removeProperty('--side'); },
      onmousedown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); document.body.classList.add('resizing');
        const mv = (ev) => { ui.sideWidth = Math.round(Math.min(480, Math.max(200, ev.clientX))); document.documentElement.style.setProperty('--side', `${ui.sideWidth}px`); };
        const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); document.body.classList.remove('resizing'); saveUi(); };
        addEventListener('mousemove', mv); addEventListener('mouseup', up);
      } }),
    // the phone: ≡ stays where it is in the bar (tap it again to close), the tabs beside it, the magnifier on the right
    // (while searching, the field takes the tabs' place); the Mac: the tabs and, at the end of their row, dark mode
    // (Levin, 10 Nov 2026; none while searching)
    mobile ? h('div', { class: 'tabs', role: 'tablist' }, h('button', { class: 'tab-menu', 'aria-label': 'Close', onclick: closeDrawer }, h('span', { class: 'menu-lines', 'aria-hidden': 'true' })),
      tabs || '', searchEl, searchBtn)
      : tabs ? h('div', { class: 'tabs', role: 'tablist' }, tabs, themeBtn) : '',
    nav,
    h('footer', { class: 'side-foot' },
      h('button', { class: 'status ' + st.state, title: st.error || '', onclick: () => vault.sync() }, statusText),
      mobile ? '' : searchEl,
      // small symbols, not words (Levin, 9 Nov 2026): the phone undo, dark, settings; the Mac search, undo, settings, its
      // dark mode up by the tabs (10 Nov)
      h('span', { class: 'foot-links' },
        mobile ? '' : searchBtn,
        h('button', { class: 'foot-icon', 'aria-label': 'Undo the last change', title: 'Undo (Cmd+Z)', onclick: () => undoLast() }, footIcon(ICONS.undo)),
        mobile ? themeBtn : '',
        h('a', { href: '#/settings', class: 'foot-icon' + (r.view === 'settings' ? ' active' : ''), 'aria-label': 'Settings', title: 'Settings' }, footIcon(ICONS.gear)))));
  const newNav = $('.nav', side); if (newNav) newNav.scrollTop = navTop;
  if (hadFocus) { const s = $('.search', side); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}
function openSearch() {
  const side = $('#side'), s = side && $('.search', side); if (!s) return;
  searchOpen = true; side.classList.add('search-open');
  s.focus(); s.setSelectionRange(s.value.length, s.value.length);
}
function closeSearch() {
  searchOpen = false;
  if (query) { query = ''; $('#side .search')?.blur(); renderSide(); return; }
  $('#side')?.classList.remove('search-open'); $('#side .search')?.blur();
}

// "+" at the bottom of a tab, as in Google Tasks: one choice makes it at once, several open into a short menu
function newRow(kinds) {
  const open = !!ui.open['new:' + kinds.map((k) => k[0]).join()];
  if (kinds.length === 1) return h('button', { class: 'nav-item new-row', title: kinds[0][1], 'aria-label': kinds[0][1], onclick: () => newFile(kinds[0][0], !!kinds[0][2]) }, '+');
  return h('div', { class: 'new-group' },
    h('button', { class: 'nav-item new-row', 'aria-label': 'New', 'aria-expanded': String(open), onclick: () => { ui.open['new:' + kinds.map((k) => k[0]).join()] = !open; saveUi(); renderSide(); } }, open ? '–' : '+'),
    open && kinds.map(([sec, label, planner]) => h('button', { class: 'nav-item sub', onclick: () => newFile(sec, !!planner) }, h('span', { class: 'nav-name' }, label))));
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
// Steady view (Levin, 11 Nov 2026: "on no page should clicking or adding something lead to a strange jump"). A redraw
// soon after a tap or a key in the page keeps the rows around that place where they were on the screen: the rows near
// it are found again by their text, and the page scrolls by how far they moved (the middle value, so a row that went
// elsewhere, such as a ticked task going down to Completed, doesn't pull the view after it).
let touchedAt = 0, touchedEl = null;
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, (e) => {
  const t = ev === 'keydown' ? document.activeElement : e.target;
  if (t?.closest?.('#main')) { touchedAt = Date.now(); touchedEl = t; }
}, true);
const ROWS = '.item, .usual-item, .usual-find, summary, .day-head, .agenda-head, .blk, h1, h2, h3, .add-item input';
const rowSig = (el) => (el.dataset.keep || '') + '|' + (el.classList[0] || el.tagName) + '|' + el.textContent.replace(/\s+/g, ' ').trim().slice(0, 160);
function steadyMarks() {
  if (Date.now() - touchedAt > 2500 || !touchedEl?.isConnected) return null;
  const rows = [...$('#main').querySelectorAll(ROWS)];
  const at = rows.indexOf(touchedEl.closest(ROWS));
  if (at < 0) return null;
  const count = new Map();
  for (const el of rows) { const k = rowSig(el); count.set(k, (count.get(k) || 0) + 1); }
  return rows.slice(Math.max(0, at - 4), at + 5).map((el) => ({ k: rowSig(el), y: el.getBoundingClientRect().top })).filter((m) => count.get(m.k) === 1);
}
function steadyKeep(marks) {
  if (!marks?.length) return;
  const now = new Map();
  for (const el of $('#main').querySelectorAll(ROWS)) { const k = rowSig(el); now.set(k, now.has(k) ? null : el); }
  const moves = marks.map((m) => now.get(m.k) && now.get(m.k).getBoundingClientRect().top - m.y).filter((d) => typeof d === 'number').sort((a, b) => a - b);
  if (!moves.length) return;
  const d = Math.round(moves[Math.floor((moves.length - 1) / 2)]);
  if (d) { scrollBy(0, d); const m = $('#main'); if (m && m.scrollHeight > m.clientHeight) m.scrollTop += d; }
}
function renderMain() {
  const marks = steadyMarks();
  renderMainRaw();
  steadyKeep(marks);
}
function renderMainRaw() {
  const r = route();
  $('body > .ws-fixed')?.remove();  // Week's day row on the phone (put back by Week itself)
  const main = $('#main');
  document.body.dataset.view = r.view;
  setTimeout(() => { if ($('.pages')) renderPages(); }, 0);
  let view;
  try {  // a page that fails to draw shows a small notice; the bar, ≡ and every other page keep working (8 Nov 2026)
  if (!vault.backend) view = settingsView(true);
  else if (r.view === 'settings') view = settingsView();
  else if (r.view === 'index') view = h('div');
  else if (r.view === 'file') view = fileView(r.path);
  else if (r.view === 'heartbeat') view = heartbeatView();
  else if (r.view === 'questions') view = questionsView();
  else if (r.view === 'day') view = dayView();
  else if (r.view === 'recent') view = recentView();
  else if (r.view === 'person') view = personView(r.name);
  else if (r.view === 'people') view = h('div', { class: 'page people-page' }, pageHead('Lab', 'People', h('a', { class: 'edit-top', href: fileHref(PEOPLE) }, 'Edit')),
    h('div', { class: 'list' }, people().map((p) => h('a', { class: 'nav-item person-link', href: `#/people/${encodeURIComponent(p.name)}`,
      oncontextmenu: (e) => contextMenu(e, [['Aliases…', () => editAliases(p.name)], ['Rename', () => { const n = prompt('Name', p.name); if (n?.trim()) setPerson(p.name, n.trim(), p.names.slice(1)); }]]) },
      h('span', { class: 'nav-name' }, p.name), h('span', { class: 'nav-badge' }, p.names.slice(1).join(', '))))),
    h('button', { class: 'nav-item new-row', 'aria-label': 'Add a person', title: 'Add a person', onclick: addPerson }, '+'));
  else if (r.view === 'tag') view = tagView(r.name);
  else if (r.view === 'library') view = libraryView();
  else if (r.view === 'sort') view = sortView(r.path);
  else view = todayView();
  } catch (err) {
    console.error(err);
    view = h('div', { class: 'page' }, pageHead('', 'Not shown'), emptyState('This page could not be shown'), h('p', { class: 'meta page-error' }, String(err?.message || err)));
  }
  main.replaceChildren(view);
  // Completed is never inside a card: it is the last thing on the page, below its ··· (Levin, 8 Nov 2026); on a page shorter
  // than the screen it sits at the screen's bottom edge (10 Nov 2026, in the CSS)
  const pg = main.querySelector(':scope > .page') || main.firstElementChild;
  if (pg) for (const c of main.querySelectorAll('.list > .completed, .week > .completed')) { pg.append(c); c.classList.add('page-done'); }
  shortLinks(main);
  hydrateImages(vault, main);
  setTimeout(stackWideTables, 0);
}

// the phone: a table wider than the screen shows each row as a small card of labels and values, so nothing scrolls sideways
function stackWideTables() {
  if (!isMobile()) return;
  for (const t of document.querySelectorAll('#main table:not(.stack)')) {
    const box = t.closest('.table-wrap') || t.parentElement;
    if (!box || t.scrollWidth <= box.clientWidth + 1) continue;
    const heads = [...(t.querySelector('thead tr') || t.querySelector('tr')).children].map((c) => c.textContent.trim());
    for (const tr of t.querySelectorAll('tr')) [...tr.children].forEach((c, i) => { if (c.tagName === 'TD' && c.colSpan === 1 && heads[i]) c.dataset.label = heads[i]; });
    t.classList.add('stack');
  }
}
addEventListener('resize', () => { clearTimeout(stackWideTables.t); stackWideTables.t = setTimeout(stackWideTables, 200); });

// a page's head: the rule on top, nothing above it (Levin, 8 Nov 2026: the same on every page); under it the title, and
// on its line, at the right, what used to sit above the rule (Edit, a time, the (?))
function pageHead(kicker, heading, meta) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'meta-row' },
      h('button', { class: 'menu-btn', 'aria-label': 'Open the sidebar', onclick: () => openDrawer() }, h('span', { class: 'menu-flame' }), 'Index')),
    h('div', { class: 'title-row' }, heading && h('h1', { class: 'title' }, heading), meta && h('span', { class: 'head-meta' }, meta)));
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
// Dictation knows Mother Flame's words (Levin, 11 Nov 2026). The phone's speech engine can't be taught words, so what it
// hears is corrected: (1) the lines of System/Dictation.md ("heard → meant"); (2) any name in the app (titles, folders,
// People and their other names, Stella's places) that was heard with other spacing, case or apostrophes:
// "Library of O'Hara" → "Library of Ohara", "konto korrent" → "Kontokorrent".
const DICTATION = 'System/Dictation.md';
const squash = (t) => t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
function dictWords() {
  return memoized('dictwords', () => {
    // single words only from names (People, Stella's places); titles and folders count when two words or more, so
    // "shopping" stays a word and "Library of O'Hara" becomes the place
    const names = new Set(['Stella', 'Smo', 'Codex', 'Zotero', 'Egghead', 'Ohara', 'Kontokorrent']), phrases = new Set(['Mother Flame', 'Library of Ohara', 'Punk Records', 'The Museum']);
    for (const f of vault.list()) {
      if (!/\.md$/i.test(f.path) || /^(System|Backups)\//.test(f.path)) continue;
      phrases.add(title(f.path).replace(/[^\p{L}\p{N}\s'’-]/gu, '').trim());
      const folder = md.splitFrontmatter(f.content || '').data.folder; if (folder) folder.split('/').forEach((x) => phrases.add(x.trim()));
    }
    for (const l of (vault.read(PEOPLE) || '').split('\n')) { const m = l.match(/^\s*-\s+(.+)$/); if (m) m[1].split(/[:,]/).forEach((x) => names.add(x.trim())); }
    const keyed = new Map();  // squashed spelling → { term, one: may replace a single word }
    for (const t of phrases) { const k = squash(t); if (k.length >= 3 && /\s/.test(t)) keyed.set(k, { term: t, one: false }); }
    for (const t of names) { const k = squash(t); if (k.length >= 3) keyed.set(k, { term: t, one: true }); }
    const fixes = (vault.read(DICTATION) || '').split('\n').map((l) => l.match(/^\s*[-*]\s+(.+?)\s*(?:→|->)\s*(.+?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]);
    return { keyed, fixes };
  });
}
function fixDictation(text) {
  if (!text) return text;
  const { keyed, fixes } = dictWords();
  for (const [heard, meant] of fixes) text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${heard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu'), (m) => (/^\p{Lu}/u.test(m) ? meant[0].toUpperCase() + meant.slice(1) : meant));  // (a capital stays)
  // runs of up to four words whose letters spell a known name
  const words = text.split(/(\s+)/);  // (the spaces kept, at odd places)
  for (let i = 0; i < words.length; i += 2) {
    for (let n = 4; n >= 1; n--) {
      if (i + 2 * n - 1 > words.length) continue;
      const core = words.slice(i, i + 2 * n - 1).join('');
      const lead = core.match(/^[^\p{L}\p{N}]*/u)[0], tail = core.slice(lead.length).match(/[^\p{L}\p{N}]*$/u)[0];
      const hit = keyed.get(squash(core));
      if (!hit || (n === 1 && !hit.one)) continue;
      words.splice(i, 2 * n - 1, lead + hit.term + tail);
      break;
    }
  }
  return words.join('');
}
function startLive(area, redraw) {
  const rec = new SR();
  rec.lang = LANGS[ui.dictLang === 'de' ? 'de' : 'en'];
  rec.continuous = true;
  rec.interimResults = true;
  const base = area.value.replace(/\s+$/, '');
  // the whole transcript so far, rebuilt on every result (the iPhone revises earlier words as you go)
  rec.onresult = (e) => {
    const said = [...e.results].map((r) => r[0].transcript.trim()).filter(Boolean).join(' ');  // (each piece of a pause starts without a space)
    const fixed = fixDictation(said);
    area.value = [base, fixed ? fixed[0].toUpperCase() + fixed.slice(1) : ''].filter(Boolean).join(base && fixed ? ' ' : '');
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
function dueItems() { return memoized('due', dueItemsScan); }
function dueItemsScan() {
  const out = [];
  for (const f of vault.list()) {
    if (!/\.md$/i.test(f.path) || HIDDEN.includes(section(f.path)) || !f.content?.includes('📅')) continue;
    const walk = (nodes) => { for (const n of nodes) { if (n.kind === 'md') continue; if (n.checkbox && !n.checked && n.due) out.push({ ...n, path: f.path }); walk(n.children || []); } };
    walk(md.parseList(f.content));
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || (a.time || '99').localeCompare(b.time || '99'));
}
// a calendar entry looks like a task (Levin, 8 Nov 2026): its title in a task's type, its time in grey under it as a
// task's time is, and a small calendar where a task has its tick box; an all-day one (a birthday) is its title alone
const eventRow = (e) => h('div', { class: 'event' + (e.start ? '' : ' allday') },
  h('span', { class: 'ev-mark', 'aria-hidden': 'true', html: pix(ICONS.week) }),
  h('span', { class: 'task-text' }, h('span', { class: 'item-text ev-title' }, e.title),
    e.start && h('span', { class: 'from ev-time' }, e.start + (e.end ? '–' + e.end : ''))));
// a dated task with a tick box; `file` is where it lives, `from` whether to name that list under it
function taskRow(x, today, { file = x.path, from = true, extra = null, swipeable = true, noDay = false, lift = null } = {}) {
  const tomorrow = iso(addDays(new Date(), 1));
  const row = h('div', { class: 'task-row' },
    lift && dragGrip(lift.start),
    checkbox(false, () => update(file, (t) => { const f = md.findItem(t, x); return f ? md.toggleItem(t, f.line) : t; })),
    h('span', { class: 'task-text' },
      // the text stays editable wherever a task shows (Today, This week, planning the week)
      textWithVoice(x.text, (v) => { if (v && v !== x.text) update(file, (t) => { const f = md.findItem(t, x); return f ? md.setItemText(t, f.line, v) : t; }); }, 'item-text'),
      // its description, grey under it and edited in place, as in the lists (Levin, 10 Nov 2026)
      x.notes?.length > 0 && h('div', { class: 'item-sub' }, editableNotes(x.notes, (v) => update(file, (t) => { const f = md.findItem(t, x); return f ? md.setItemNotes(t, f, v) : t; }))),
      // under the task: its time, a past day, ↻ for repeats, and the list it lives in (not "This week": that's where tasks with a day are)
      from && (() => {
        const bits = [x.time, x.due && x.due < today && !noDay ? dayLabel(x.due) : '', x.repeat ? '↻' : '', file === THISWEEK ? '' : title(file)].filter(Boolean);
        return bits.length > 0 && h('a', { class: 'from' + (x.due && x.due < today ? ' late' : ''), href: fileHref(file) }, bits.join(' · '));
      })()),
    extra,
    freshText(file, x.text) && h('i', { class: 'item-new', 'aria-label': 'new' }),
    swipeable && h('button', { class: 'more', 'aria-label': 'Details', onclick: () => openTaskSheet(file, x) }, '···'));
  row.addEventListener('contextmenu', (e) => { if (e.target.closest('[contenteditable="true"]:focus')) return; taskMenu(e, file, x); });  // right-click on the Mac
  row._it = x;
  return lift ? swipe(row, { lift }) : row;
}

// a ticked task stays in sight for the day, struck through; one tap on its tick brings it back (a slip of the thumb)
const planned = (x) => x.due || x.path === THISWEEK;  // what was on the week: not shopping, questions or the dailies
function doneRow(x) {
  return h('div', { class: 'wk-done done-row' },
    h('button', { class: 'check on', role: 'checkbox', 'aria-checked': 'true', 'aria-label': 'Mark not done', title: 'Not done after all',
      onclick: () => update(x.path, (t) => { const f = md.findItem(t, x); return f && f.checked ? md.toggleItem(t, f.line) : t; }) }),
    h('span', { html: renderInline(vault, x.text) }));
}

function dayView() {
  const now = new Date(), today = iso(now);
  const held = (x) => ({ start: (sx, sy) => liftTask(x, rowOf(x), sx, sy), move: moveDrag, end: endDrag });
  const rowOf = (x) => [...document.querySelectorAll('.day-page .task-row')].find((r) => r._it === x);
  const due = dueItems().filter((x) => x.due <= today);
  // today's calendar on top of today's tasks, as on Week (Levin, 8 Nov 2026)
  const evs = calendarEvents().filter((e) => e.date === today).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  return h('div', { class: 'page day-page' },
    pageHead('Planner', 'Today'),
    // in their own boxes, each named (Levin, 10 Nov 2026): the calendar, then one box of tasks. What is left from earlier
    // days joins it at the bottom, newest first and without its date, so the newest are always on top (Levin, 11 Nov 2026)
    evs.length > 0 && h('section', { class: 'agenda agenda-cal' }, h('div', { class: 'agenda-head' }, 'Calendar'), evs.map((e) => eventRow(e))),
    due.length > 0 && h('section', { class: 'agenda', 'data-day': today }, h('div', { class: 'agenda-head' }, 'Tasks'),
      [...due.filter((x) => x.due >= today), ...due.filter((x) => x.due < today).sort((a, b) => b.due.localeCompare(a.due))].map((x) => taskRow(x, today, { noDay: true, lift: held(x) }))),
    !due.length && !evs.length && emptyState('Nothing today'),
    // Dailies and Smo with their name inside the card, small and grey, as Earlier (Levin, 10 Nov 2026); the name opens the list
    // Smo's list without its own Completed: what was ticked there joins Today's one Completed, at the bottom
    vault.exists(TELL_SMO) && h('section', { class: 'tell-smo' },
      (() => { const l = listView(TELL_SMO, vault.read(TELL_SMO)); l.querySelector(':scope > .completed')?.remove(); return cardHead(l, TELL_SMO, title(TELL_SMO)); })()),
    // Smo first, then Dailies (Levin, 11 Nov 2026)
    vault.exists(DAILIES) && h('section', { class: 'tell-smo' }, cardHead(dailiesView(), DAILIES, 'Dailies')),
    // what was ticked today, folded as in a list, always at the very bottom; open it to untick one
    (() => {
      const smoDone = md.parseList(vault.read(TELL_SMO) || '').filter((x) => x.kind === 'item' && x.checked).map((x) => ({ ...x, path: TELL_SMO }));
      const dn = [...doneOn(today).filter(planned), ...smoDone], open = !!ui.showDone['#/day'];
      return dn.length > 0 && h('div', { class: 'completed day-done' },
        h('button', { class: 'completed-head', onclick: () => { ui.showDone['#/day'] = !open; saveUi(); renderMain(); } },
          h('span', { class: 'label' }, open ? `Completed · ${dn.length}` : 'Completed')),
        open && dn.map(doneRow),
        open && h('button', { class: 'link clear-done', onclick: () => clearItems(dn) }, 'Clear completed'));
    })(),
    null);
}

const cardHead = (card, path, name) => { card.prepend(h('a', { class: 'agenda-head card-head', href: fileHref(path) }, name)); return card; };

// ---------- people: every mention of someone, across lists, logs and notes ----------
// Notes/People.md lists them, one per line: "- Smo: Smi" (name, then other names for the same person)
function people() {
  return (vault.read(PEOPLE) || '').split('\n').map((l) => l.match(/^\s*[-*]\s+([^:]+?)\s*(?::\s*(.*))?$/)).filter(Boolean)
    .map((m) => ({ name: m[1].trim(), names: [m[1], ...(m[2] || '').split(',')].map((x) => x.trim()).filter(Boolean) }));
}
// adding someone, and their other names (aliases): one line each in Notes/People.md, "- Name: alias, alias"
function setPerson(old, name, aliases) {
  const line = `- ${name}${aliases.length ? ': ' + aliases.join(', ') : ''}`;
  update(PEOPLE, (t) => {
    const L = t.split('\n'), i = old == null ? -1 : L.findIndex((l) => (l.match(/^\s*[-*]\s+([^:]+?)\s*(?::|$)/) || [])[1]?.trim() === old);
    if (i >= 0) L[i] = line;
    else {
      // after the last person, above the page's own words at the bottom (Levin, 11 Nov 2026)
      const last = L.reduce((k, l, j) => (/^\s*[-*]\s+/.test(l) ? j : k), -1);
      if (last >= 0) L.splice(last + 1, 0, line); else { while (L.length && !L.at(-1).trim()) L.pop(); L.push(line, ''); }
    }
    return L.join('\n');
  });
  if (old != null && old !== name && route().view === 'person') location.hash = `#/people/${encodeURIComponent(name)}`;
}
const splitNames = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
function addPerson() {
  const name = prompt('Name')?.trim(); if (!name) return;
  if (people().some((p) => p.name.toLowerCase() === name.toLowerCase())) return toast('Already in People');
  setPerson(null, name, splitNames(prompt(`Other names for ${name} (with commas), if any`) || ''));
}
function editAliases(name) {
  const p = people().find((x) => x.name === name); if (!p) return;
  const v = prompt(`Other names for ${name} (with commas)`, p.names.slice(1).join(', '));
  if (v != null) setPerson(name, name, splitNames(v));
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
    pageHead('People', p.name),
    // the other names, tap to change them (or add some)
    people().some((x) => x.name === p.name) && h('button', { class: 'link person-aliases', onclick: () => editAliases(p.name) }, p.names.length > 1 ? 'Also: ' + p.names.slice(1).join(', ') : 'Add other names'),
    hits.map((x) => h('section', { class: 'week-day' },
      h('div', { class: 'day-head' }, h('a', { class: 'label', href: fileHref(x.path) }, title(x.path)), h('span', { class: 'meta' }, String(x.lines.length))),
      x.lines.slice(0, 50).map((l) => h('div', { class: 'mention', html: renderInline(vault, l.replace(/^\s*([-*+]\s+)?(\[[ xX]\]\s+)?|^#+\s+|^\|/g, '').replace(/\s*\|\s*/g, ' · ').trim()) })))),
    !hits.length && emptyState('No mentions yet'));
}

// ---------- the Library of Ohara: the works that came in with the latest run (System/Library.md, by tools/library_index.py) ----------
const LIBRARY = 'System/Library.md';
function libraryView() {
  const text = vault.read(LIBRARY) || '', fm = md.splitFrontmatter(text);
  const works = text.slice(fm.bodyStart).split('\n').filter((l) => l.startsWith('- '))
    .map((l) => { const [key, title = '', folder = '', added = ''] = l.slice(2).split(' | '); return { key, title, folder, added }; })
    .filter((w) => w.added).sort((a, b) => b.added.localeCompare(a.added));
  // the latest batch: everything that arrived within half a day of the newest one
  const newest = works[0] ? new Date(works[0].added.replace(' ', 'T')) : null;
  const batch = newest ? works.filter((w) => newest - new Date(w.added.replace(' ', 'T')) < 14 * 3600e3) : [];
  const name = (k) => k.replace(/^(.+?)(\d{4}[a-z]?)$/, (_, a, y) => `${a.replace(/:/g, ' & ')} ${y}`);
  return h('div', { class: 'page library-page' },
    pageHead('Lab', 'Library', newest ? dayLabel(iso(newest)) : ''),
    batch.map((w) => h('div', { class: 'lib-row' }, h('span', { class: 'lib-key' }, name(w.key)),
      h('span', { class: 'lib-title' }, w.title || w.key, w.folder && h('span', { class: 'lib-folder' }, ` · ${w.folder}`)))));
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
    pageHead('Tags', '#' + name),
    Object.entries(byFile).map(([path, nodes]) => h('section', { class: 'week-day' },
      h('div', { class: 'day-head' }, h('a', { class: 'label', href: fileHref(path) }, title(path)), h('span', { class: 'meta' }, String(nodes.length))),
      nodes.map((n) => n.checkbox ? taskRow({ ...n, path }, today, { from: false })
        : h('div', { class: 'mention', html: renderInline(vault, n.text) })))),
    !hits.length && emptyState('Nothing here'),
    others.length > 0 && h('p', { class: 'tag-others' }, others.map(([k, v]) => h('a', { class: 'tag', href: `#/tag/${encodeURIComponent(k)}` }, `#${k} ${v.length}`))));
}

// Dailies: ticked counts for today only; tomorrow every daily is open again (the ✅ date says when it was last done)
const dailyItems = () => md.parseList(vault.read(DAILIES) || '').filter((x) => x.kind === 'item');
const dailiesLeft = () => dailyItems().filter((x) => !(x.checked && x.done === iso(new Date()))).length;
function dailiesView() {
  const today = iso(new Date());
  return h('div', { class: 'list dailies' }, dailyItems().map((it) => {
    const done = it.checked && it.done === today;
    // a daily ticks in place (struck through for the rest of the day) instead of falling away; tap again to untick
    const toggle = () => update(DAILIES, (t) => { const f = md.findItem(t, it); return f ? md.setItemFields(t, f.line, done ? { checked: false, done: null } : { checked: true, done: today }) : t; });
    const lift = { start: (x, y) => liftRow(DAILIES, it, el, x, y), move: moveDrag, end: endDrag };  // held (phone) or by its grip (Mac): into another order
    const el = h('div', { class: 'item' + (done ? ' done' : '') }, swipe(h('div', { class: 'item-row' },
      dragGrip(lift.start),
      h('button', { class: 'check plain' + (done ? ' on' : ''), role: 'checkbox', 'aria-checked': String(done), 'aria-label': done ? 'Mark not done' : 'Mark done', onclick: toggle }),
      h('div', { class: 'item-main' }, h('div', { class: 'item-text', html: renderInline(vault, it.text) }),
        it.notes.length > 0 && h('div', { class: 'item-sub' }, h('span', { class: 'notes', html: renderInline(vault, it.notes.map((n) => n.text).join(' · ')) })))), { lift }));
    el.dataset.depth = 0; el._it = it;  // for dragging
    return el;
  }));
}

// right-click Today (Mac): bring everything from earlier days to today, or copy the day's tasks
function todayMenu(e) {
  const today = iso(new Date()), due = dueItems().filter((x) => x.due <= today), late = due.filter((x) => x.due < today);
  contextMenu(e, [
    ['Add a task for today', () => openQuickAdd('today')],
    barToggle('day'),
    late.length > 0 && [`Move ${late.length} from earlier to today`, () => withUndo('Moved to today', [...new Set(late.map((x) => x.path)), THISWEEK], () => { for (const x of late) setDay(x.path, x, today); })],
    due.length > 0 && ['Copy as text', () => copyText(due.map((x) => `- ${x.text}`).join('\n'), 'Copied as text')],
  ]);
}
// right-click the Filer (Mac)
function filerMenu(e) {
  const items = md.parseList(vault.read(INBOX) || '').filter((x) => x.kind === 'item');
  contextMenu(e, [
    ['Write something down', () => openQuickAdd()],
    items.some((x) => !x.checked) && ['Sort one by one', () => { location.hash = `#/sort/${encodeURIComponent(INBOX)}`; }],
    items.some((x) => x.checked) && ['Clear completed', () => withUndo('Cleared', [INBOX], () => clearCompleted(INBOX))],
    items.length > 0 && ['Copy as text', () => copyText(items.filter((x) => !x.checked).map((x) => `- ${x.text}`).join('\n'), 'Copied as text')],
  ]);
}

// right-click the Lab, the Calendar or Recent (Mac)
function pageMenu(e, key) {
  const go = (h) => () => { location.hash = h; };
  const today = iso(new Date()), evs = calendarEvents().filter((x) => x.date === today);
  contextMenu(e, [...(key === 'lab' ? [
    vault.exists(FOR_STELLA) && ['Send Stella a task', () => openQuickAdd('stella')],
    ['Open questions', go('#/questions')],
    vault.exists(PEOPLE) && ['People', go('#/people')],
    vault.exists(RULES) && [title(RULES), go(fileHref(RULES))],
  ] : key === 'calendar' ? [
    ['Go to today', () => { location.hash = '#/calendar'; setTimeout(() => $('#cal-now')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300); }],
    evs.length > 0 && ["Copy today's events", () => copyText(evs.map((x) => `- ${x.start ? x.start + ' ' : ''}${x.title}`).join('\n'), 'Copied')],
  ] : key === 'recent' ? [
    ['Refresh', () => { recentCache = null; location.hash = '#/recent'; renderMain(); }],
  ] : []), barToggle(key)]);
}

// right-click a task (Mac): the quick things
function taskMenu(e, path, it) {
  const now = new Date(), at = (fn) => update(path, (t) => { const f = md.findItem(t, it); return f ? fn(t, f) : t; });
  contextMenu(e, [
    it.checkbox && [it.checked ? 'Not done' : 'Done', () => withUndo(it.checked ? 'Not done' : 'Done', [path], () => at((t, f) => md.toggleItem(t, f.line)))],
    it.checkbox && !it.checked && ['Today', () => withUndo('Today', [path, THISWEEK], () => setDay(path, it, iso(now)))],
    it.checkbox && !it.checked && ['Tomorrow', () => withUndo('Tomorrow', [path, THISWEEK], () => setDay(path, it, iso(addDays(now, 1))))],
    ['File into…', () => openMoveSheet(path, it)],
    ['Details', () => openTaskSheet(path, it)],
    ['Copy', () => copyText(it.text)],
    ['Delete', () => withUndo('Deleted', [path], () => at((t, f) => md.deleteItem(t, f))), 'danger'],
  ]);
}

// moving a task to another day: a small clock button opening the week's days
function dayMenu(file, x) {
  const now = new Date(), d = (n) => iso(addDays(now, n));
  const opts = [['', 'Move to…'], [d(0), 'Today'], [d(1), 'Tomorrow'], ...[2, 3, 4, 5, 6].map((n) => [d(n), weekday(d(n))]),
    [d(((8 - now.getDay()) % 7) || 7) + '#', 'Next week'], ['none', 'No day']];
  return h('label', { class: 'day-move', title: 'Move to another day' }, h('i', { class: 'clock', 'aria-hidden': 'true' }),
    h('select', { 'aria-label': 'Move to another day', onchange: (e) => {
      const v = e.target.value.replace('#', ''); if (!v) return;
      withUndo(v === 'none' ? 'No day' : `Moved to ${dayLabel(v)}`, [file, THISWEEK], () => setDay(file, x, v === 'none' ? null : v));
    } }, opts.map(([v, l]) => h('option', { value: v }, l))));
}

// Shopping: what to buy now goes under "To buy"; anything new also joins "Usual items" (plain, for reference)
const SHOP = 'Lists/Shopping.md';
const foldFind = (t) => t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function shopAdd(t, text) {
  const L = t.split('\n'), item = text.replace(/\s*📅\s*\S+/, '').trim();
  const at = L.findIndex((l) => /^#{1,6}\s+to buy\s*$/i.test(l));
  if (at < 0) return md.addItem(t, item, { top: true });
  let k = at + 1; while (k < L.length && !L[k].trim()) k++;
  const same = (l) => l.replace(/^\s*- (\[[ xX]\] )?/, '').trim().toLowerCase() === item.toLowerCase();
  if (!L.some((l) => l.startsWith('- [ ] ') && same(l))) L.splice(k, 0, `- [ ] ${item}`);  // already on it: once is enough
  const u = L.findIndex((l) => /^#{1,6}\s+usual items\s*$/i.test(l));
  if (u >= 0 && !L.slice(u + 1).some(same)) {
    let e = u + 1; while (e < L.length && !/^#{1,6}\s/.test(L[e])) e++;
    while (e > u + 1 && !L[e - 1].trim()) e--;
    L.splice(e, 0, `- ${item}`);
  }
  return L.join('\n');
}

// a usual item taken off To buy again: its open line under To buy goes (Usual items keeps it)
function offToBuy(t, text) {
  const L = t.split('\n'), at = L.findIndex((l) => /^#{1,6}\s+to buy\s*$/i.test(l)), u = L.findIndex((l) => /^#{1,6}\s+usual items\s*$/i.test(l));
  const i = L.findIndex((l, k) => k > at && (u < 0 || k < u) && l.startsWith('- [ ] ') && l.slice(6).trim().toLowerCase() === text.trim().toLowerCase());
  if (i < 0) return t;
  let j = i + 1; while (j < L.length && /^(\t|  )/.test(L[j])) j++;  // with its notes
  L.splice(i, j - i);
  return L.join('\n');
}

// giving a task a day: General To-Do is the undated backlog, so a task there that gets a day moves into This week
function setDay(file, it, date) {
  if (file === TASKS && date) return moveToWeek(file, it, date);
  update(file, (t) => { const f = md.findItem(t, it); if (!f) return t; const u = md.setItemDue(t, f.line, date); return date && date !== f.due ? md.toTop(u, f) : u; });
}

// tasks ticked off on a day (✅ that day), from every list
function doneOn(d) {
  return memoized('done:' + d, () => {
    const out = [];
    for (const f of vault.list()) {
      if (!/\.md$/i.test(f.path) || ['System', 'Backups'].includes(section(f.path)) || !f.content?.includes('✅ ' + d)) continue;
      const walk = (nodes) => { for (const n of nodes) { if (n.kind === 'md') continue; if (n.checked && n.done === d) out.push({ ...n, path: f.path }); walk(n.children || []); } };
      walk(md.parseList(f.content));
    }
    return out;
  });
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

// a day's heading (Levin, 8 Nov 2026): "Today (Sunday, 8 Nov)", "Tomorrow (Monday, 9 Nov)", "Tuesday (10 Nov)", the brackets lighter
function dayName(d) {
  const now = new Date(), rel = { [iso(now)]: 'Today', [iso(addDays(now, 1))]: 'Tomorrow', [iso(addDays(now, -1))]: 'Yesterday' }[d];
  const date = new Date(d + 'T12:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return [h('span', { class: 'dh-rel' }, rel || weekday(d)), h('span', { class: 'dh-more' }, rel ? ` (${weekday(d)}, ${date})` : ` (${date})`)];
}
// Week shows one day at a time (Levin, 10 Nov 2026: no scrolling through the week): the seven days from today as letters,
// on the phone in a row above the bottom bar, on the Mac beside the day's name; a task dragged onto a letter moves there
let weekSel = null;
function weekView(path, text) {
  const now = new Date(), today = iso(now);
  // only the days ahead, tomorrow first (Levin, 11 Nov 2026: today has its own page)
  const days = [...Array(7)].map((_, i) => iso(addDays(now, i + 1)));
  const sel = days.includes(weekSel) ? weekSel : days[0];
  const past = [3, 2, 1].map((n) => iso(addDays(now, -n)));  // (Completed still shows what was ticked on these)
  const name = (d) => weekday(d);  // today is marked by its underline
  const op = (fn) => update(path, fn);
  const due = dueItems(), evs = calendarEvents();
  const open = md.parseList(text).filter((s) => s.kind === 'item' && s.checkbox && !s.checked);
  const dayPick = (onpick) => h('select', { class: 'day-pick', 'aria-label': 'Day', onchange: (e) => e.target.value && onpick(e.target.value) },
    h('option', { value: '' }, 'Day…'), days.map((d, i) => h('option', { value: d }, name(d, i))));
  const later = due.filter((x) => x.due > days[6] && x.path === path);
  // a day (Levin, 10 Nov 2026): its name outside, then a white box for the calendar and one for the tasks; a day with
  // neither shows the empty box
  const dayHead = (label) => h('div', { class: 'day-head' }, h('span', { class: 'label' }, label));
  const tasksOn = (d) => due.filter((x) => x.due === d);
  const eventsOn = (d) => evs.filter((e) => e.date === d).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  // on the phone a swipe along the day row goes to the next or the previous day (Levin, 10 Nov 2026); elsewhere a swipe
  // still changes the page in the bottom bar
  const swipeDays = (row) => {
    let x0 = null, y0 = 0;
    row.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    row.addEventListener('touchend', (e) => {
      if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
      if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx)) return;
      const j = Math.min(days.length - 1, Math.max(0, days.indexOf(sel) + (dx < 0 ? 1 : -1)));
      if (days[j] !== sel) { weekSel = days[j]; renderMain(); scrollTo(0, 0); }
    });
    return row;
  };
  // the day picker: a letter a day, tomorrow first
  const letters = (cls) => h('div', { class: 'week-strip ' + cls, role: 'tablist', 'aria-label': 'Day' },
    days.map((d) => h('button', { class: 'ws-day' + (d === sel ? ' on' : ''),
      role: 'tab', 'aria-selected': String(d === sel), 'aria-label': weekday(d), title: weekday(d), 'data-drop-day': d,
      onclick: () => { weekSel = d; renderMain(); scrollTo(0, 0); } }, weekday(d).slice(0, 1))));
  // named and spaced as on Today (Levin, 11 Nov 2026)
  const boxes = (es, ts) => [es.length > 0 && h('div', { class: 'wk-box wk-cal' }, h('div', { class: 'agenda-head' }, 'Calendar'), es), ts.length > 0 && h('div', { class: 'wk-box wk-tasks' }, h('div', { class: 'agenda-head' }, 'Tasks'), ts),
    !es.length && !ts.length && emptyState('Nothing planned')];  // the dashed empty box, as elsewhere (Levin, 10 Nov 2026)
  return h('div', { class: 'week' },
    h('form', { class: 'add-item week-add', onsubmit: async (e) => {
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
    voice && h('div', { class: 'voice-chip' }, h('audio', { controls: true, src: voice.url }), 
      h('button', { class: 'link', onclick: () => $('.week .add-item').requestSubmit() }, 'Add')),
    h('div', { class: 'week-days' },
      (() => {
        const d = sel, ts = tasksOn(d), es = eventsOn(d);
        return h('section', { class: 'week-day', 'data-day': d },
          h('div', { class: 'day-head wk-head' }, h('span', { class: 'label' }, dayName(d)), isMobile() ? '' : letters('ws-inline')),
          boxes(es.map((e) => eventRow(e)), ts.map((x) => { let el; el = taskRow(x, today, { noDay: true, lift: { start: (sx, sy) => liftTask(x, el, sx, sy), move: moveDrag, end: endDrag } }); return el; })));
      })()),
    // (the phone's row hangs on the body, so the page's slide-in can't carry it)
    isMobile() && (() => { const s = swipeDays(letters('ws-fixed')); setTimeout(() => { $('body > .ws-fixed')?.remove(); if (route().path === path) document.body.append(s); }, 0); return ''; })(),
    later.length > 0 && h('section', { class: 'week-day' }, dayHead('Later'), boxes([], later.map((x) => taskRow(x, today)))),
    open.some((s) => !s.due) && h('section', { class: 'week-day' }, dayHead('No day yet'),
      boxes([], open.filter((s) => !s.due).map((it) => taskRow(it, today, { file: path, from: false,
        extra: dayPick((d) => op((t) => { const f = md.findItem(t, it); return f ? md.toTop(md.setItemDue(t, f.line, d), f) : t; })) })))),
    // one Completed for the whole week, at the very bottom (Levin, 8 Nov 2026): what was ticked today and on the days
    // above, newest first, then anything else ticked in This week; tap a tick to bring a task back
    (() => {
      const seen = new Set(), key = (x) => x.path + '\n' + x.text;
      const dn = [today, ...[...past].reverse()].flatMap((d) => doneOn(d).filter(planned))
        .concat(md.parseList(text).filter((x) => x.kind === 'item' && x.checked).map((x) => ({ ...x, path })))
        .filter((x) => !seen.has(key(x)) && seen.add(key(x)));
      const shown = !!ui.showDone['#/week'];
      return dn.length > 0 && h('div', { class: 'completed day-done' },
        h('button', { class: 'completed-head', onclick: () => { ui.showDone['#/week'] = !shown; saveUi(); renderMain(); } },
          h('span', { class: 'label' }, shown ? `Completed · ${dn.length}` : 'Completed')),
        shown && dn.map(doneRow),
        shown && h('button', { class: 'link clear-done', onclick: () => clearItems(dn) }, 'Clear completed'));
    })());
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
    h('textarea', { rows: 3, placeholder: 'Write or speak today’s entry.', 'data-keep': 'journal', enterkeyhint: 'send', onkeydown: sendOnEnter((e) => e.target.form.requestSubmit()) }),
    voice && h('div', { class: 'voice-chip' }, h('audio', { controls: true, src: voice.url })),
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
  if (!it) return h('div', { class: 'page sort-page' }, pageHead('Sorting', title(path), ''),
    emptyState(skip.length ? `All sorted, ${skip.length} skipped` : 'All sorted'),
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
    pageHead('Sorting', title(path)),
    card,
    h('div', { class: 'sort-actions' },
      act('File into…', () => openMoveSheet(path, it)),
      act('Done', () => withUndo('Done', [path], () => update(path, (t) => { const f = md.findItem(t, it); return f ? md.toggleItem(t, f.line) : t; }))),
      act('Skip', () => { skip.push(it.text); next(); }),
      act('Delete', () => withUndo('Deleted', [path], () => update(path, (t) => { const f = md.findItem(t, it); return f ? md.deleteItem(t, f) : t; })))),
    h('a', { class: 'review-link quiet-link', href: back }, 'Stop sorting'));
}

// ---------- Recent: what changed lately, and who did it (from the vault's history) ----------
let recentCache = null;
const SOURCE = [[/^(Update|Add|Delete) /, 'You'], [/^Filed from the board/, 'Filer'], [/^Voice notes transcribed/, 'Voice'], [/^Nightly/, 'Nightly'],
  [/^Calendar/, 'Calendar'], [/^(Mac |Update from Mac)/, 'Mac']];
const sourceOf = (msg) => (SOURCE.find(([re]) => re.test(msg)) || [0, 'Other'])[1];
// a commit's patch → what happened to items: added (+), ticked (✓), removed (−)
function changesIn(files) {
  const out = [];
  for (const f of files || []) {
    const p = f.filename || '';
    // (the Heartbeat log has its own page: its lines stay out of Recent, Levin, 10 Nov 2026)
    if (/^System\/(Activity|Calendar|Health|Heartbeat|link-titles)|^\.github\//.test(p)) continue;
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
    const list = await b.history(50);  // further back than before: the Mac's hourly syncs are mostly Heartbeat lines
    const top = list.slice(0, 50);
    const details = await Promise.all(top.map((c) => b.commit(c.sha).catch(() => null)));
    recentCache = { at: Date.now(), items: top.map((c, i) => ({ msg: c.commit.message.split('\n')[0], at: c.commit.author?.date || c.commit.committer?.date, changes: changesIn(details[i]?.files) })) };
  } catch (e) { recentCache = { error: e.message }; }
  if (route().view === 'recent') renderMain();
}
// Recent: what happened, one row per item, newest first, by day: ✓ done, ⇢ moved (from → to), + added, × removed
function recentView() {
  if (!recentCache || Date.now() - (recentCache.at || 0) > 60000) { if (!recentCache?.loading) { recentCache = { ...(recentCache || {}), loading: true }; loadRecent(); } }
  const events = [];
  for (const it of recentCache?.items || []) {
    const who = sourceOf(it.msg), at = it.at, adds = [], rems = [];
    for (const c of it.changes) for (const [k, t] of c.lines) {
      if (k === '+') adds.push({ t, p: c.path }); else if (k === '−') rems.push({ t, p: c.path });
      else events.push({ kind: 'done', text: t, path: c.path, where: title(c.path), href: fileHref(c.path), at, who });
    }
    // the same item gone from one list and new in another was moved
    for (const a of adds) {
      const same = (x) => x.t === a.t || (a.t.length > 3 && x.t.toLowerCase().endsWith(a.t.toLowerCase()));
      const r = rems.find((x) => !x.used && x.p !== a.p && same(x));
      if (r) { r.used = true; events.push({ kind: 'move', text: a.t, path: a.p, where: `${title(r.p)} → ${title(a.p)}`, href: fileHref(a.p), at, who }); }
      else if (a.p.startsWith('attachments/')) events.push({ kind: 'add', text: /Sketch /.test(a.t) ? 'A drawing' : a.t, where: 'attachments', at, who });
      else events.push({ kind: 'add', text: a.t, path: a.p, where: title(a.p), href: fileHref(a.p), at, who });
    }
    for (const r of rems) if (!r.used) events.push({ kind: 'remove', text: r.t, path: r.p, where: title(r.p), href: fileHref(r.p), at, who });
  }
  const days = new Map(), seen = new Set();
  for (const e of events) {
    const d = iso(new Date(e.at)), k = d + '|' + e.text.toLowerCase();
    if (seen.has(k)) continue;  // newest first: an item moved twice in a day shows where it ended up
    seen.add(k); (days.get(d) || days.set(d, []).get(d)).push(e);
  }
  const time = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const icon = { done: h('i', { class: 'icon-tick' }), move: '⇢', add: '+', remove: '×' };
  const KINDS = [['done', '✓'], ['move', '⇢'], ['add', '+'], ['remove', '×']];
  return h('div', { class: 'page recent-page' },
    pageHead('Lab', 'Recent', recentCache?.loading ? 'Loading…' : ''),
    recentCache?.error && h('p', { class: 'empty-note' }, recentCache.error),
    [...days].map(([d, es]) => h('section', { class: 'rc-day' },
      h('div', { class: 'day-head' }, h('span', { class: 'label' }, dayLabel(d)),
        h('span', { class: 'rc-counts' }, KINDS.map(([k, sym]) => { const n = es.filter((e) => e.kind === k).length; return n ? h('span', { class: 'rc-count rc-' + k }, `${sym} ${n}`) : null; }))),
      [...es.reduce((m, e) => m.set(e.where, [...(m.get(e.where) || []), e]), new Map())].map(([where, rows]) => h('div', { class: 'rc-group' },
        rows[0].href ? h('a', { class: 'rc-where', href: rows[0].href }, where) : h('div', { class: 'rc-where' }, where),
        rows.map((e, i) => {
          // as the task is now in its list (Levin, 10 Nov 2026): a done one's tick unticks it (and ticks it again);
          // a tap on the text opens the task's details; anything else (a log line, a task no longer there) links to its list
          const it = e.path && liveItem(e.path, e.text, e.kind === 'done'), done = it && itemDone(e.path, it);
          const meta = (() => { const m = (x) => [time(x.at), x.who !== 'You' ? x.who : ''].filter(Boolean).join(' · ');
            return (!i || m(rows[i - 1]) !== m(e)) && h('span', { class: 'rc-meta' }, m(e)); })();
          const inner = [h('span', { class: 'rc-text', html: renderInline(vault, e.text) }), meta];
          return h('div', { class: 'rc rc-' + e.kind },
            e.kind === 'done' && it?.checkbox
              ? h('button', { class: 'rc-check', role: 'checkbox', 'aria-checked': String(!!done), 'aria-label': done ? 'Mark not done' : 'Mark done',
                  onclick: () => withUndo(done ? 'Not done' : 'Done', [e.path], () => update(e.path, (t) => toggleLive(t, e.path, e.text, done))) },
                  h('span', { class: 'rc-icon' }, done ? h('i', { class: 'icon-tick' }) : ''))
              : h('span', { class: 'rc-icon', 'aria-label': e.kind }, e.kind === 'done' ? h('i', { class: 'icon-tick' }) : icon[e.kind]),
            it?.checkbox ? h('button', { class: 'rc-main', onclick: () => openTaskSheet(e.path, it) }, inner)
              : e.href ? h('a', { class: 'rc-main', href: e.href }, inner) : h('span', { class: 'rc-main' }, inner));
        }))))));
}
// the task a Recent row names, found in its list as it is now: by its text (markers such as ⏰ or 🔁 left out), sub-tasks
// too; for a done row a ticked one first, as a repeating task leaves an open copy with the same text when ticked
function liveItemIn(content, text, wantDone, path) {
  const want = (md.parseItemLine('- ' + text)?.text || text).trim(), all = [];
  const walk = (nodes) => { for (const n of nodes) if (n.kind !== 'md') { all.push(n); walk(n.children || []); } };
  walk(md.parseList(content || ''));
  const same = all.filter((n) => n.text.trim() === want);
  return same.find((n) => itemDone(path, n) === wantDone) || same[0] || null;
}
const liveItem = (path, text, wantDone) => (/\.md$/i.test(path) && vault.exists(path) ? liveItemIn(vault.read(path), text, wantDone, path) : null);
// a daily is done only for the day it was ticked (it opens again the next day)
const itemDone = (path, n) => !!n.checked && (path !== DAILIES || n.done === iso(new Date()));
function toggleLive(t, path, text, done) {
  const f = liveItemIn(t, text, done, path); if (!f || itemDone(path, f) !== done) return t;
  if (path === DAILIES) return md.setItemFields(t, f.line, done ? { checked: false, done: null } : { checked: true, done: iso(new Date()) });
  return md.toggleItem(t, f.line);
}

// ---------- Today: the board ----------
// the home page is the Lab, with the Filer in it (Levin, 8 Nov 2026)
const todayView = () => labView();

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
      fallAway(btn.closest('.item, .task-row, .card'), () => { onclick(e); toast('Done', undoLast); });
    } });
}

// ---------- file views ----------
function fileView(path) {
  const text = vault.read(path);
  if (text == null) return h('div', { class: 'page' }, pageHead('', 'Not found'), h('p', { class: 'meta' }, path));
  if (freshCount(path)) seeLater('fresh', () => {  // opening a list counts as seeing what is new in it (after 2 s)
    if (path === TODOS) ui.seenTodos = openTexts(TODOS);
    ui.seenFiled = [...new Set([...(ui.seenFiled || []), ...filedFresh(path).map((e) => e.key)])];
  });
  const type = md.fileType(path, text);
  const body = ui.editing === path ? editorView(path, text)
    : path === DAILIES ? dailiesView()
    : path === THISWEEK ? weekView(path, text)
    : path === JOURNAL ? [journalBox(), noteView(path, text)]
    : type === 'list' ? listView(path, text)
    : type === 'tracker' ? trackerView(path, text)
    : noteView(path, text);
  return h('div', { class: `page ${type}-page` },
    pageHead([RULES, FOR_STELLA, QUESTIONS, RESEARCH, PEOPLE].includes(path) || area(path) === 'lab' ? 'Lab' : area(path) === 'planner' ? 'Planner' : section(path) || 'Vault', title(path),
      type === 'note' || ui.editing === path
        ? h('button', { class: 'edit-top', onclick: () => { ui.editing = ui.editing === path ? null : path; renderMain(); } }, ui.editing === path ? 'Done' : 'Edit')
        : ''),
    body, path !== RULES && fileActions(path, type));
}

function fileActions(path, type) {
  return h('footer', { class: 'file-actions-one' }, h('button', { class: 'more', 'aria-label': 'More for this page', title: 'More', onclick: () => openFileSheet(path, type) }, '···'));
}
function openFileSheet(path, type) {
  $('.sheet-back')?.remove();
  const close = () => back.remove();
  const act = (label, fn, cls = '') => h('button', { class: 'sheet-item ' + cls, onclick: () => { close(); fn(); } }, label);
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': title(path) },
      type === 'list' && md.parseList(vault.read(path) || '').some((x) => x.kind === 'item' && x.checked) && act('Clear completed', () => { if (confirm(`Clear the ticked items in “${title(path)}”?`)) withUndo('Cleared', [path], () => clearCompleted(path)); }),
      type === 'list' && act('Select several', () => { (ui.selecting ||= {})[path] = true; (ui.selected ||= {})[path] = {}; renderMain(); scrollTo({ top: 0, behavior: 'smooth' }); }),
      type === 'list' && act('Sort one by one', () => { location.hash = `#/sort/${encodeURIComponent(path)}`; }),
      type !== 'note' && act('Edit as text', () => { ui.editing = path; renderMain(); }),
      act('Rename', () => renameFile(path)),
      type === 'list' && act(area(path) === 'planner' ? 'Move to Lists' : 'Move to Planner', () => setArea(path, area(path) === 'planner' ? 'lists' : 'planner')),
      [...SECTIONS, 'Archive'].filter((x) => x !== section(path)).map((x) => act(`Move to ${x === 'Notes' ? 'Collections' : x}`, async () => {
        try { const to = `${x}/${path.split('/').pop()}`; await vault.rename(path, to); location.hash = fileHref(to); } catch (e) { alert(e.message); }
      })),
      act('Delete', async () => { if (!confirm(`Delete “${title(path)}”? It stays in the repository history.`)) return; await vault.remove(path); location.hash = '#/'; }, 'danger')));
  document.body.append(back);
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
  const isIndexList = (b) => b?.type === 'list' && /^(\s*(\d+\.|[-*])\s+\[\[#[^\]]+\]\]\s*\n?)+$/.test(b.raw);
  const next = (i, d) => { let j = i + d; while (blocks[j]?.type === 'space') j += d; return blocks[j]; };
  const hadIndex = blocks.some(isIndexList);
  const blockEl = (b, i) => {
    if (b.type === 'space') return null;
    // the note's own index stays in the file but not on the page: the Index button shows it (with its heading and the divider after it)
    if (isIndexList(b) || (b.type === 'heading' && /^#+\s*index\s*$/i.test(b.raw.trim()) && isIndexList(next(i, 1)))
      || (b.type === 'paragraph' && /^[\s–—-]{3,}$/.test(b.raw.trim()) && isIndexList(next(i, -1)))) return null;
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
  // a log by days (a "## 13 Nov 2026 …" heading per day, as Stella's digest): each day in a white box of its own, so a
  // scroll down shows at once where one day ends (Levin, 13 Nov 2026)
  const DAYHEAD = /^(\d{1,2}\.? [A-Za-zä]{3,}\.? \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})\b/;
  const isDay = (x) => x.firstElementChild?.tagName === 'H2' && DAYHEAD.test(x.textContent.trim());
  let kids = els;
  if (els.filter(isDay).length >= 2) {
    kids = []; let box = null;
    for (const x of els) {
      if (isDay(x)) { box = h('div', { class: 'day-box' }, x); kids.push(box); }
      else if (box && !x.classList.contains('blk-new') && x.firstElementChild?.tagName !== 'H2' && x.firstElementChild?.tagName !== 'H1') box.append(x);
      else { box = x.firstElementChild?.tagName === 'H2' ? null : box; kids.push(x); }
    }
  }
  const el = h('article', { class: 'prose note-edit' + (kids !== els ? ' by-day' : '') }, kids);
  // a long collection gets an index: its headings and top-level items, tap one to jump there; a note with headings lists
  // only those (Levin, 13 Nov 2026: its lines made no sense as headers there)
  const B = ':scope > .blk, :scope > .day-box > .blk';
  const heads = [...el.querySelectorAll(B.split(', ').map((x) => `${x} > :is(h2, h3)`).join(', '))];
  // (one level: plain rows; two: the main headings bold, the ones under them plain)
  if (heads.length >= 2) heads.forEach((x) => { if (x.tagName === 'H3' || !heads.some((y) => y.tagName === 'H3')) x.dataset.plain = '1'; });
  const marks = heads.length >= 2 ? heads : [...el.querySelectorAll(B.split(', ').flatMap((x) => [`${x} > :is(h1, h2, h3)`, `${x} > ul > li`, `${x} > ol > li`]).join(', '))];
  marks.forEach((m, i) => { m.id ||= `ix-${i}`; });
  // (a heading's words in brackets at its end stay out of the Index: "13 Nov 2026 (nightly run …)" is "13 Nov 2026")
  const label = (m) => (m.matches('li') ? [...m.childNodes].filter((c) => !(c.nodeType === 1 && /^(UL|OL)$/.test(c.tagName))).map((c) => c.textContent).join('') : m.textContent.replace(/\s*\([^)]*\)\s*$/, '')).replace(/\s+/g, ' ').trim().slice(0, 80);
  // the small Index up top: for a long note, one with three or more headings, or one that had its own index
  const index = (marks.length >= 8 || hadIndex || heads.length >= 3) && h('button', { class: 'note-index', 'aria-label': 'Index', title: 'Index', onclick: () => openIndex(indexEntries(marks, label)) }, h('span', { class: 'menu-lines', 'aria-hidden': 'true' }), 'Index');
  const lines = md.taskLines(text);
  el.querySelectorAll('input[type=checkbox]').forEach((box, i) => {
    box.disabled = false; box.contentEditable = 'false';
    box.addEventListener('change', () => update(path, (t) => md.toggleItem(t, lines[i])));
  });
  return index ? h('div', {}, index, el) : el;
}
// the Index's entries; dated entries ("136. [30.10.2026, …] …", the Event Log) are listed by their date, under their year
// (Levin, 8 Nov 2026: jump to a date, then read what happened that day)
function indexEntries(marks, label) {
  const plain = [], dated = [], other = [];
  for (const m of marks) {
    const text = label(m), d = m.matches('li') && text.match(/^\d+\**\.\s*\[(\d{1,2})\.(\d{1,2})\.(\d{4})[,\]]?\s*(.*)$/);
    if (!d) { (m.matches('li') && dated.length ? other : plain).push({ id: m.id, text, head: !m.matches('li') && !m.dataset.plain }); continue; }
    // what follows the date: the bracket's place or company, else the first words after it (the label may be cut short)
    const [, dd, mm, yyyy, after] = d, where = after.includes(']') ? after.slice(0, after.indexOf(']')) : after, rest = after.slice(after.indexOf(']') + 1);
    const day = new Date(+yyyy, +mm - 1, +dd);
    dated.push({ id: m.id, year: yyyy, t: day.getTime(), text: `${day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${(where || rest).trim()}`.slice(0, 80) });
  }
  if (!dated.length) return plain;
  // newest year first, each year's days newest first; entries without a clear date at the end
  const years = [...new Set(dated.map((x) => x.year))].sort((x, y) => y - x);
  return [...plain, ...years.flatMap((y) => { const days = dated.filter((x) => x.year === y).sort((x, z) => z.t - x.t); return [{ id: days[0].id, text: y, head: true }, ...days]; }),
    ...(other.length ? [{ id: other[0].id, text: 'Without a date', head: true }, ...other] : [])];
}
function openIndex(entries) {
  $('.sheet-back')?.remove();
  const close = () => back.remove();
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) close(); } },
    // as tall as the ≡ sheet (in reach of the thumb); pulled up, it grows (Levin, 8 Nov 2026)
    h('div', { class: 'sheet low', role: 'dialog', 'aria-label': 'Index' },
      h('div', { class: 'sheet-head' }, h('span', { class: 'label' }, 'Index'), h('button', { class: 'quiet', 'aria-label': 'Close', onclick: close }, '×')),
      entries.map((e) => h('button', { class: 'sheet-item' + (e.head ? ' ix-head' : ''), onclick: () => { close(); document.getElementById(e.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, e.text || '—'))));
  document.body.append(back);
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
// a new day redraws everything (the dailies open again, Today moves on), even if the app stayed open overnight
let shownDay = iso(new Date());
setInterval(() => { if (iso(new Date()) !== shownDay && vault.backend) { shownDay = iso(new Date()); renderSide(); renderTabbar(); renderMain(); } }, 60000);
// coming back to the app keeps the page it was on: it is never taken to the Lab by force (Levin, 8 Nov 2026); only a fresh
// start opens on the Lab

// a tap on a link in a text that isn't being edited opens the link instead of editing
const linkTap = (e, el) => {
  const a = e.target.closest('a');
  if (a && document.activeElement !== el) { e.preventDefault(); a.target === '_blank' || /^https?:/.test(a.href) ? open(a.href, '_blank', 'noopener') : (location.hash = a.getAttribute('href')); }
};
// an item's text: formatted when reading, raw Markdown while editing; links open on tap
function editableText(raw, save, cls = 'item-text') {
  const el = h('div', { class: cls, contenteditable: 'plaintext-only', spellcheck: false, html: renderInline(vault, raw),
    onmousedown: (e) => linkTap(e, el),
    onfocus: () => { el.textContent = raw; },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } },
    onblur: () => { const v = el.textContent.trim(); if (v === raw) el.innerHTML = renderInline(vault, raw); save(v); } });
  return el;
}

// a task's description (the grey lines under it), edited in place like its text (Levin, 9 Nov 2026): its raw lines while
// editing, Return saves (Shift+Return on the Mac starts a line), emptied it goes. Long notes (summaries) each on their own
// line; short ones run together
function editableNotes(notes, save) {
  const raw = notes.map((n) => n.text).join('\n'), block = notes.some((n) => n.text.length > 80);
  const shown = () => (block ? notes.map((n) => `<p>${renderInline(vault, n.text)}</p>`).join('') : renderInline(vault, notes.map((n) => n.text).join(' · ')));
  const el = h(block ? 'div' : 'span', { class: 'notes' + (block ? ' notes-block' : ''), contenteditable: 'plaintext-only', spellcheck: false, 'aria-label': 'Description', html: shown(),
    onmousedown: (e) => linkTap(e, el),
    onfocus: () => { el.textContent = raw; },
    onkeydown: sendOnEnter(() => el.blur()),
    onblur: () => { const v = el.innerText.split('\n').map((x) => x.trim()).filter(Boolean).join('\n'); if (v === raw.trim()) el.innerHTML = shown(); else save(v); } });
  return el;
}

// a paragraph explaining how a list works (a full sentence, not a heading or a short label like "Serif:")
const isIntro = (text) => text.trim().split(/\n{2,}/).every((p) => !/^#{1,6}\s/.test(p) && p.length > 40 && /[.!?)]$/.test(p.trim()));
// a small (?) that shows an explanation when tapped or hovered, instead of text on the page
function help(text) {
  const b = h('button', { type: 'button', class: 'help', 'aria-label': text, title: text, onclick: (e) => {
    e.stopPropagation(); e.preventDefault();
    const open = $('.help-pop'); open?.remove(); if (open?.__for === b) return;
    const r = b.getBoundingClientRect(), pop = h('div', { class: 'help-pop', role: 'tooltip' }, text);
    pop.__for = b; document.body.append(pop);
    const w = Math.min(300, innerWidth - 24);
    Object.assign(pop.style, { width: w + 'px', left: Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px', top: r.bottom + 8 + scrollY + 'px' });
    setTimeout(() => addEventListener('click', () => pop.remove(), { once: true }), 0);
  } }, '?');
  return b;
}

// ---------- lists ----------
let expanded = null;
let addSubFor = null;  // the task whose sub-task field is open
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
            it.notes.length > 0 && editableNotes(it.notes, (v) => at(it, (t, f) => md.setItemNotes(t, f, v))))),
        !it.checked && freshText(path, it.text) && h('i', { class: 'item-new', 'aria-label': 'new' }),
        path === INBOX && !it.checked && h('button', { class: 'more file-btn', 'aria-label': 'File into a list', title: 'File into…', onclick: () => openMoveSheet(path, it) }, '⇢'),
        h('button', { class: 'more', 'aria-label': 'Details', onclick: () => openTaskSheet(path, it) }, '···')), {
        lift: lift || null,  // a hold only moves it (Levin, 8 Nov 2026); selecting several is under Select
      }),
      // ticked sub-tasks leave their parent for Completed (as in Google Tasks), unless the parent is done too
      it.children.filter((c) => !c.checked || !c.checkbox || it.checked).map((c) => row(c, depth + 1)),
      // a task with sub-tasks: "+" under them adds another right there (Return adds, and the field stays for the next)
      !it.checked && it.children.some((c) => c.kind !== 'md') && (addSubFor === key
        ? h('form', { class: 'add-sub', onsubmit: (e) => {
            e.preventDefault(); const i = $('input', e.target), v = i.value.trim(); if (!v) { addSubFor = null; renderMain(); return; }
            i.value = ''; at(it, (t, f) => md.addItem(t, v, { parent: f, checkbox: it.checkbox }));
          } }, h('input', { type: 'text', placeholder: 'Sub-task', enterkeyhint: 'done', autocomplete: 'off', 'data-keep': 'sub:' + key,
            onblur: (e) => { if (!e.target.value.trim()) setTimeout(() => { if (addSubFor === key) { addSubFor = null; renderMain(); } }, 150); } }))
        : h('button', { class: 'add-sub-btn', 'aria-label': 'Add a sub-task', title: 'Add a sub-task', onclick: () => { addSubFor = key; renderMain(); setTimeout(() => $(`[data-keep="sub:${CSS.escape(key)}"]`)?.focus(), 0); } }, '+')));
    el.dataset.depth = depth; el._it = it;  // for dragging
    el.querySelector('.item-row')?.addEventListener('contextmenu', (e) => { if (e.target.closest('[contenteditable="true"]:focus')) return; e.stopPropagation(); taskMenu(e, path, it); });
    return el;
  };

  const live = [], done = [], doneSubs = [];
  let beforeItems = true;  // the stretch above the first item, where tools put a how-to paragraph
  const gather = (it) => { for (const c of it.children || []) { if (c.checkbox && c.checked) doneSubs.push({ c, parent: it.text }); else gather(c); } };
  const usual = [], toBuy = new Set(segs.filter((x) => x.kind === 'item' && x.checkbox && !x.checked).map((x) => x.text.toLowerCase()));
  let inUsual = false;
  for (const s of segs) {
    if (s.kind === 'md') {
      if (path === SHOP && /^#{1,6}\s+usual items\s*$/im.test(s.text.trim())) { inUsual = true; continue; }
      if (path === SHOP && /^#{1,6}\s+to buy\s*$/im.test(s.text.trim())) continue;  // the page is Shopping; its open items are what to buy
      if (!(beforeItems && isIntro(s.text))) live.push(h('div', { class: 'prose list-prose', html: renderMarkdown(vault, s.text) }));
      continue;
    }
    beforeItems = false;
    if (inUsual) { usual.push(s); continue; }  // every usual item stays in sight, also while it is on To buy
    if (s.checked) done.push(s);
    else { live.push(row(s)); gather(s); }
  }
  // Usual items (Levin, 8 Nov 2026): tap one (or its box) and it goes up to To buy, ticked here while it is there; tap
  // again to take it off To buy. It never leaves Usual items. A line of dashes is only a divider.
  // it stays open while you pick several (the page redraws after each tap); you close it yourself
  // Find (Levin, 11 Nov 2026): a field at the top narrows the items as you type, brackets included ("zitrone" finds
  // Citrusfrüchte); umlauts and case don't matter. While you search, the page shows only the field and what it finds,
  // at the top; a tap ticks the item (it goes on To buy) and you stay in the field, its word selected, so the next word
  // you type replaces it. Return takes the first match, or with no match adds what you typed as a new item. The page
  // redraws only when you leave the field, with the field where it was.
  if (usual.length) {
    let find = null;
    const searching = () => find && (document.activeElement === find || usualQ.trim());
    const setMode = () => {  // (leaving the search, the page around comes back with the field kept where it is on screen)
      const l = find?.closest('.list'); if (!l || l.classList.contains('finding') === !!searching()) return;
      const y = find.getBoundingClientRect().top;
      l.classList.toggle('finding', !!searching());
      if (!searching()) scrollBy(0, find.getBoundingClientRect().top - y);
    };
    const tick = (b, u) => {
      const on = b.classList.contains('on');
      update(SHOP, (t) => on ? offToBuy(t, u.text) : shopAdd(t, u.text));
      if (document.activeElement !== find) return;  // (not searching: the page redraws as usual)
      b.classList.toggle('on', !on); b.firstChild.classList.toggle('on', !on);
      b.setAttribute('aria-checked', String(!on)); b.title = on ? 'Add to To buy' : 'Take off To buy';
      find.select();
    };
    const keepFocus = (e) => { if (document.activeElement === find) e.preventDefault(); };  // the keyboard stays up
    const items = usual.map((u) => {
      if (/^[—–-]{3,}$/.test(u.text.trim())) return h('hr', { class: 'usual-rule' });
      const on = toBuy.has(u.text.toLowerCase());
      const b = h('button', { class: 'usual-item' + (on ? ' on' : ''), role: 'checkbox', 'aria-checked': String(on), title: on ? 'Take off To buy' : 'Add to To buy',
        onmousedown: keepFocus, onpointerdown: keepFocus, onclick: () => tick(b, u) },
        h('span', { class: 'check' + (on ? ' on' : ''), 'aria-hidden': 'true' }), h('span', { html: renderInline(vault, u.text) }));
      b.dataset.find = foldFind(u.text);
      return b;
    });
    const addNew = () => {
      const t = usualQ.trim(); if (!t) return;
      update(SHOP, (x) => shopAdd(x, t));
      if (document.activeElement === find) { toast(`Added ${t}`); find.select(); }
    };
    const none = h('button', { class: 'usual-item usual-new', hidden: true, onmousedown: keepFocus, onpointerdown: keepFocus, onclick: () => addNew() }, h('span', { class: 'usual-plus' }, '+'), h('span', {}));
    const filter = () => {
      const q = foldFind(usualQ.trim());
      let hits = 0;
      for (const el of items) {
        if (el.tagName === 'HR') { el.hidden = !!q; continue; }
        el.hidden = !!q && !q.split(/\s+/).every((w) => el.dataset.find.includes(w));
        if (!el.hidden) hits++;
      }
      none.hidden = !q || hits > 0;
      none.lastChild.textContent = `Add “${usualQ.trim()}”`;
    };
    find = h('input', { class: 'usual-find', type: 'search', placeholder: 'Find an item', value: usualQ, autocomplete: 'off', autocorrect: 'off', spellcheck: false,
      enterkeyhint: 'done', 'aria-label': 'Find a usual item',
      onfocus: () => { setMode(); find.scrollIntoView({ block: 'start' }); },
      // leaving the field ends the search: the word goes and the whole list is back (Levin, 13 Nov 2026); Usual items stay open
      onblur: () => { usualQ = ''; find.value = ''; filter(); ui.open['shop:usual'] = true; saveUi(); touchedEl = find; touchedAt = Date.now(); setTimeout(setMode, 0); },  // (the redraw keeps the field in place)
      oninput: (e) => { usualQ = e.target.value; filter(); },
      onkeydown: (e) => {
        if (e.key === 'Escape') { usualQ = ''; e.target.value = ''; filter(); }
        if (e.key !== 'Enter' || !usualQ.trim()) return;
        e.preventDefault();
        const first = items.find((el) => el.tagName === 'BUTTON' && !el.hidden);
        if (first) first.click(); else addNew();
      } });
    filter();
    queueMicrotask(setMode);
    live.push(h('details', { class: 'usual', open: !!ui.open['shop:usual'], ontoggle: (e) => { if (ui.open['shop:usual'] !== e.target.open) { ui.open['shop:usual'] = e.target.open; saveUi(); } } }, h('summary', {}, 'Usual items'),
      find, items, none));
  }
  const nDone = done.length + doneSubs.length;
  // nothing open: the dashed empty box (Levin, 8 Nov 2026: one style for every empty place); with nothing else in the list,
  // its white card goes, so the box stands on the page as everywhere else
  const empty = !live.some((x) => x?.classList?.contains('item'));
  if (empty) {
    const at = live.findIndex((x) => x?.classList?.contains('usual'));
    live.splice(at < 0 ? live.length : at, 0, emptyState(path === SHOP ? 'Nothing to buy' : nDone ? 'All done' : 'Nothing here'));
  }
  const hasCheckboxes = segs.some((s) => s.kind === 'item' && s.checkbox) || !segs.some((s) => s.kind === 'item');

  return h('div', { class: 'list' + (empty && live.length === 1 ? ' list-empty' : '') },
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
        // just the word, thin and grey; the number shows once it is open; no + (Levin, 10 Nov 2026)
        h('span', { class: 'label' }, showDone ? `Completed · ${nDone}` : 'Completed')),
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
  // a one-line note (like "* denotes Aufguss") is a slim line under the first table's numbers, not a card of its own
  const slim = intro && !intro.includes('\n') && intro.length < 140;
  return h('div', { class: 'tracker' },
    intro && !slim && h('div', { class: 'prose', html: renderMarkdown(vault, intro) }),
    tables.map((tb, ti) => trackerTable(path, tb, ti, tables.length, ti === 0 && slim ? intro : null)));
}

function trackerTable(path, tb, ti, nTables, note = null) {
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
    note && h('p', { class: 'tracker-note', html: renderInline(vault, note) }),
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
          }, 'aria-label': 'Edit row', class: 'icon-btn' }, '✎'),
          h('button', { class: 'icon-btn danger', title: 'Delete row', 'aria-label': 'Delete row', onclick: () => { if (confirm('Delete this row?')) op((t) => md.deleteRow(t, r)); } }, '×'))),
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
  // a line per station ("- Name | state | detail"); indented lines under it say more (shown when it is tapped)
  const rows = [];
  for (const l of t.slice(fm.bodyStart).split('\n')) {
    const top = l.match(/^[-*]\s+(.+)$/), sub = l.match(/^\s+(?:[-*]\s+)?(\S.*)$/);
    if (top) { const [name, state = '', detail = ''] = top[1].split('|').map((x) => x.trim()); rows.push({ name, state, detail, more: [] }); }
    else if (sub && rows.length) rows[rows.length - 1].more.push(sub[1]);
  }
  const stella = rows.find((r) => /^stella$/i.test(r.name));
  // the Lab shows the two pipelines only, always in this order (Levin, 8 Nov 2026: no Museum, no Paper Architect)
  const stations = ['Library of Ohara', 'Punk Records'].map((name) => rows.find((r) => r.name.toLowerCase() === name.toLowerCase()) || { name, state: '', detail: '', more: [] });
  return { updated: fm.data.updated, stella, stations };
}

// tapping Stella or a station: what exactly is going on, and what came of it lately
// "16:28" today, "7 Nov 16:28" before (a time as Stella writes it: 2026-11-08 16:28 or 2026-11-08T16:28)
const when = (x) => { const d = x.slice(0, 10), t = x.slice(11, 16); return d === iso(new Date()) ? t : `${new Date(d + 'T12:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${t}`; };
// Stella's nightly report in parts: "**Filed:** …" becomes { label: 'Filed', text: '…' }; lines without a label join the part above
function reportParts(body) {
  const parts = [];
  for (const para of body.split(/\n\s*\n/)) {
    const bits = para.split(/\*\*([^*]+?):\*\*/);
    if (bits[0].trim()) { if (parts.length) parts.at(-1).text += '\n' + bits[0].trim(); else parts.push({ label: '', text: bits[0].trim() }); }
    for (let k = 1; k < bits.length; k += 2) parts.push({ label: bits[k].trim(), text: (bits[k + 1] || '').trim() });
  }
  return parts.filter((x) => x.text);
}
// the first sentence ("et al. 2026" is not an end: a sentence ends before a capital letter)
const firstSentence = (t) => { const m = t.replace(/\n[\s\S]*/, '').match(/^[\s\S]*?[.!?](?=\s+[A-Z(]|$)/); return m ? m[0] : t.split('\n')[0]; };
// one row: its name small and grey in front, one line of text; a tap shows all of it (Levin, 11 Nov 2026: "way too much
// text"; everything of Stella's at a glance)
function reportRow(part) {
  // no dots (Levin, 11 Nov 2026): the first sentence in full; what follows opens under it with the small arrow
  const text = part.text[0].toUpperCase() + part.text.slice(1);
  // condensed: of a first sentence with a colon, only what comes before it ("One work was added"); the rest opens under it
  let short = firstSentence(text), more = text.slice(short.length).trim();
  const colon = short.indexOf(': ');
  if (colon > 8) { more = (short.slice(colon + 2).replace(/^./, (c) => c.toUpperCase()) + ' ' + more).trim(); short = short.slice(0, colon) + '.'; }
  const row = h('div', { class: 'act-row' + (more ? ' has-more' : ''), onclick: () => more && row.classList.toggle('open') },
    part.label && h('span', { class: 'act-label' }, part.label),
    h('span', { class: 'act-text' }, h('span', { class: 'act-short', html: renderInline(vault, short) }),
      more && h('div', { class: 'act-rest', html: renderMarkdown(vault, more) })),
    more && h('span', { class: 'act-caret', 'aria-hidden': 'true' }));
  return row;
}
const actBox = (head, side, kids) => h('section', { class: 'agenda act-box' },
  head && h('div', { class: 'agenda-head' }, head, side && h('span', { class: 'act-when' }, side)), kids);
// the nightly reports, newest first: { date: '11 Nov', parts }
function reports(n = 7) {
  const year = new RegExp(` ${new Date().getFullYear()}\\b`);
  return (vault.read('System/Stella.md') || '').split(/\n(?=## )/).filter((x) => x.startsWith('## ')).slice(0, n).map((x) => ({
    date: (x.match(/^## (.*)/)?.[1] || '').replace(/\s*\(.*$/, '').replace(year, ''),
    parts: reportParts(x.replace(/^## .*\n?/, '')) }));
}

// the report at a glance: short names, and the three small counts in one row
const SHORT_LABELS = { 'nightly jobs': 'Jobs', 'reading lists': 'Reading', 'library index': 'Library', 'open to-dos': 'To-dos' };
function glance(parts) {
  const small = parts.filter((x) => /^(asked|open to-dos|messages)$/i.test(x.label));
  // (a part that only says nothing happened is left out: "nothing ticked")
  const out = parts.filter((x) => !small.includes(x) && !/^library index$/i.test(x.label) && !/^nothing\b[^.]{0,30}\.?$/i.test(x.text)).map((x) => ({ ...x, label: SHORT_LABELS[x.label.toLowerCase()] || x.label }));
  // "12 to-dos · 11 messages" (and a question asked, if one was)
  const num = (re) => small.find((x) => re.test(x.label))?.text.match(/\d+/)?.[0];
  const asked = small.find((x) => /^asked$/i.test(x.label))?.text;
  const open = [asked && !/^nothing/i.test(asked) && `asked ${asked.replace(/\.$/, '')}`, num(/to-dos/i) && `${num(/to-dos/i)} to-dos`, num(/messages/i) && `${num(/messages/i)} messages`].filter(Boolean);
  if (open.length) out.push({ label: 'Open', text: open.join(' · ') });
  return out;
}
// tapping Stella or a station (Levin, 11 Nov 2026): what it is doing now, then what the reports say about it, a line a
// row; no report time (the Lab says it); no taller than the ≡ menu
// the sheet for Stella or a station: what it is doing now, then what the reports say about it
function actSheet(row, close) {
  const name = row.name.toLowerCase(), stella = name === 'stella';
  const runs = reports(), last = runs[0];
  const busy = !quiet(row.state);
  const state = busy ? (stella ? `At ${row.state}` : row.state[0].toUpperCase() + row.state.slice(1)) : 'Idle';
  let boxes;
  if (stella) {
    const hl = health(), bits = (hl?.line || '').replace(/^Stella( needs you)?:\s*/i, '').split(/\s+·\s+|;\s+/).filter(Boolean);  // (Stella also joins with "; ")
    const beat = heartbeats()[0];
    const beatText = beat && (beat.state === 'running' ? `hourly run going since ${when(beat.start)}` : beat.state === 'stuck' ? `last hourly run stopped (${when(beat.start)})` : `last hourly run ${when(beat.end || beat.start)} ✓`);
    boxes = [
      (bits.length || beat) && actBox('', '', (() => {
        const line = (beatPart) => [...bits.map((b) => b.replace(/^Claude usage/i, 'Claude')), beatPart].filter(Boolean).join(' · ').replace(/^./, (c) => c.toUpperCase());
        const el = fitLine([line(beatText?.replace(/^last /, '')), line(beatText?.replace(/^(last )?hourly run (going since )?/, '')), line(null)]);
        return h('a', { class: 'act-row act-health', href: '#/heartbeat', onclick: close }, el);
      })()),
      actBox('Last night', last && h('a', { class: 'act-all', href: fileHref('System/Stella.md'), onclick: close }, `${last.date} · all reports →`), last?.parts.length ? glance(last.parts).map(reportRow) : emptyState('No report yet')),
    ];
  } else {
    // the Library: what was filed each night and how big it is; Punk Records: the notes made each night
    const ohara = name.includes('ohara');
    const re = ohara ? /^filed$/i : /^pipeline$/i;
    const nights = runs.map((r) => ({ date: r.date, part: r.parts.find((x) => re.test(x.label)) })).filter((x) => x.part);
    const size = ohara && last?.parts.find((x) => /^library index$/i.test(x.label));
    boxes = [
      (row.detail || row.more.length > 0) && actBox('Now', '', [row.detail, ...row.more].filter(Boolean).map((t) => reportRow({ label: '', text: t }))),
      // one grey line at the top, as Stella's (Levin, 11 Nov 2026): the Library's size; Punk Records' newest note, and its
      // number of notes once Stella reports it (a "notes:" count in System/Library.md)
      (() => {
        const lib = md.splitFrontmatter(vault.read('System/Library.md') || '').data;
        if (ohara) { const n = lib.works || size?.text.match(/\d+/)?.[0]; return n && actBox('', '', h('div', { class: 'act-row act-health' }, `${n} works in the library`)); }
        const newest = nights.map((x) => ({ date: x.date, who: x.part.text.match(/^(.+?) (?:has|have) (?:a )?notes? and/)?.[1] })).find((x) => x.who);
        const n = lib.notes && `${lib.notes} notes`, r = lib.repairs != null && lib.repairs !== '' && `${lib.repairs} repairs waiting`;
        const line = (...b) => b.filter(Boolean).join(' · ').replace(/^./, (c) => c.toUpperCase());
        // one line only (Levin, 11 Nov 2026): the longest that fits, then shorter ones
        const variants = [line(n, newest && `last new note: ${newest.who} · ${newest.date}`, r), line(n, newest && `newest: ${newest.who}`, r),
          line(n, r && r.replace(' waiting', '')), line(n), line(newest && `newest: ${newest.who}`)].filter(Boolean);
        return variants.length > 0 && actBox('', '', fitLine(variants));
      })(),
      actBox(ohara ? 'Filed' : 'New notes', '', nights.length ? nights.map((x) => reportRow({ label: x.date, text: x.part.text })) : emptyState('Nothing to report')),
    ];
  }
  return h('div', { class: 'sheet activity-sheet', role: 'dialog', 'aria-label': row.name },
      // what it is doing, beside its name: one line for both
      h('div', { class: 'sheet-head' }, h('span', { class: 'label' }, row.name, h('span', { class: 'act-now' }, state)), h('button', { class: 'quiet', 'aria-label': 'Close', onclick: close }, '×')),
      boxes,
      null);
}
// a grey top line that must stay on one line: it carries the texts, longest first; fitLines() picks the longest that fits
const fitLine = (variants) => h('div', { class: 'act-row act-health act-fit', 'data-variants': JSON.stringify(variants) }, variants[0]);
function fitLines(root) {
  for (const el of root.querySelectorAll('.act-fit')) {
    if (!el.clientWidth) { el.textContent = JSON.parse(el.dataset.variants)[0]; continue; }  // (not laid out yet: nothing to measure)
    const fits = () => el.scrollWidth <= el.clientWidth + 1;
    for (const v of JSON.parse(el.dataset.variants)) { el.textContent = v; if (fits()) break; }
    // never longer than the box (Levin, 14 Nov 2026), and no dots: the longest parts go first (the first one stays),
    // then words from the end
    const parts = el.textContent.split(' · ');
    while (!fits() && parts.length > 1) { let k = 1; parts.forEach((x, i) => { if (i && x.length >= parts[k].length) k = i; }); parts.splice(k, 1); el.textContent = parts.join(' · '); }
    const words = el.textContent.split(' ');
    while (!fits() && words.length > 1) { words.pop(); el.textContent = words.join(' ').replace(/[;,:·\s]+$/, ''); }
  }
}
const actRows = () => { const { stella: st, stations } = readActivity(); return [st || { name: 'Stella', state: '', detail: '', more: [] }, ...stations]; };
function openActivity(row, slide = null) {
  $('.sheet-back')?.remove();
  const close = () => back.remove();
  // all three the same size, with no empty space (Levin, 11 Nov 2026): as tall as the fullest of the three (never taller
  // than the ≡ menu on the phone); in the others the last box reaches down to the bottom
  const probe = h('div', { class: 'sheet-back no-fade', style: 'visibility:hidden; pointer-events:none' });
  document.body.append(probe);
  let tall = 0;
  for (const r of actRows()) { const p = actSheet(r, () => {}); probe.replaceChildren(p); fitLines(p); tall = Math.max(tall, p.getBoundingClientRect().height); }
  probe.remove();
  const back = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === back) close(); } }, actSheet(row, close));
  if (slide) back.classList.add('no-fade');
  document.body.append(back);
  // the height stays once it is open: a row opened with the arrow scrolls inside, the sheet never grows upwards
  const sh = $('.activity-sheet', back);
  fitLines(sh);
  sh.style.height = tall + 'px';
  if (slide) sh.classList.add(slide > 0 ? 'slide-next' : 'slide-prev');
  // a sideways swipe goes to the next or the one before: Stella, Library of Ohara, Punk Records (Levin, 11 Nov 2026)
  let x0 = null, y0 = 0;
  sh.addEventListener('touchstart', (e) => { x0 = e.touches.length === 1 ? e.touches[0].clientX : null; y0 = e.touches[0].clientY; }, { passive: true });
  sh.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const all = actRows();
    const k = all.findIndex((r) => r.name.toLowerCase() === row.name.toLowerCase()), next = all[k + (dx < 0 ? 1 : -1)];
    if (next) openActivity(next, dx < 0 ? 1 : -1);
  }, { passive: true });
}

// a sprite strip played with CSS steps; `scale` = screen pixels per sprite pixel
function sprite(name, scale, cls = '') {
  const el = h('div', { class: `sprite ${name.startsWith('stella') ? 'stella' : ''} ${cls}`, style: `--px:${scale}px` });
  const img = new Image();
  // Stella has his own dark-mode drawing (grey lines); the stations are simply inverted by CSS
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

let stellaAt = 0; // which station Stella stood at last, so he walks from there
// Stella's hourly runs (System/Heartbeat.md, from `stella beat start` / `stella beat done "…"`): newest first;
// a start with no end before the next start never finished (usually stopped at a permission prompt)
function heartbeats() {
  const rows = (vault.read('System/Heartbeat.md') || '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(' | '));
  const runs = [];
  for (const [at, kind, note = ''] of rows) {
    if (kind === 'start') runs.push({ start: at, end: null, note: '' });
    else if (kind === 'done') { const open = runs.at(-1); if (open && !open.end) Object.assign(open, { end: at, note }); else runs.push({ start: null, end: at, note }); }
  }
  const now = Date.now(), t = (x) => new Date(x.replace(' ', 'T')).getTime();
  return runs.reverse().map((r, i) => ({ ...r, state: r.end ? 'ok' : i === 0 && now - t(r.start) < 55 * 60e3 ? 'running' : 'stuck' }));
}
function labView() {
  const { updated, stella, stations } = readActivity();
  const small = isMobile();
  // Stella stands in the same row as the two stations (Levin, 8 Nov 2026: the free space used, less height); she types or
  // writes while she works at one, and thinks while idle
  const target = stella ? stations.findIndex((s) => s.name.toLowerCase() === stella.state.toLowerCase()) : -1;
  const work = stella && target >= 0 ? (/writ|note|draft/i.test(stella.detail) ? 'stella-write' : 'stella-type') : 'stella-think';
  const stellaCell = h('button', { class: 'station stella-cell' + (target < 0 ? ' quiet' : ''), 'aria-label': 'What Stella is doing', onclick: () => openActivity(stella || { name: 'Stella', state: '', detail: '', more: [] }) },
    h('div', { class: 'fig' }, sprite(work, small ? 3 : 4, work === 'stella-think' ? 'thinks' : '')), h('div', { class: 'label' }, 'Stella'), target >= 0 && h('div', { class: 'station-state' }, `at ${stations[target].name}`));
  const open = (p) => (vault.exists(p) ? md.countOpen(vault.read(p)) : 0);
  // the Filer: one card per row, as in Google Tasks (tick, swipe, hold to drag, ⇢ to file, ··· for details); its Completed
  // goes to the very bottom of the page
  const inbox = vault.read(INBOX) || '', cards = md.parseList(inbox).filter((x) => x.kind === 'item');
  const last = heartbeats()[0];
  const filer = cards.length > 0 ? listView(INBOX, inbox) : null, done = filer?.querySelector(':scope > .completed') || null;
  done?.remove();
  return h('div', { class: 'page lab-page' },
    // Stella's own report time, not the app's sync (that shows at the bottom of the sidebar)
    pageHead('Lab', 'Lab'),
    h('section', { class: 'scene' },
      h('div', { class: 'stations', style: `grid-template-columns: repeat(${stations.length + 1}, 1fr)` }, stellaCell,
        stations.map((s) => h('button', { class: 'station' + (quiet(s.state) ? ' quiet' : ''), 'aria-label': `${s.name}: what it is doing`, onclick: () => openActivity(s) },
          h('div', { class: 'fig' }, sprite('station-' + stationSprite(s.name), small ? 5 : 7)),  // a bit taller beside Stella (Levin, 11 Nov 2026: version A)
          h('div', { class: 'label' }, s.name),
          !quiet(s.state) && h('div', { class: 'station-state' }, s.state),
          s.detail && h('div', { class: 'meta' }, s.detail)))),
      // what Stella says, if he says something; what runs at a station shows under it, never twice (Levin, 8 Nov 2026).
      // Under it, when he reported and how his last hourly run went (Claude sessions elsewhere are not shown here)
      (stella?.detail || !vault.exists(ACTIVITY)) && h('p', { class: 'stella-says' }, stella?.detail || 'Waiting for Stella’s first report.'),
      (updated || last) && h('p', { class: 'stella-when' }, [updated && `Reported ${when(updated.replace(' ', 'T'))}`,
        last && (last.state === 'running' ? `hourly run since ${when(last.start)}` : last.state === 'stuck' ? `last hourly run ${when(last.start)} ×` : `last hourly run ${when(last.end || last.start)} ✓`)].filter(Boolean).join(' · '))),
    h('section', { class: 'lab-filer' },
      h('div', { class: 'day-head' }, h('span', { class: 'label', oncontextmenu: (e) => filerMenu(e) }, 'Filer'),
        cards.filter((x) => !x.checked).length > 1 && h('a', { class: 'meta filer-sort', href: `#/sort/${encodeURIComponent(INBOX)}` }, 'Sort one by one →')),
      filer || emptyState('Nothing to file')),
    // the Lab's pages, as buttons; Questions in red while something new waits there
    h('nav', { class: 'lab-links' },
      // Heartbeat first: a heart while his hourly runs work, a red × when the last one stopped (Levin, 8 Nov 2026)
      [['#/heartbeat', 'Heartbeat', last && (last.state === 'stuck' ? '×' : 'heart')],
        ['#/questions', 'Questions', labCount(), labNew()], [FOR_STELLA, title(FOR_STELLA), open(FOR_STELLA)], [RESEARCH, title(RESEARCH), open(RESEARCH)],
        ['#/people', 'People'], [RULES, title(RULES)],  // "Rules" (its title:, Levin 8 Nov 2026; the file keeps its name)
        ['#/recent', 'Recent'],  // here since 11 Nov 2026, out of the phone's bar
        ...vault.list().map((f) => f.path).filter((p) => /\.md$/i.test(p) && area(p) === 'lab').sort(byOrder).map((p) => [p, title(p)])]
        .filter(([p]) => p.startsWith('#') ? p !== '#/people' || vault.exists(PEOPLE) : vault.exists(p))
        .map(([p, l, n, fresh]) => h('a', { class: 'lab-link', href: p.startsWith('#') ? p : fileHref(p) }, l,
          fresh ? h('i', { class: 'nav-new', 'aria-label': `${fresh} new` }, String(fresh))
            : n === 'heart' ? h('span', { class: 'lab-heart', 'aria-label': 'working', html: pix(ICONS.heart) })
            : n ? h('span', { class: 'lab-n' + (n === '×' ? ' bad' : '') }, String(n)) : null))),
    done && h('section', { class: 'lab-done' }, done));
}

// Stella's hourly runs, newest first: ✓ finished (with what that run did), × stopped before the end, … running now
const beatsOpen = new Set();  // runs shown in full: a tap on a run opens or closes its whole note (Levin, 8 Nov 2026)
function heartbeatView() {
  const runs = heartbeats().slice(0, 40), hm = (x) => x && (x.slice(0, 10) === iso(new Date()) ? x.slice(11) : `${dayLabel(x.slice(0, 10))} ${x.slice(11)}`);
  const toggle = (e, k) => { const on = e.currentTarget.classList.toggle('open'); if (on) beatsOpen.add(k); else beatsOpen.delete(k); e.currentTarget.setAttribute('aria-expanded', String(on)); };
  return h('div', { class: 'page heartbeat-page' },
    pageHead('Lab', 'Heartbeat', help('Stella runs once an hour. A heart: the run finished, with what it did. ×: it stopped before the end (usually waiting at a permission prompt: open Stella · Heartbeat in the Claude app). …: running now.')),
    runs.length ? h('section', { class: 'beats' }, runs.map((r, i, _, k = r.start || r.end || String(i)) => h('div', { class: 'beat beat-' + r.state + (beatsOpen.has(k) ? ' open' : ''),
      role: 'button', tabindex: '0', 'aria-expanded': String(beatsOpen.has(k)), onclick: (e) => toggle(e, k), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e, k); } } },
      h('span', { class: 'beat-mark', 'aria-label': { ok: 'finished', stuck: 'did not finish', running: 'running' }[r.state], html: r.state === 'ok' ? pix(ICONS.heart) : { stuck: '×', running: '…' }[r.state] }),
      h('span', { class: 'beat-time' }, hm(r.start || r.end)),
      h('span', { class: 'beat-note' }, r.note || (r.state === 'stuck' ? 'did not finish' : r.state === 'running' ? 'running' : '')))))
      : emptyState('No runs yet'));
}

// what is new is marked red where it is (Levin, 8 Nov 2026), and counts as seen two seconds after it was shown
let seeTimer = null;
function seeLater(what, mark) {
  clearTimeout(seeTimer);
  const at = location.hash;
  seeTimer = setTimeout(() => { if (location.hash !== at) return; mark(); saveUi(); renderTabbar(); renderSide(); renderMain(); }, 2000);
}
// the open questions, each with its answer box (Questions in the Lab); opening it counts as seeing what is new there
function questionsView() {
  if (labNew()) seeLater('questions', () => { ui.seenLab = labItems(); });
  const questions = vault.read(QUESTIONS);
  const qs = questions != null ? questionsOf(md.parseList(questions).filter((s) => s.kind === 'item')) : [];
  return h('div', { class: 'page questions-page' },
    pageHead('Lab', 'Questions', help('Write or speak your answer and send it with ✓: the question is settled and Stella gets your answer. If he needs more, he asks again.')),
    questions != null && questionCards(questions),
    !labCount() && emptyState('No open questions'),
    // the older way: one recording or text for several questions, matched to them
    qs.some((q) => !q.done) && h('details', { class: 'q-voice' }, h('summary', {}, 'Answer several at once by voice'), answerPanel(qs)),
    h('a', { class: 'review-link quiet-link', href: fileHref(QUESTIONS) }, 'All questions →'));
}

// ---------- answering an Open Question: a box under each one; Send writes "Your answer (8 Nov): …" under it ----------
const answerDrafts = {};  // what was typed but not sent yet, per question, kept across redraws
function questionCards(text) {
  const open = md.parseList(text).filter((s) => s.kind === 'item' && !s.checked);
  if (!open.length) return null;
  return h('div', { class: 'q-cards' }, open.map((it) => {
    const id = (it.text.match(/\((Q\d+)\)\s*$/) || [])[1], key = id || it.text;
    const why = it.notes.find((n) => n.text.startsWith('Why:'))?.text.slice(4).trim();
    const said = it.notes.filter((n) => !/^(Why|From):/.test(n.text));
    const area = h('textarea', { class: 'q-answer', rows: 2, placeholder: 'Your answer', 'aria-label': `Your answer${id ? ' to ' + id : ''}`, enterkeyhint: 'send',
      oninput: (e) => { answerDrafts[key] = e.target.value; grow(e.target); }, onkeydown: sendOnEnter(() => send()) });
    area.value = answerDrafts[key] || '';
    const send = () => {
      const v = area.value.trim(); if (!v) { area.focus(); return; }
      live?.rec.stop();
      update(QUESTIONS, (t) => {
        const f = md.findItem(t, it); if (!f) return t;
        let x = md.addNote(t, f, answerLine(v));
        const g = md.findItem(x, it);
        return g ? md.toggleItem(x, g.line) : x;
      });
      delete answerDrafts[key];
      toast('Answered');
    };
    const mic = h('span', { class: 'q-mic' });
    const drawMic = () => mic.replaceChildren(...(SR && !liveFailed ? liveButtons(area, drawMic) : []));
    drawMic();
    return h('article', { class: 'q-card' },
      h('div', { class: 'q-head' }, h('div', { class: 'q-text', html: renderInline(vault, it.text.replace(/\s*\((Q\d+)\)\s*$/, '')) }),
        !(ui.seenLab || []).includes(it.text) && h('i', { class: 'item-new', 'aria-label': 'new' }), id && h('span', { class: 'meta' }, id)),
      why && h('p', { class: 'meta q-why' }, why),
      said.map((n) => h('p', { class: 'q-prev', html: renderInline(vault, n.text) })),
      area,
      h('div', { class: 'q-tools' }, mic,
        h('button', { class: 'send', 'aria-label': 'Send the answer', title: 'Send', onclick: send }, h('i', { class: 'tick-icon', 'aria-hidden': 'true' }))));
  }));
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
        listening && h('span', { class: 'answer-hint' }, 'Listening…')),
      h('form', { class: 'answer-type', onsubmit: (e) => { e.preventDefault(); if (answerDraft.trim()) { startReview(answerDraft, qs); renderMain(); } } },
        h('textarea', { rows: 1, placeholder: 'Or type them.', value: answerDraft, 'data-keep': 'answer', 'aria-label': 'Answers', enterkeyhint: 'send',
          oninput: (e) => { answerDraft = e.target.value; }, onkeydown: sendOnEnter((e) => e.target.form.requestSubmit()) }),
        h('button', { type: 'submit', class: 'link' }, 'Match'))),
    waiting.map((e) => h('div', { class: 'answer-wait' },
      h('span', { class: 'meta' }, 'Transcribing…'),
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
      ''),
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
          h('span', { class: 'meta' }, p.qid ? how[p.how] || '' : 'Not matched'),
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
        help('A fine-grained GitHub token for this repository only, with Contents: read and write. It stays on this device.')),
      h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save and connect'), h('span', { class: 'msg meta' }))),
    !first && h('section', { class: 'settings-status' },
      h('div', { class: 'label' }, 'Status'),
      h('p', {}, `${vault.backend?.label || '—'} · ${vault.list().length} files · ${st.state}${st.pending ? ` · ${st.pending} waiting` : ''}`),
      // which release this device runs (the service worker's cache name), to check the phone has the newest one
      (() => { const el = h('p', { class: 'meta app-version' }); caches?.keys().then((k) => { const v = k.filter((x) => /^v\d+$/.test(x)).sort((a, b) => b.slice(1) - a.slice(1))[0]; el.textContent = v ? `App ${v}` : ''; }).catch(() => {}); return el; })(),
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
      h('div', { class: 'label' }, 'Icon', help('Used when you add the app to the Home Screen or Dock; an icon already there stays until you remove the app and add it again.')),
      h('div', { class: 'icon-pick' }, ['light', 'dark'].map((v) => {
        const sfx = v === 'dark' ? '-dark' : '';
        const on = getPref(KEYS.icon, 'dark') === v;
        return h('button', { class: 'icon-option' + (on ? ' on' : ''), onclick: () => {
          setPref(KEYS.icon, v);
          $('#touch-icon').href = `icons/apple-touch-icon${sfx}.png`;
          $('#manifest').href = `manifest${sfx}.webmanifest`;
          renderMain();
        }, 'aria-label': v === 'dark' ? 'Dark icon' : 'Light icon' }, h('img', { src: `icons/icon-192${sfx}.png`, alt: '' }));
      }))),
    h('section', { class: 'settings-help' },
      h('div', { class: 'label' }, 'Install', help('iPhone: Safari → Share → Add to Home Screen, with Open as Web App on. Mac: Safari → File → Add to Dock.'))));
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
  let was = null;
  try { was = JSON.parse(sessionStorage.getItem('mf-swap') || 'null'); sessionStorage.removeItem('mf-swap'); } catch {}
  // the app opens on the Lab when it starts afresh (Levin, 8 Nov 2026); a reload (a new release swapped in while it was
  // open, or the browser's own reload) stays on the page it was on, so it never jumps away from what Levin is reading
  const nav = performance.getEntriesByType?.('navigation')?.[0]?.type;
  const reloaded = was?.shown || nav === 'reload' || nav === 'back_forward';
  if (!reloaded) { depth = 0; history.replaceState({ n: 0, d: 0 }, '', !route().write && location.hash && location.hash !== '#/' ? location.pathname + '#/' : location.href); }
  followTab();
  render();
  if (was?.shown && was.hash === location.hash) setTimeout(() => scrollTo(0, was.y), 0);  // back where you were before the swap
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
  try { sessionStorage.removeItem('mf-swap'); } catch {}
  render();
}

// instant and current: the service worker serves the app from its copy at once, then checks for a new release (on
// opening and whenever the app comes to the front). A new release swaps in while you use the app, at a quiet moment:
// nothing being typed, no sheet open, no drag or recording, two seconds without a touch. The page and scroll position
// stay where they were. (Your lists and notes don't wait for this: they sync on their own.)
if ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  const had = !!navigator.serviceWorker.controller;
  let swapPending = false, touched = Date.now();
  for (const ev of ['pointerdown', 'keydown', 'scroll', 'touchmove']) addEventListener(ev, () => { touched = Date.now(); }, { passive: true, capture: true });
  const quiet = () => !editingInMain() && !document.activeElement?.matches?.('input, textarea, [contenteditable="true"]') && !$('.sheet-back')
    && !document.body.classList.contains('drawer-open') && !drag && !recording && !live && !ui.selecting?.[route().path];
  const swap = () => {
    try { sessionStorage.setItem('mf-swap', JSON.stringify({ hash: location.hash, y: scrollY, shown: document.visibilityState === 'visible' })); } catch {}
    location.reload();
  };
  const trySwap = () => {
    if (!swapPending) return;
    if (document.visibilityState === 'hidden' || (quiet() && Date.now() - touched > 2000)) swap();
    else setTimeout(trySwap, 1000);
  };
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    addEventListener('focus', () => reg.update().catch(() => {}));  // the Mac's Dock app: coming back to its window
    setInterval(() => reg.update().catch(() => {}), 5 * 60 * 1000);
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) { swapPending = true; trySwap(); } });
  document.addEventListener('visibilitychange', () => { if (swapPending && document.visibilityState === 'hidden') swap(); });
}
boot();
