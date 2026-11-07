// Markdown → HTML, with Obsidian-style [[links]] and ![[images]].
import { marked } from '../vendor/marked.esm.js?v=1794066801';
import DOMPurify from '../vendor/purify.es.mjs?v=1794066801';

marked.setOptions({ gfm: true, breaks: true });

export const AUDIO = /\.(m4a|mp4|aac|mp3|wav|webm|ogg)$/i;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// resolve a link target the way Obsidian does: by file name, anywhere in the vault
export function resolveLink(vault, target, exts = ['.md']) {
  const name = target.split('|')[0].split('#')[0].trim();
  if (!name) return null;
  const files = vault.list().map((f) => f.path);
  const lower = name.toLowerCase();
  for (const p of files) {
    const low = p.toLowerCase();
    if (low === lower || exts.some((e) => low === lower + e)) return p;
  }
  for (const p of files) {
    const base = p.split('/').pop().toLowerCase();
    if (base === lower || exts.some((e) => base === lower + e)) return p;
  }
  return null;
}

// headings get ids, so an index can jump to them: [[#Heading]] (Obsidian's syntax) or a [[Name]] that a heading carries
const norm = (s) => s.replace(/\[\[|\]\]/g, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const slug = (s) => 'h-' + norm(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

// `whole`: the full note when `text` is one block of it (so an index entry still finds its heading)
export function renderMarkdown(vault, text, whole = text) {
  let inFence = false;
  const named = new Map(); // [[Name]] in a heading → that heading
  for (const line of whole.split('\n')) {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) for (const [, t] of m[1].matchAll(/\[\[([^\]|#]+)\]\]/g)) named.set(norm(t), slug(m[1]));
  }
  const src = text.split('\n').map((line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    const heading = /^#{1,6}\s/.test(line);
    return line
      .replace(/!\[\[([^\]]+)\]\]/g, (_, t) => {
        const p = resolveLink(vault, t, []) || t.split('|')[0];
        // data-md keeps the Markdown as written, so editing the formatted text can give it back unchanged
        return AUDIO.test(p) ? `<audio controls preload="none" data-vault-src="${esc(p)}" data-md="${esc(_)}"></audio>` : `<img data-vault-src="${esc(p)}" alt="" data-md="${esc(_)}">`;
      })
      .replace(/!\[([^\]]*)\]\((?!https?:)([^)]+)\)/g, (_, alt, t) => `<img data-vault-src="${esc(decodeURI(t))}" alt="${esc(alt)}">`)
      .replace(/\[\[([^\]]+)\]\]/g, (raw, t) => {
        const [target, alias] = t.split('|');
        const md = `data-md="${esc(raw)}" data-label="${esc((alias || (target.startsWith('#') ? target.slice(1) : target)).trim())}"`;
        if (target.startsWith('#')) return `<a class="anchor" href="#~${slug(target.slice(1))}" ${md}>${esc((alias || target.slice(1)).trim())}</a>`;
        const p = resolveLink(vault, t);
        if (p) return `<a class="wikilink" href="#/f/${encodeURIComponent(p)}" ${md}>${esc((alias || target).trim())}</a>`;
        // not a file: keep the brackets as written; in an index, jump to the entry
        const to = !heading && named.get(norm(target));
        return to ? `<a class="anchor" href="#~${to}" data-md="${esc(raw)}" data-label="${esc(raw)}">${esc(raw)}</a>` : esc(raw);
      });
  }).join('\n');
  const html = tagLinks(DOMPurify.sanitize(marked.parse(src), { ADD_TAGS: ['audio'], ADD_ATTR: ['data-vault-src', 'target', 'controls', 'preload'] }));
  const box = document.createElement('div');
  box.innerHTML = html;
  for (const hd of box.querySelectorAll('h1, h2, h3, h4, h5, h6')) hd.id = slug(hd.textContent);
  return box.innerHTML;
}

// a click on an index entry scrolls to its heading (instead of changing the route)
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="#~"]');
  if (!a) return;
  e.preventDefault();
  document.getElementById(a.getAttribute('href').slice(2))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

export async function hydrateImages(vault, root) {
  for (const au of root.querySelectorAll('audio[data-vault-src]:not([src])')) {
    const url = await vault.assetURL(au.dataset.vaultSrc);
    if (url) au.src = url;
  }
  for (const img of root.querySelectorAll('img[data-vault-src]')) {
    const url = await vault.assetURL(img.dataset.vaultSrc);
    if (url) img.src = url; else img.replaceWith(Object.assign(document.createElement('span'), { className: 'missing', textContent: `[${img.dataset.vaultSrc}]` }));
  }
  for (const a of root.querySelectorAll('a[href^="http"]')) { a.target = '_blank'; a.rel = 'noopener'; }
}

// #tags: a word after # (#smo, #work) is a small label; tapping it shows everything with that tag
export const TAG = /(^|[\s(])#(\p{L}{2}[\p{L}\p{N}_-]*)/gu;  // two letters at least: #R1 (a Polaroid's number) is no tag
function tagLinks(html) {
  if (!html.includes('#')) return html;
  const t = document.createElement('template');
  t.innerHTML = html;
  const walk = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT), nodes = [];
  while (walk.nextNode()) if (!walk.currentNode.parentElement?.closest('a, code, pre')) nodes.push(walk.currentNode);
  for (const n of nodes) {
    if (!n.data.includes('#')) continue;
    const box = document.createElement('span');
    box.innerHTML = esc(n.data).replace(TAG, (_, pre, tag) => `${pre}<a class="tag" href="#/tag/${encodeURIComponent(tag.toLowerCase())}">#${tag}</a>`);
    n.replaceWith(...box.childNodes);
  }
  return t.innerHTML;
}

// inline-only markdown for item text (bold, italics, links, code)
export function renderInline(vault, text) {
  const html = marked.parseInline(text.replace(/!\[\[([^\]]+)\]\]/g, (_, t) => {
    const p = resolveLink(vault, t, []) || t.split('|')[0];
    return `<img class="thumb" data-vault-src="${esc(p)}" alt="">`;
  }).replace(/\[\[([^\]]+)\]\]/g, (_, t) => {
    const label = (t.split('|')[1] || t.split('|')[0]).trim();
    const p = resolveLink(vault, t);
    return p ? `<a class="wikilink" href="#/f/${encodeURIComponent(p)}">${esc(label)}</a>` : esc(label);
  }));
  return tagLinks(DOMPurify.sanitize(html, { ADD_ATTR: ['data-vault-src', 'target'] }));
}

