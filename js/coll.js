// Collections edited by entries (Levin, 16 Nov 2026: "i need to be able to move things around in the above lists and add
// to them from the Mother Flame app"). A note is read as a row of chunks: entries (a list item with the lines under it,
// or a heading with its text and pictures) and other text (a group's heading such as "## London" or "**Smi**", an index,
// an intro). Every chunk keeps its exact text and the blank lines after it, so writing the chunks back gives the file
// byte for byte; an edit, a move or a new entry changes only what it must (plus the numbers and the index that follow
// from it).

const ITEM_HEAD = /^(- \[[ xX]\] |[-*] |\d+\. )/;
const isGroupRaw = (raw) => (/^#{1,6} /.test(raw) || /^\*\*[^*\n]+\*\*\s*$/.test(raw.split('\n')[0])) && !/index/i.test(raw.split('\n')[0]);

// ---------- reading ----------
export function load(text, cfg, bodyStart) {
  const head = text.slice(0, bodyStart), lines = text.slice(bodyStart).split('\n');
  const chunks = [];
  let cur = null, gap = 0, lead = null;
  const start = (kind, line) => {
    if (cur) cur.tail = '\n'.repeat(gap + 1); else lead = '\n'.repeat(gap);
    cur = { kind, raw: line, tail: '' }; chunks.push(cur); gap = 0;
  };
  const append = (line) => { cur.raw += '\n'.repeat(gap + 1) + line; gap = 0; };
  const L = cfg.level;
  for (const line of lines) {
    if (!line.trim()) { gap++; continue; }
    if (cfg.kind === 'sections') {
      const hm = line.match(/^(#{1,6}) /);
      if (hm && hm[1].length === L) start('entry', line);
      else if (hm && hm[1].length < L) start('other', line);
      else if (cur) append(line); else start('other', line);
    } else if (cfg.kind === 'labels') {
      // an entry starts at its label: "Artikel 3: Default Bubatz", "Höchster Zwirbel:"; headings and bold lines are groups
      const label = !/^[\s\-*#>|]/.test(line) && (/^Artikel \d+\s*:/.test(line) || (/:\s*$/.test(line) && line.length < 160));
      if (label) start('entry', line);
      else if (/^#{1,6} /.test(line) || /^\*\*[^*\n]+\*\*\s*$/.test(line)) start('other', line);
      else if (cur) append(line); else start('other', line);
    } else {
      const indented = /^\s/.test(line);
      if (!indented && (cfg.headStart || ITEM_HEAD).test(line)) start('entry', line);
      else if (indented && cur) append(line);
      else if (cur?.kind === 'other' && gap === 0 && !/^#{1,6} /.test(line)) append(line);
      else start('other', line);
    }
  }
  if (cur) cur.tail = '\n'.repeat(gap); else lead = '\n'.repeat(gap);
  return { head, lead: lead ?? '', chunks, cfg };
}
export const dump = (doc) => doc.head + doc.lead + doc.chunks.map((c) => c.raw + c.tail).join('');

// ---------- one entry's fields ----------
export function fields(raw, cfg) {
  if (cfg.kind === 'labels') {
    const ls = raw.split('\n'), gap = ls.length > 1 && ls[1] === '';
    const e = { title: ls[0], gap, text: ls.slice(gap ? 2 : 1).join('\n'), pics: [] };
    e.ok = write(e, cfg) === raw;
    return e;
  }
  if (cfg.kind === 'sections') {
    const ls = raw.split('\n');
    const hm = ls[0].match(new RegExp(`^#{${cfg.level}} (?:(\\d+)\\. )?(.*)$`));
    const e = { num: hm[1] != null ? +hm[1] : null, title: hm[2], gap: ls.length > 1 && ls[1] === '', text: '', pics: [] };
    if (ls.length > 1) {
      const paras = ls.slice(e.gap ? 2 : 1).join('\n').split('\n\n');
      while (paras.length && /^!\[\[[^\]\n]+\]\]$/.test(paras.at(-1))) e.pics.unshift(paras.pop().slice(3, -2));
      e.text = paras.join('\n\n');
    }
    e.ok = write(e, cfg) === raw;
    return e;
  }
  const ls = raw.split('\n');
  const m = ls[0].match(cfg.headRe || /^(- \[[ xX]\] |[-*] |\d+\. )(.*?)((?: {2,})?)$/);
  const e = { lead: m[1], text: m[2], hb: m[3], lines: ls.slice(1).map((l) => {
    const c = l.match(/^(\s+(?:- \[[ xX]\] |[-*] |\d+[a-z]?[.)] )?)(.*?)((?: {2,})?)$/);
    return c && { lead: c[1], text: c[2], hb: c[3] };
  }) };
  e.ok = e.lines.every(Boolean) && write(e, cfg) === raw;
  return e;
}
export function write(e, cfg) {
  if (cfg.kind === 'labels') return e.text !== '' ? e.title + '\n' + (e.gap ? '\n' : '') + e.text : e.title;
  if (cfg.kind === 'sections') {
    const head = `${'#'.repeat(cfg.level)} ${e.num != null ? e.num + '. ' : ''}${e.title}`;
    const body = [e.text, ...e.pics.map((p) => `![[${p}]]`)].filter((x) => x !== '');
    return body.length ? head + '\n' + (e.gap ? '\n' : '') + body.join('\n\n') : head;
  }
  return [e.lead + e.text + (e.hb || ''), ...e.lines.map((c) => c.lead + c.text + (c.hb || ''))].join('\n');
}
// the label of an entry (for the Index and the sheet)
export const titleOf = (raw, cfg) => {
  const f = fields(raw, cfg);
  if (cfg.who) return (f.lead || '').replace(/^\*\*|:\*\*\s*$/g, '').trim();
  return (cfg.kind === 'items' ? f.text.replace(cfg.bucket ? /^\d+\\\. / : /(?!)/, '') : f.title).replace(/:\s*$/, '').replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/\*\*|__/g, '').trim();
};

// ---------- the parts of a note ----------
export const entries = (doc) => doc.chunks.filter((c) => c.kind === 'entry');
export const isGroup = (c) => c.kind === 'other' && isGroupRaw(c.raw);
export const groupLabel = (c) => c.raw.split('\n')[0].replace(/^#+\s*|\*\*/g, '').trim();
// the group an entry sits in (its heading chunk), or null
export function groupOf(doc, chunk) {
  let g = null;
  for (const c of doc.chunks) { if (c === chunk) return g; if (isGroup(c)) g = c; }
  return g;
}
// a run: entries one after another; it starts after a chunk of other text (its key) or at the top
function runs(doc) {
  const out = []; let key = 'top', run = null;
  for (const c of doc.chunks) {
    if (c.kind === 'other') { key = c; run = null; continue; }
    if (!run) { run = { key, list: [] }; out.push(run); }
    run.list.push(c);
  }
  return out;
}
const runKey = (doc, chunk) => runs(doc).find((r) => r.list.includes(chunk))?.key ?? null;

// ---------- changes ----------
// op: { type: 'edit', raw, next } | { type: 'delete', raw } | { type: 'add', next, group } | { type: 'move', raw, to, group }
// It returns the new text and the entry's text as it now stands (to find it again), or null if the entry is not there.
export function apply(text, cfg, bodyStart, op) {
  const doc = load(text, cfg, bodyStart);
  const before = new Map(runs(doc).map((r) => [r.key, { sep: mode(r.list.slice(0, -1).map((c) => c.tail)), end: r.list.at(-1).tail }]));
  const touched = new Set();
  let at = -1, target = null;
  if (op.raw != null) { at = doc.chunks.findIndex((c) => c.kind === 'entry' && c.raw === op.raw); if (at < 0) return null; target = doc.chunks[at]; }
  if (op.type === 'edit') target.raw = op.next;
  else if (op.type === 'delete') { touched.add(runKey(doc, target)); doc.chunks.splice(at, 1); target = null; }
  else if (op.type === 'add') {
    target = { kind: 'entry', raw: op.next, tail: '' };
    let pos;
    const g = op.group != null ? doc.chunks[op.group] : null;
    if (cfg.top) {
      const first = entries(doc)[0];
      pos = first ? doc.chunks.indexOf(first) : doc.chunks.length;
    } else if (cfg.alpha) {
      const t = titleOf(op.next, cfg).toLowerCase();
      const later = entries(doc).find((c) => titleOf(c.raw, cfg).toLowerCase().localeCompare(t) > 0);
      pos = later ? doc.chunks.indexOf(later) : endOfRun(doc, doc.chunks.indexOf(entries(doc).at(-1) ?? null));
    } else if (g) {
      let j = doc.chunks.indexOf(g) + 1;
      while (doc.chunks[j]?.kind === 'entry') j++;
      pos = j;
    } else {
      const last = entries(doc).at(-1);
      pos = last ? doc.chunks.indexOf(last) + 1 : doc.chunks.length;
    }
    if (pos > 0 && doc.chunks[pos - 1].kind === 'other' && !doc.chunks[pos - 1].tail.startsWith('\n\n')) doc.chunks[pos - 1].tail = '\n\n';
    doc.chunks.splice(pos, 0, target);
    touched.add(runKey(doc, target));
  } else if (op.type === 'move') {
    touched.add(runKey(doc, target));
    const C = doc.chunks, prev = C[at - 1], next = C[at + 1];
    let pos = null;  // where it goes, counted with it taken out
    if (op.to === 'up') {
      if (prev?.kind === 'entry') pos = at - 1;
      else if (prev && isGroup(prev) && at - 2 >= 0 && (C[at - 2].kind === 'entry' || isGroup(C[at - 2]))) pos = at - 1;
    } else if (op.to === 'down') {
      if (next?.kind === 'entry') pos = at + 1;
      else if (next && isGroup(next)) pos = at + 1;
    } else if (op.to === 'top') {
      let j = at; while (C[j - 1]?.kind === 'entry') j--; pos = j;
    } else if (op.to === 'end') {
      let j = at; while (C[j + 1]?.kind === 'entry') j++; pos = j;
    } else if (op.to === 'group') {
      const g = C[op.group];
      if (g && g !== groupOf(doc, target)) {
        C.splice(at, 1);
        let j = C.indexOf(g) + 1; while (C[j]?.kind === 'entry') j++;
        C.splice(j, 0, target); pos = 'done';
      }
    }
    if (pos != null && pos !== 'done') { C.splice(at, 1); C.splice(pos, 0, target); }
    touched.add(runKey(doc, target));
  }
  // the blank lines between entries, as the run had them; the last one of a run keeps what came after the run
  const rs = runs(doc);
  for (const r of rs) {
    if (!touched.has(r.key)) continue;
    const lastRun = r === rs.at(-1) && r.list.at(-1) === doc.chunks.at(-1);
    const b = before.get(r.key) || {};
    const sep = b.sep ?? cfg.sep ?? (cfg.kind === 'sections' ? '\n\n' : '\n');
    r.list.forEach((c, i) => { c.tail = i < r.list.length - 1 ? sep : b.end || (lastRun ? '\n' : '\n\n'); });
  }
  renumber(doc);
  reindex(doc);
  let out = dump(doc);
  if (!out.endsWith('\n')) out += '\n';
  return { text: out, raw: target?.raw ?? null };
}
const mode = (xs) => { const n = new Map(); xs.forEach((x) => n.set(x, (n.get(x) || 0) + 1)); return [...n].sort((a, b) => b[1] - a[1])[0]?.[0]; };
function endOfRun(doc, i) { let j = i; while (doc.chunks[j + 1]?.kind === 'entry') j++; return j + 1; }

// numbers that run through the note (1., 2., … or ### 1., ### 2., …) follow the order; 3a., 3b. follow their entry
function renumber(doc) {
  const { cfg } = doc;
  // the Bucket List: "- 22\. …" newest on top, its variants "22\*\." under it
  if (cfg.bucket) {
    const list = entries(doc).filter((c) => /^- \d+\\\. /.test(c.raw));
    list.forEach((c, i) => {
      const n = list.length - i;
      c.raw = c.raw.split('\n').map((l, j) => (j === 0 ? l.replace(/^- \d+(?=\\\. )/, `- ${n}`) : l.replace(/^(\s+- )\d+(?=\\)/, `$1${n}`))).join('\n');
    });
    return;
  }
  if (!cfg.numbered) return;
  // (from the lowest number there is: an entry moved to the top takes 1, not its old number)
  const re = cfg.kind === 'sections' ? new RegExp(`^#{${cfg.level}} (\\d+)\\. `) : /^(\d+)\. /;
  const nums = entries(doc).map((c) => c.raw.match(re)?.[1]).filter(Boolean).map(Number);
  let n = nums.length ? Math.min(...nums) - 1 : null;
  for (const c of entries(doc)) {
    if (cfg.kind === 'sections') {
      const m = c.raw.match(new RegExp(`^(#{${cfg.level}}) (\\d+)\\. `));
      if (!m) continue;
      n = n == null ? +m[2] : n + 1;
      c.raw = c.raw.replace(m[0], `${m[1]} ${n}. `);
    } else {
      const m = c.raw.match(/^(\d+)\. /);
      if (!m) continue;
      n = n == null ? +m[1] : n + 1;
      let k = 0;
      c.raw = c.raw.split('\n').map((l, i) => (i === 0 ? l.replace(/^\d+\. /, `${n}. `)
        : l.replace(/^(\s+)\d+[a-z]\. /, (_, ws) => `${ws}${n}${String.fromCharCode(97 + k++)}. `))).join('\n');
    }
  }
}
// a note's own index ("1. [[#1. Title|Title]]" or "1. [[Name]]") lists the entries as they now are
function reindex(doc) {
  const { cfg } = doc;
  if (cfg.kind !== 'sections') return;
  const box = doc.chunks.find((c) => c.kind === 'other' && /^\d+\. \[\[[^\n]*\]\]\s*$/m.test(c.raw) && doc.chunks.indexOf(c) < doc.chunks.indexOf(entries(doc)[0] ?? c));
  if (!box) return;
  const anchor = /\[\[#/.test(box.raw);
  const lines = entries(doc).map((c, i) => {
    const f = fields(c.raw, cfg), num = f.num ?? i + 1;
    if (!anchor) return `${num}. ${f.title}`;
    const clean = f.title.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
    return `${num}. [[#${num}. ${clean}|${clean}]]`;
  });
  const ls = box.raw.split('\n'), first = ls.findIndex((l) => /^\d+\. \[\[/.test(l));
  let last = first; while (last + 1 < ls.length && /^\d+\. \[\[/.test(ls[last + 1])) last++;
  ls.splice(first, last - first + 1, ...lines);
  box.raw = ls.join('\n');
}
