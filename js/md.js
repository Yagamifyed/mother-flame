// Markdown helpers. The file text is always the source of truth: views parse it,
// and every edit is a small, line-level change to that text, so anything the app
// doesn't understand (headings, prose, images) survives untouched.

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- frontmatter ----------

export function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return { data: {}, raw: '', bodyStart: 0 };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { data: {}, raw: '', bodyStart: 0 };
  const raw = text.slice(4, end);
  const data = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) data[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const after = text.indexOf('\n', end + 4);
  const bodyStart = after === -1 ? text.length : after + 1;
  return { data, raw, bodyStart, lineCount: text.slice(0, bodyStart).split('\n').length - 1 };
}

export function setFrontmatterKey(text, key, value) {
  const fm = splitFrontmatter(text);
  if (!fm.raw && !text.startsWith('---\n')) {
    return `---\n${key}: ${value}\n---\n${text}`;
  }
  const lines = fm.raw.split('\n');
  const i = lines.findIndex((l) => l.startsWith(key + ':'));
  if (value === null) { if (i >= 0) lines.splice(i, 1); }
  else if (i >= 0) lines[i] = `${key}: ${value}`;
  else lines.push(`${key}: ${value}`);
  if (!lines.some((l) => l.trim())) return text.slice(fm.bodyStart);
  return `---\n${lines.join('\n')}\n---\n${text.slice(fm.bodyStart)}`;
}

export function fileType(path, text) {
  const t = splitFrontmatter(text).data.type;
  if (t) return t;
  const top = path.split('/')[0].toLowerCase();
  if (top === 'lists') return 'list';
  if (top === 'trackers') return 'tracker';
  return 'note';
}

// ---------- list items ----------

const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;
const DUE = /\s*📅\s*(\d{4}-\d{2}-\d{2})/;
const DONE = /\s*✅\s*(\d{4}-\d{2}-\d{2})/;
// as in Obsidian Tasks: ⏰ a time, 🔁 a repeat ("every week")
const TIME = /\s*⏰\s*(\d{1,2}:\d{2})/;
const REPEAT = /\s*🔁\s*(every [^📅⏰✅⭐\n]*?)(?=\s*(?:📅|⏰|✅|⭐|$))/u;

const indentOf = (s) => s.replace(/\t/g, '    ').length;

export function parseItemLine(line) {
  const m = line.match(ITEM);
  if (!m) return null;
  let text = m[4];
  const due = (text.match(DUE) || [])[1] || null;
  const done = (text.match(DONE) || [])[1] || null;
  const time = (text.match(TIME) || [])[1] || null;
  const repeat = (text.match(REPEAT) || [])[1]?.trim() || null;
  text = text.replace(DUE, '').replace(DONE, '').replace(TIME, '').replace(REPEAT, '').trimEnd();
  return {
    indent: indentOf(m[1]),
    lead: m[1],
    marker: m[2],
    checkbox: m[3] !== undefined,
    checked: m[3] === 'x' || m[3] === 'X',
    text, due, done, time, repeat,
  };
}

function buildLine(it) {
  let s = `${it.lead}${it.marker} `;
  if (it.checkbox) s += `[${it.checked ? 'x' : ' '}] `;
  s += it.text;
  if (it.repeat) s += ` 🔁 ${it.repeat}`;
  if (it.due) s += ` 📅 ${it.due}`;
  if (it.due && it.time) s += ` ⏰ ${it.time}`;
  if (it.checkbox && it.checked && it.done) s += ` ✅ ${it.done}`;
  return s;
}

// Splits the body into top-level segments: list items (with nested children and
// note lines) and plain markdown runs. Line numbers refer to the whole file.
export function parseList(text) {
  const lines = text.split('\n');
  const start = splitFrontmatter(text).lineCount || 0;
  const segments = [];
  let i = start;

  function readItem(idx) {
    const it = parseItemLine(lines[idx]);
    const node = { ...it, line: idx, end: idx + 1, children: [], notes: [] };
    let j = idx + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() === '') {
        // a blank line only continues the item if indented content follows
        let k = j; while (k < lines.length && lines[k].trim() === '') k++;
        if (k < lines.length && indentOf(lines[k].match(/^\s*/)[0]) > it.indent) { j = k; continue; }
        break;
      }
      const ind = indentOf(l.match(/^\s*/)[0]);
      if (ind <= it.indent) break;
      const child = parseItemLine(l);
      if (child) { const c = readItem(j); node.children.push(c); j = c.end; }
      else { node.notes.push({ line: j, text: l.trim() }); j++; }
    }
    node.end = j;
    return node;
  }

  let mdStart = null;
  const flushMd = (end) => {
    if (mdStart !== null) {
      const chunk = lines.slice(mdStart, end).join('\n');
      if (chunk.trim()) segments.push({ kind: 'md', line: mdStart, end, text: chunk });
      mdStart = null;
    }
  };
  let inFence = false;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) inFence = !inFence;
    const it = !inFence && parseItemLine(l);
    if (it && it.indent === 0) {
      flushMd(i);
      const node = readItem(i);
      segments.push({ kind: 'item', ...node });
      i = node.end;
    } else {
      if (mdStart === null) mdStart = i;
      i++;
    }
  }
  flushMd(lines.length);
  return segments;
}

