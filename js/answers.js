// Answers to the Open Questions, spoken or typed: the text split onto the questions it answers.
// By number first ("Q11", "question eleven", "Frage elf", "Q11 and 12"), otherwise by the words a part
// shares with a question. Pure functions: text in, parts out; the Lab shows them for confirmation.

const EN = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const DE = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf',
  'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
const DE_TENS = { zwanzig: 20, dreißig: 30, dreissig: 30, vierzig: 40, fünfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90 };
const DE_UNIT = ['ein', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'];

const alt = (words) => [...words].sort((a, b) => b.length - a.length).join('|');
const NUM = `\\d{1,3}|(?:${alt(Object.keys(EN_TENS))})(?:[\\s-]?(?:${alt(EN.slice(1, 10))}))?|(?:${alt(DE_UNIT)})und(?:${alt(Object.keys(DE_TENS))})|${alt([...EN, ...DE, ...Object.keys(DE_TENS), 'eine', 'ein'])}`;
// "Q11", "Q 11", "queue eleven" (how Whisper may hear it), "question 11", "question number 11", "Frage Nummer elf"
const PREFIX = `(?:queue|questions?|fragen?|cue|kyu|kuh|q)\\.?(?:[\\s-]*(?:number|nummer|nr\\.?|no\\.))?`;
const EDGE_L = '(?<![\\p{L}\\d])', EDGE_R = '(?![\\p{L}\\d])';
const ONE = `${PREFIX}[\\s.:#-]*(?:${NUM})${EDGE_R}`;
const MARKER = new RegExp(`${EDGE_L}${ONE}(?:\\s*(?:,|&|and|und|plus|sowie)\\s*(?:${PREFIX}[\\s.:#-]*)?(?:${NUM})${EDGE_R})*`, 'giu');
const NUM_IN = new RegExp(`${EDGE_L}(?:${NUM})${EDGE_R}`, 'giu');
const PREFIX_ALL = new RegExp(PREFIX, 'giu');

export function numberValue(word) {
  const w = word.toLowerCase().replace(/[\s-]+/g, '');
  if (/^\d+$/.test(w)) return Number(w);
  if (EN.includes(w)) return EN.indexOf(w);
  if (DE.includes(w)) return DE.indexOf(w);
  if (w === 'ein' || w === 'eine') return 1;
  if (w in DE_TENS) return DE_TENS[w];
  for (const [t, v] of Object.entries(EN_TENS)) {
    if (!w.startsWith(t)) continue;
    const u = EN.indexOf(w.slice(t.length));
    return w === t ? v : u > 0 && u < 10 ? v + u : NaN;
  }
  const m = w.match(/^(\p{L}+?)und(\p{L}+)$/u);
  if (m && DE_UNIT.includes(m[1]) && m[2] in DE_TENS) return DE_UNIT.indexOf(m[1]) + 1 + DE_TENS[m[2]];
  return NaN;
}

// ---------- words ----------
const STOP = new Set(`the a an and or but if of to in on at for with by from is are was were be been being it its this that these those
there their them they you your yours i me my mine we our us he she his her as so not no yes yeah okay ok do does did done can could would
should will shall may might must have has had what which who whom whose when where why how all any some more most other into over than then
too very just also only about want need like think know good fine sure well please thanks thank one two three let lets get got make made
answer answers question questions here now next first second third last right really maybe still
der die das ein eine einen einem einer eines und oder aber wenn von vom zu zum zur im in am an auf für mit bei aus ist sind war waren sein
es dies diese dieser dieses da dass sie ihr ihre ich mich mir mein meine wir uns er nicht nein ja doch auch nur noch schon so wie was wer
wann wo warum welche welcher welches den dem des man kann soll sollte würde werden wird hat haben hatte gut okay bitte danke frage fragen
antwort hier jetzt dann erste zweite letzte also halt mal eben gerne genau`.split(/\s+/));
const stem = (w) => (w.length > 5 ? w.replace(/(ings?|ed|es|en|er|s|e|n)$/, '') : w);
export const words = (s) => (s.toLowerCase().match(/[\p{L}\d]+/gu) || []).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);

