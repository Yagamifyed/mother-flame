// Three-way line merge. If the phone and the Mac both edited a file since the last
// sync, changes to different lines are combined; if both changed the same lines,
// both versions are kept (mine first), so nothing is ever silently lost.

function diffHunks(base, other) {
  // returns [{ start, end, lines }] — replace base[start:end] with lines
  let pre = 0;
  while (pre < base.length && pre < other.length && base[pre] === other[pre]) pre++;
  let suf = 0;
  while (suf < base.length - pre && suf < other.length - pre &&
         base[base.length - 1 - suf] === other[other.length - 1 - suf]) suf++;
  const a = base.slice(pre, base.length - suf);
  const b = other.slice(pre, other.length - suf);
  if (!a.length && !b.length) return [];
  if (a.length * b.length > 4e6) return [{ start: pre, end: pre + a.length, lines: b }];

  // LCS table on the trimmed middle
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const hunks = [];
  let i = 0, j = 0, cur = null;
  const open = () => { if (!cur) cur = { start: pre + i, end: pre + i, lines: [] }; };
  const close = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { close(); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { open(); cur.lines.push(b[j]); j++; }
    else { open(); i++; cur.end = pre + i; }
  }
  close();
  return hunks;
}

export function merge3(base, mine, theirs) {
  if (mine === theirs) return mine;
  if (base === mine) return theirs;
  if (base === theirs) return mine;
  const B = base.split('\n');
  const hm = diffHunks(B, mine.split('\n')).map((h) => ({ ...h, side: 'm' }));
  const ht = diffHunks(B, theirs.split('\n')).map((h) => ({ ...h, side: 't' }));
  const all = [...hm, ...ht].sort((x, y) => x.start - y.start || x.end - y.end);

  const out = [];
  let pos = 0, k = 0;
  while (k < all.length) {
    // gather an overlapping group
    let start = all[k].start, end = all[k].end;
    const group = [all[k++]];
    while (k < all.length && (all[k].start < end || (all[k].start === end && all[k].start === start))) {
      end = Math.max(end, all[k].end); group.push(all[k++]);
    }
    out.push(...B.slice(pos, start));
    const m = group.filter((h) => h.side === 'm');
    const t = group.filter((h) => h.side === 't');
    const render = (hs) => {
      // rebuild the region [start,end) from one side's hunks
      const r = []; let p = start;
      for (const h of hs) { r.push(...B.slice(p, h.start), ...h.lines); p = h.end; }
      r.push(...B.slice(p, end));
      return r;
    };
    if (!t.length) out.push(...render(m));
    else if (!m.length) out.push(...render(t));
    else {
      const rm = render(m), rt = render(t);
      if (rm.join('\n') === rt.join('\n')) out.push(...rm);
      else { out.push(...rm); for (const l of rt) if (!rm.includes(l)) out.push(l); }
    }
    pos = end;
  }
  out.push(...B.slice(pos));
  return out.join('\n');
}