export function countOpen(text) {
  let n = 0;
  for (const s of parseList(text)) if (s.kind === 'item' && s.checkbox && !s.checked) n++;
  return n;
}

// ---------- list edits (pure: text in, text out) ----------

const edit = (text, fn) => { const lines = text.split('\n'); fn(lines); return lines.join('\n'); };

export function toggleItem(text, line) {
  return edit(text, (L) => {
    const it = parseItemLine(L[line]); if (!it) return;
    if (!it.checkbox) { it.checkbox = true; it.checked = true; }
    else it.checked = !it.checked;
    it.done = it.checked ? today() : null;
    L[line] = buildLine(it);
    // a repeating task, ticked off: the next one appears above it, on its next day
    if (it.checked && it.repeat) L.splice(line, 0, buildLine({ ...it, checked: false, done: null, due: nextDue(it.due || today(), it.repeat) }));
  });
}

// the day after `from` (YYYY-MM-DD) that a repeat ("every day", "every weekday", "every 2 weeks", "every month") lands on
export function nextDue(from, rule) {
  const m = (rule || '').match(/every\s+(?:(\d+)\s+)?(day|weekday|week|month|year)s?/i);
  const d = new Date(from + 'T12:00:00');
  if (!m || isNaN(d)) return from;
  const n = +(m[1] || 1), unit = m[2].toLowerCase();
  if (unit === 'day') d.setDate(d.getDate() + n);
  else if (unit === 'weekday') do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
  else if (unit === 'week') d.setDate(d.getDate() + 7 * n);
  else { const day = d.getDate(); d.setDate(1); unit === 'month' ? d.setMonth(d.getMonth() + n) : d.setFullYear(d.getFullYear() + n);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }  // the 31st → the month's last day
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// set one of a task's markers: { due, time, repeat } (null clears it)
export function setItemFields(text, line, fields) {
  return edit(text, (L) => {
    const it = parseItemLine(L[line]); if (!it) return;
    Object.assign(it, fields);
    L[line] = buildLine(it);
  });
}

export function setItemText(text, line, value) {
  return edit(text, (L) => {
    const it = parseItemLine(L[line]); if (!it) return;
    it.text = value.replace(/\n/g, ' ').trim();
    L[line] = buildLine(it);
  });
}

export function setItemDue(text, line, due) {
  return edit(text, (L) => {
    const it = parseItemLine(L[line]); if (!it) return;
    it.due = due || null;
    L[line] = buildLine(it);
  });
}

export function setItemNotes(text, item, notes) {
  return edit(text, (L) => {
    const lead = L[item.line].match(/^\s*/)[0] + '\t';
    const newLines = notes.split('\n').map((s) => s.trimEnd()).filter((s) => s.trim()).map((s) => lead + s);
    // drop existing note lines (bottom-up so indices stay valid)
    for (const n of [...item.notes].reverse()) L.splice(n.line, 1);
    L.splice(item.line + 1, 0, ...newLines);
  });
}

// one more note line under an item, after its notes and sub-items (an answer under an Open Question)
export function addNote(text, item, note) {
  return edit(text, (L) => { L.splice(item.end, 0, L[item.line].match(/^\s*/)[0] + '\t' + note.replace(/\s*\n\s*/g, ' ').trim()); });
}

export function deleteItem(text, item) {
  return edit(text, (L) => { L.splice(item.line, item.end - item.line); });
}

export function addItem(text, value, { parent = null, checkbox = true, top = false } = {}) {
  const segs = parseList(text);
  return edit(text, (L) => {
    if (parent) {
      const lead = L[parent.line].match(/^\s*/)[0] + '\t';
      L.splice(parent.end, 0, `${lead}- ${checkbox ? '[ ] ' : ''}${value}`);
      return;
    }
    const items = segs.filter((s) => s.kind === 'item');
    const line = `- ${checkbox ? '[ ] ' : ''}${value}`;
    if (items.length && top) L.splice(items[0].line, 0, line);
    else if (items.length) {
      // after the last open item, so new tasks sit with the other open ones
      const open = items.filter((s) => !s.checked);
      const anchor = (open.length ? open : items).at(-1);
      L.splice(anchor.end, 0, line);
    } else {
      while (L.length && L.at(-1).trim() === '') L.pop();
      const fmEnd = splitFrontmatter(text).lineCount || 0;
      if (L.length > fmEnd) L.push('');
      L.push(line, '');
    }
  });
}

export function moveItem(text, item, dir) {
  const segs = parseList(text).filter((s) => s.kind === 'item');
  const idx = segs.findIndex((s) => s.line === item.line);
  const other = segs[idx + dir];
  if (!other) return text;
  return edit(text, (L) => {
    const [a, b] = dir < 0 ? [other, segs[idx]] : [segs[idx], other];
    const A = L.slice(a.line, a.end), B = L.slice(b.line, b.end);
    const between = L.slice(a.end, b.line);
    L.splice(a.line, b.end - a.line, ...B, ...between, ...A);
  });
}

// find an item again after the file may have shifted under us (sync, other edits)
export function findItem(text, item) {
  const all = [];
  const walk = (nodes) => { for (const n of nodes) if (n.kind === 'item' || n.children) { all.push(n); walk(n.children || []); } };
  walk(parseList(text));
  return all.find((n) => n.line === item.line && n.text === item.text)
      || all.find((n) => n.text === item.text && n.indent === item.indent) || null;
}

// move an item (with its sub-items and notes) within its file, to `depth` (0 = top level, one tab per step):
// right after `after`'s whole block (as its next sibling, or as its last sub-item when one step deeper), or else
// just before `before`, or else after the last item
export function dropItem(text, item, { after = null, before = null, depth = 0 } = {}) {
  const f = findItem(text, item);
  if (!f) return text;
  const L = text.split('\n');
  const lead = L[f.line].match(/^\s*/)[0];
  const block = L.slice(f.line, f.end).map((l) => (l.startsWith(lead) ? '\t'.repeat(depth) + l.slice(lead.length) : l));
  L.splice(f.line, f.end - f.line);
  const rest = L.join('\n');
  const a = after && findItem(rest, after), b = before && findItem(rest, before);
  let at;
  if (a) at = a.end;
  else if (b) at = b.line;
  else { const items = parseList(rest).filter((x) => x.kind === 'item'); at = items.length ? items.at(-1).end : L.length; }
  L.splice(at, 0, ...block);
  return L.join('\n');
}

// a task that gets a new day goes to the top of its list, or of its section under a heading (Levin, 11 Nov 2026:
// "it should always go to the top"); sub-tasks stay with their parent
export function toTop(text, item) {
  const segs = parseList(text), k = segs.findIndex((s) => s.kind === 'item' && s.line === item.line && s.text === item.text);
  if (k < 0) return text;
  let first = k; while (first > 0 && segs[first - 1].kind === 'item') first--;
  if (first === k) return text;
  const L = text.split('\n'), block = L.splice(segs[k].line, segs[k].end - segs[k].line);
  L.splice(segs[first].line, 0, ...block);
  return L.join('\n');
}
// move an item (with its children and notes) into another file
export function extractBlock(text, item) {
  const lines = text.split('\n').slice(item.line, item.end);
  const lead = lines[0].match(/^\s*/)[0];
  return lines.map((l) => (l.startsWith(lead) ? l.slice(lead.length) : l.trimStart()));
}
export function insertBlock(text, block, { top = true } = {}) {
  const items = parseList(text).filter((s) => s.kind === 'item');
  return edit(text, (L) => {
    if (top && items.length) { L.splice(items[0].line, 0, ...block); return; }
    while (L.length && L.at(-1).trim() === '') L.pop();
    if (L.length && !parseItemLine(L.at(-1))) L.push('');
    L.push(...block, '');
  });
}

// ---------- tables (trackers) ----------

const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l);

