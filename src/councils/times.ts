import opening_hours from 'opening_hours';

/**
 * Translate council "times of operation" text into OSM opening_hours syntax,
 * which the rules engine evaluates. Handles the forms UK councils use, e.g.
 *   "at any time"                                   → "24/7"
 *   "mon-fri 08:30-18:30, sat 08:30-13:30"          → "Mo-Fr 08:30-18:30, Sa 08:30-13:30"
 *   "mon-fri 08:00-09:00 & 15:00-17:00"             → "Mo-Fr 08:00-09:00,15:00-17:00"
 *   "Mon-Wed, Fri & Sun at any time and Thur & Sat 18:00-07:00"
 * Returns null when the text can't be read reliably.
 */
const DAY: Record<string, string> = {
  mon: 'Mo', monday: 'Mo',
  tue: 'Tu', tues: 'Tu', tuesday: 'Tu',
  wed: 'We', weds: 'We', wednesday: 'We',
  thu: 'Th', thur: 'Th', thurs: 'Th', thursday: 'Th',
  fri: 'Fr', friday: 'Fr',
  sat: 'Sa', saturday: 'Sa',
  sun: 'Su', sunday: 'Su',
};
const DAY_RE = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat|sun)';
const TOKEN = new RegExp(
  `${DAY_RE}(?:\\s*-\\s*${DAY_RE})?|(\\d{1,2})[:.](\\d{2})\\s*-\\s*(\\d{1,2})[:.](\\d{2})|at any time|24 ?hours?`,
  'g',
);

const pad = (h: string) => h.padStart(2, '0');

export function toOpeningHours(text: string | undefined | null): string | null {
  if (!text) return null;
  const s = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (s === 'n/a' || s === '') return null;

  interface Rule {
    days: string[];
    times: string[];
  }
  const rules: Rule[] = [];
  let pendingDays: string[] = [];
  let consumed = 0;

  for (const m of s.matchAll(TOKEN)) {
    consumed += m[0].length;
    if (m[1]) {
      const d = DAY[m[1]]!;
      const day = m[2] ? `${d}-${DAY[m[2]]!}` : d;
      pendingDays.push(day);
      continue;
    }
    let time: string;
    if (m[3]) {
      const end = `${pad(m[5]!)}:${m[6]}`;
      time = `${pad(m[3])}:${m[4]}-${end === '00:00' ? '24:00' : end}`;
    } else {
      time = '00:00-24:00';
    }
    if (pendingDays.length) {
      rules.push({ days: pendingDays, times: [time] });
      pendingDays = [];
    } else if (rules.length) {
      rules[rules.length - 1]!.times.push(time); // "mon-fri 08:00-09:00 & 15:00-17:00"
    } else {
      rules.push({ days: ['Mo-Su'], times: [time] }); // times with no days: every day
    }
  }
  // Days left without times, or lots of unrecognised text: don't guess.
  if (!rules.length || pendingDays.length) return null;
  const leftover = s.replace(TOKEN, '').replace(/\b(and|&)\b|[,&;]/g, '').trim();
  if (leftover.length > 3 || consumed === 0) return null;

  const oh = rules
    .map((r) => {
      const allDay = r.times.length === 1 && r.times[0] === '00:00-24:00';
      if (allDay && r.days.length === 1 && r.days[0] === 'Mo-Su') return '24/7';
      return `${r.days.join(',')} ${[...new Set(r.times)].join(',')}`;
    })
    .join(', ');

  try {
    new opening_hours(oh, null, 0);
  } catch {
    return null;
  }
  return oh;
}