// ---------- notes edited as formatted text: Markdown blocks in, Markdown blocks out ----------
// a note's body as its Markdown blocks (paragraphs, headings, lists, tables …); null if they don't add up to it exactly
export function noteBlocks(text) {
  const blocks = marked.lexer(text).map((t) => ({ type: t.type, raw: t.raw }));
  return blocks.map((b) => b.raw).join('') === text ? blocks : null;
}

// the Markdown for an edited block of formatted text (what the reader sees back to what the file holds)
export function blockToMarkdown(root) {
  const inline = (n) => {
    // a no-break space written on purpose stays; the ones the browser adds while typing (next to a space, at the end) don't
    if (n.nodeType === 3) return n.data.replace(/\u00a0(?= |$)|(?<= )\u00a0/g, ' ');
    if (n.nodeType !== 1) return '';
    const kids = () => [...n.childNodes].map(inline).join('');
    const tag = n.tagName.toLowerCase();
    if (n.dataset.md && (!n.dataset.label || n.textContent === n.dataset.label)) return n.dataset.md;
    if (tag === 'br') return '\n';
    if (tag === 'input') return '';
    if (tag === 'strong' || tag === 'b') return wrap(kids(), '**');
    if (tag === 'em' || tag === 'i') return wrap(kids(), '*');
    if (tag === 'del' || tag === 's') return wrap(kids(), '~~');
    if (tag === 'code') return '`' + n.textContent + '`';
    if (tag === 'img') return `![${n.alt || ''}](${n.getAttribute('src') || ''})`;
    if (tag === 'a' && n.classList.contains('tag')) return n.textContent;
    if (tag === 'a') { const href = n.getAttribute('href') || '', t = kids(); return !href || t === href ? (href || t) : `[${t}](${href})`; }
    if (tag === 'div' || tag === 'p') return kids() + '\n';
    return kids();
  };
  const wrap = (t, m) => { const x = t.match(/^(\s*)(.*?)(\s*)$/s); return x[2] ? `${x[1]}${m}${x[2]}${m}${x[3]}` : t; };
  const line = (n) => inline(n).replace(/\n+$/, '');
  // a paragraph that happens to start like a list or heading keeps reading as text
  const para = (n) => line(n).replace(/^([*+>#-]|\d+\.)(?=\s)/, '\\$1');
  const list = (el, depth) => [...el.children].filter((li) => li.tagName === 'LI').map((li, i) => {
    const box = li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]');
    const own = [...li.childNodes].filter((c) => !(c.nodeType === 1 && /^(UL|OL)$/.test(c.tagName)));
    // a line break inside an item is a note line under it, indented one step further
    const text = own.map(inline).join('').trim().replace(/[ \t]*\n\s*/g, '\n' + '\t'.repeat(depth + 1));
    const mark = el.tagName === 'OL' ? `${(+el.getAttribute('start') || 1) + i}.` : '-';
    const sub = [...li.children].filter((c) => /^(UL|OL)$/.test(c.tagName)).map((c) => list(c, depth + 1));
    return ['\t'.repeat(depth) + mark + ' ' + (box ? (box.checked ? '[x] ' : '[ ] ') : '') + text, ...sub].join('\n');
  }).join(el.querySelector(':scope > li > p') ? '\n\n' : '\n');  // a list with blank lines between items keeps them
  const block = (n) => {
    if (n.nodeType === 3) return n.data.trim() ? n.data : '';
    if (n.nodeType !== 1) return '';
    const tag = n.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return '#'.repeat(+tag[1]) + ' ' + line(n).replace(/\n/g, ' ');
    if (tag === 'ul' || tag === 'ol') return list(n, 0);
    if (tag === 'blockquote') return blocksOf(n).split('\n').map((l) => '> ' + l).join('\n');
    if (tag === 'pre') return '```\n' + n.textContent.replace(/\n$/, '') + '\n```';
    if (tag === 'hr') return '---';
    if (tag === 'div' && [...n.children].some((c) => /^(H[1-6]|UL|OL|P|DIV|BLOCKQUOTE|PRE)$/.test(c.tagName))) return blocksOf(n);
    return para(n);
  };
  // loose text and inline pieces next to each other belong to one paragraph
  const blocksOf = (el) => {
    const out = []; let run = '';
    for (const c of el.childNodes) {
      const isBlock = c.nodeType === 1 && /^(H[1-6]|UL|OL|P|DIV|BLOCKQUOTE|PRE|HR|TABLE)$/.test(c.tagName);
      if (!isBlock) { run += inline(c); continue; }
      if (run.trim()) out.push(run.replace(/\n+$/, '')); run = '';
      const b = block(c); if (b.trim()) out.push(b);
    }
    if (run.trim()) out.push(run.replace(/\n+$/, ''));
    return out.join('\n\n');
  };
  return blocksOf(root);
}