export function splitRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = []; let cur = '';
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && inner[i + 1] === '|') { cur += '|'; i++; }
    else if (inner[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += inner[i];
  }
  cells.push(cur.trim());
  return cells;
}

export const joinRow = (cells) => `| ${cells.map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;

export function parseTables(text) {
  const lines = text.split('\n');
  const tables = [];
  let heading = null;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (h) { heading = h[1].trim(); continue; }
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const t = { heading, header: splitRow(lines[i]), headerLine: i, rows: [], start: i };
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) { t.rows.push({ line: j, cells: splitRow(lines[j]) }); j++; }
      t.end = j;
      tables.push(t);
      i = j - 1;
    }
  }
  return tables;
}

export function addRow(text, table, cells) {
  return edit(text, (L) => { L.splice(table.end, 0, joinRow(cells)); });
}
export function setRow(text, row, cells) {
  return edit(text, (L) => { L[row.line] = joinRow(cells); });
}
export function deleteRow(text, row) {
  return edit(text, (L) => { L.splice(row.line, 1); });
}

// rendered markdown task checkboxes appear in document order; map them to lines
export function taskLines(text) {
  const out = []; let inFence = false;
  text.split('\n').forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence;
    if (!inFence && /^\s*([-*+]|\d+[.)])\s+\[[ xX]\]\s/.test(l)) out.push(i);
  });
  return out;
}
