// "MO: call Markus" → { due: next Monday, text: "call Markus" }.
// Weekdays in English or German, two or three letters (or spelled out),
// plus today/heute, tomorrow/morgen, übermorgen, and dates like 7.11 or 2026-11-07.

const DAYS = [
  ['so', 'son', 'sonntag', 'su', 'sun', 'sunday'],
  ['mo', 'mon', 'montag', 'monday'],
  ['di', 'die', 'dienstag', 'tu', 'tue', 'tues', 'tuesday'],
  ['mi', 'mit', 'mittwoch', 'we', 'wed', 'wednesday'],
  ['do', 'don', 'donnerstag', 'th', 'thu', 'thur', 'thurs', 'thursday'],
  ['fr', 'fre', 'fri', 'freitag', 'friday'],
  ['sa', 'sam', 'samstag', 'sat', 'saturday'],
];
const REL = { heute: 0, today: 0, tod: 0, morgen: 1, tomorrow: 1, tom: 1, mor: 1, 'übermorgen': 2, uebermorgen: 2 };

export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const fromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

export function parseCapture(input, now = new Date()) {
  const m = input.match(/^\s*([A-Za-zÄÖÜäöü]+|\d{1,2}\.\d{1,2}\.?(?:\d{2,4})?|\d{4}-\d{2}-\d{2})\s*:\s*(.+)$/s);
  if (!m) return { text: input.trim(), due: null };
  const tok = m[1].toLowerCase(), rest = m[2].trim();
  if (tok in REL) return { text: rest, due: iso(addDays(now, REL[tok])) };
  const wd = DAYS.findIndex((names) => names.includes(tok));
  if (wd >= 0) {
    const diff = (wd - now.getDay() + 7) % 7; // same weekday = today
    return { text: rest, due: iso(addDays(now, diff)) };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) return { text: rest, due: tok };
  const dm = tok.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?$/);
  if (dm) {
    let y = dm[3] ? Number(dm[3].length === 2 ? '20' + dm[3] : dm[3]) : now.getFullYear();
    let d = new Date(y, Number(dm[2]) - 1, Number(dm[1]));
    if (!dm[3] && d < addDays(now, -1)) d = new Date(y + 1, d.getMonth(), d.getDate());
    return { text: rest, due: iso(d) };
  }
  return { text: input.trim(), due: null }; // "Polaroid: …" etc. stays as written
}

const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function dayLabel(isoDate, now = new Date()) {
  const d = fromIso(isoDate);
  const diff = Math.round((d - fromIso(iso(now))) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return WD_LONG[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}${d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : ''}`;
}
export const longDate = (d = new Date()) => `${WD_LONG[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
export const weekday = (isoDate) => WD_LONG[fromIso(isoDate).getDay()];