// trim connecting words left at the edges when the text is cut at a marker: "… and as for" | Q12 | ": the answer is yes"
const EDGE_WORDS = new Set('for to on about regarding re and as then now next also with so zu für bei und dann jetzt noch zur zum the die der das okay ok'.split(' '));
function tidy(s) {
  let t = s.replace(/^[\s,.:;!?–—-]+/, '').replace(/^(?:(?:my|the)\s+)?(?:answer|antwort)(?:\s+(?:is|ist))?[\s,.:;–—-]*/i, '');
  for (;;) {
    const m = t.match(/(?:^|[\s,;:–—-])(\p{L}+)[\s,;:–—-]*$/u); // a word ending a sentence stays
    if (!m || !EDGE_WORDS.has(m[1].toLowerCase())) break;
    t = t.slice(0, m.index).trimEnd();
  }
  t = t.replace(/[\s,;:–—-]+$/, '').trim();
  return t && t[0].toUpperCase() + t.slice(1);
}

// ---------- matching ----------
// questions: [{ id: 'Q11', text, why, done }]. Returns [{ qid | null, text, how }]: how = 'number', 'content',
// 'only open question', or null when nothing matched (the Lab leaves those out unless they are assigned).
export function matchAnswers(text, questions) {
  const ids = new Map(questions.map((q) => [Number(q.id.slice(1)), q.id]));
  const open = questions.filter((q) => !q.done);
  const cuts = [];
  for (const m of text.matchAll(MARKER)) {
    const qids = [...m[0].replace(PREFIX_ALL, ' ').matchAll(NUM_IN)].map((n) => ids.get(numberValue(n[0]))).filter(Boolean);
    if (qids.length) cuts.push({ at: m.index, end: m.index + m[0].length, qids: [...new Set(qids)] });
  }
  const parts = [];
  const lead = text.slice(0, cuts[0]?.at ?? text.length);
  if (lead.trim()) parts.push(...byContent(lead, open, !cuts.length));
  let waiting = []; // "Q11 and Q12: yes" / "Q11. Q12. Yes to both": empty segments share the next one's words
  cuts.forEach((c, i) => {
    const t = tidy(text.slice(c.end, cuts[i + 1]?.at ?? text.length));
    waiting.push(...c.qids);
    if (!t && i < cuts.length - 1) return;
    for (const qid of [...new Set(waiting)]) parts.push({ qid, text: t, how: 'number' });
    waiting = [];
  });
  return parts.filter((p) => p.text);
}

function byContent(text, open, alone) {
  const sentences = text.split(/(?<=[.!?])\s+/).map(tidy).filter(Boolean);
  const bags = open.map((q) => {
    const w = new Map();
    for (const x of words(q.why || '')) w.set(x, 0.5);
    for (const x of words(q.text)) w.set(x, 1);
    return w;
  });
  const df = new Map();
  for (const b of bags) for (const x of b.keys()) df.set(x, (df.get(x) || 0) + 1);
  const idf = (x) => Math.log(1 + open.length / df.get(x));
  let prev = null;
  const out = sentences.map((s) => {
    const mine = new Set(words(s));
    const scores = bags.map((b) => [...mine].reduce((n, x) => n + (b.get(x) || 0) * (b.has(x) ? idf(x) : 0), 0));
    const order = scores.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    const [best, second] = [order[0], order[1]];
    let qid = null, how = null;
    if (best && best[0] >= 0.6 && (!second || best[0] > second[0] * 1.25)) { qid = open[best[1]].id; how = 'content'; }
    else if (prev) ({ qid, how } = prev); // no clue of its own: it goes on about the same question
    if (qid) prev = { qid, how };
    return { qid, text: s, how };
  });
  // with a single open question, everything said answers it
  if (open.length === 1 && alone) for (const p of out) if (!p.qid) Object.assign(p, { qid: open[0].id, how: 'only open question' });
  // neighbours about the same question become one answer
  return out.reduce((acc, p) => {
    const last = acc.at(-1);
    if (last && last.qid === p.qid) last.text += ' ' + p.text; else acc.push({ ...p });
    return acc;
  }, []);
}

// ---------- the Open Questions file ----------
const QID = /\s*\((Q\d+)\)\s*$/;
// the list's items as questions (parseList's items in, so it stays one parser)
export function questionsOf(items) {
  return items.filter((it) => QID.test(it.text)).map((it) => ({
    id: it.text.match(QID)[1], text: it.text.replace(QID, ''), done: it.checked,
    why: (it.notes.find((n) => n.text.startsWith('Why:'))?.text || '').slice(4).trim(), item: it,
  }));
}

// the line under the question, as Stella's parser reads it (any indented line that isn't Why: or From:)
export function answerLine(text, { voice = false, date = new Date() } = {}) {
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `Your answer (${voice ? 'voice note, ' : ''}${day}): ${text.replace(/\s+/g, ' ').trim()}`;
}
