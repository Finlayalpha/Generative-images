/**
 * Parse an OSM duration (as used by `maxstay`, `stay > ...`) into minutes.
 * Accepts e.g. "2 hours", "2 h", "90 min", "30 minutes", "1 day", "1:30", "PT2H".
 * Returns Infinity for "no"/"unlimited", null when unparseable.
 */
export function parseDurationMinutes(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s === 'no' || s === 'none' || s === 'unlimited') return Infinity;

  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);

  const iso = /^pt(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?$/.exec(s);
  if (iso && (iso[1] || iso[2])) return Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0);

  const m = /^(\d+(?:[.,]\d+)?)\s*([a-z]+)$/.exec(s);
  if (!m) return null;
  const n = Number((m[1] ?? '').replace(',', '.'));
  const unit = m[2] ?? '';
  if (/^(m|min|mins|minute|minutes)$/.test(unit)) return n;
  if (/^(h|hr|hrs|hour|hours)$/.test(unit)) return n * 60;
  if (/^(d|day|days)$/.test(unit)) return n * 1440;
  if (/^(w|week|weeks)$/.test(unit)) return n * 10080;
  return null;
}

export function formatMinutes(min: number): string {
  if (!Number.isFinite(min)) return 'unlimited';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h >= 48 && m === 0 && h % 24 === 0) return `${h / 24} days`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
