import { resolve, timeMatches, type EvalContext } from './conditional';
import { formatMinutes, parseDurationMinutes } from './duration';
import { normalizeLegacy } from './legacy';

export type Tags = Record<string, string>;
export type Side = 'left' | 'right';

export type Status =
  | 'free' // legal and free for the whole requested stay
  | 'time_limited' // free, but max stay is shorter than requested
  | 'paid' // legal but a fee applies at some point during the stay
  | 'permit' // residents / permit / customers only at some point during the stay
  | 'restricted' // no parking / no stopping / loading etc. at some point during the stay
  | 'no_parking' // no parking here at all
  | 'unknown'; // not enough mapped data

export type Confidence = 'high' | 'medium' | 'low';

export interface Assessment {
  status: Status;
  confidence: Confidence;
  reasons: string[];
  /** Minutes from arrival that the spot stays legal and free (capped at 24h). Ignores max stay. */
  freeForMinutes?: number;
  maxStayMinutes?: number;
  needsDisc: boolean;
  orientation?: string;
}

export interface StayWindow {
  start: Date;
  minutes: number;
}

type Lookup = (key: string) => string | undefined;

const BLOCKING = new Set([
  'no_parking',
  'no_stopping',
  'no_standing',
  'loading_only',
  'charging_only',
  'disabled_only',
  'taxi_only',
  'bus_only',
  'delivery_only',
]);

/** Access values meaning the general public may NOT park. */
const RESTRICTED_ACCESS = new Set([
  'private',
  'no',
  'residents',
  'permit',
  'permissive_residents',
  'customers',
  'delivery',
  'disabled',
  'employees',
  'destination',
]);

const NO_PARKING_KIND = new Set(['no', 'separate', 'no_parking', 'no_stopping', 'fire_lane']);

const SAMPLE_STEP_MIN = 5;
const SCAN_STEP_MIN = 15;
const SCAN_HORIZON_MIN = 24 * 60;

interface Instant {
  blocked?: string;
  blockedVia?: string;
  permit?: string;
  permitVia?: string;
  paid: boolean;
  paidVia?: string;
  closed: boolean;
  maxstay?: number;
  uncertain: boolean;
}

function instant(lookup: Lookup, t: Date, ctx: EvalContext, hasOpeningHours: boolean): Instant {
  const r = resolve(lookup('restriction'), lookup('restriction:conditional'), t, ctx);
  const a = resolve(lookup('access'), lookup('access:conditional'), t, ctx);
  const f = resolve(lookup('fee'), lookup('fee:conditional'), t, ctx);
  const m = resolve(lookup('maxstay'), lookup('maxstay:conditional'), t, ctx);

  let closed = false;
  let ohUncertain = false;
  if (hasOpeningHours) {
    const open = timeMatches(lookup('opening_hours') ?? '', t);
    if (open === false) closed = true;
    if (open === 'unknown') ohUncertain = true;
  }

  const out: Instant = {
    paid: f.value === 'yes',
    closed,
    uncertain: r.uncertain || a.uncertain || f.uncertain || m.uncertain || ohUncertain,
  };
  if (r.value && BLOCKING.has(r.value)) {
    out.blocked = r.value;
    out.blockedVia = r.via;
  }
  if (a.value && RESTRICTED_ACCESS.has(a.value)) {
    out.permit = a.value;
    out.permitVia = a.via;
  }
  if (out.paid) out.paidVia = f.via;
  if (m.value) {
    const mins = parseDurationMinutes(m.value);
    if (mins === null) out.uncertain = true;
    else if (Number.isFinite(mins)) out.maxstay = mins;
  }
  return out;
}

function isFreeAndLegal(i: Instant): boolean {
  return !i.blocked && !i.permit && !i.paid && !i.closed;
}

function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60_000);
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}

function when(via: string | undefined): string {
  return via ? ` (${via})` : '';
}

/** Core evaluation shared by on-street sides and car parks. */
function assess(lookup: Lookup, window: StayWindow, opts: { hasOpeningHours: boolean }): Omit<Assessment, 'orientation'> {
  const ctx: EvalContext = { stayMinutes: window.minutes };
  const reasons: string[] = [];
  let uncertain = false;

  let blocked: Instant | undefined;
  let permit: Instant | undefined;
  let paid: Instant | undefined;
  let closed = false;
  let maxstayMin: number | undefined;
  let minutesUnderMaxstay = 0;

  const samples = Math.max(1, Math.ceil(window.minutes / SAMPLE_STEP_MIN));
  for (let k = 0; k < samples; k++) {
    const t = addMinutes(window.start, k * SAMPLE_STEP_MIN);
    const i = instant(lookup, t, ctx, opts.hasOpeningHours);
    uncertain ||= i.uncertain;
    if (i.blocked && !blocked) blocked = i;
    if (i.permit && !permit) permit = i;
    if (i.paid && !paid) paid = i;
    if (i.closed) closed = true;
    if (i.maxstay !== undefined) {
      maxstayMin = Math.min(maxstayMin ?? Infinity, i.maxstay);
      minutesUnderMaxstay += Math.min(SAMPLE_STEP_MIN, window.minutes - k * SAMPLE_STEP_MIN);
    }
  }

  // How long is it legal & free from arrival?
  let freeForMinutes = 0;
  for (let m = 0; m < SCAN_HORIZON_MIN; m += SCAN_STEP_MIN) {
    const i = instant(lookup, addMinutes(window.start, m), ctx, opts.hasOpeningHours);
    if (!isFreeAndLegal(i)) break;
    freeForMinutes = m + SCAN_STEP_MIN;
  }

  const needsDisc = lookup('authentication:disc') === 'yes';
  const feeKnown = lookup('fee') !== undefined || lookup('fee:conditional') !== undefined;

  let status: Status;
  if (blocked) {
    status = 'restricted';
    reasons.push(`${humanize(blocked.blocked!)}${when(blocked.blockedVia)}`);
  } else if (closed) {
    status = 'restricted';
    reasons.push(`Closed during your stay (${lookup('opening_hours')})`);
  } else if (permit) {
    status = 'permit';
    const zone = lookup('zone');
    reasons.push(`Access: ${humanize(permit.permit!)}${zone ? `, zone ${zone}` : ''}${when(permit.permitVia)}`);
  } else if (paid) {
    status = 'paid';
    reasons.push(`Fee applies${when(paid.paidVia)}`);
  } else if (maxstayMin !== undefined && minutesUnderMaxstay > maxstayMin) {
    status = 'time_limited';
    reasons.push(`Max stay ${formatMinutes(maxstayMin)}`);
  } else {
    status = 'free';
    if (maxstayMin !== undefined) reasons.push(`Max stay ${formatMinutes(maxstayMin)} (fits your stay)`);
  }

  if (!feeKnown && (status === 'free' || status === 'time_limited')) {
    reasons.push('No fee mapped: assumed free, check signs');
  }
  if (needsDisc) reasons.push('Parking disc required');
  if (uncertain) reasons.push('Some rules could not be evaluated automatically');

  let confidence: Confidence = 'high';
  if (!feeKnown) confidence = 'medium';
  if (uncertain) confidence = 'low';

  return {
    status,
    confidence,
    reasons,
    freeForMinutes,
    maxStayMinutes: maxstayMin,
    needsDisc,
  };
}

/** Assess one side of a street way tagged with the OSM `parking:*` street-parking scheme. */
export function assessStreetSide(rawTags: Tags, side: Side, window: StayWindow): Assessment {
  const tags = normalizeLegacy(rawTags);
  const lookup: Lookup = (key) => tags[`parking:${side}:${key}`] ?? tags[`parking:both:${key}`];
  const kind = tags[`parking:${side}`] ?? tags['parking:both'];

  if (kind === undefined) {
    return { status: 'unknown', confidence: 'low', reasons: ['No parking data mapped for this side'], needsDisc: false };
  }
  if (NO_PARKING_KIND.has(kind)) {
    const r = lookup('restriction');
    return {
      status: 'no_parking',
      confidence: 'high',
      reasons: [kind === 'separate' ? 'Mapped as a separate parking area' : `No parking${r ? ` (${humanize(r)})` : ''}`],
      needsDisc: false,
    };
  }
  return { ...assess(lookup, window, { hasOpeningHours: false }), orientation: lookup('orientation') };
}

/** Assess an off-street car park (amenity=parking). */
export function assessCarPark(tags: Tags, window: StayWindow): Assessment {
  const lookup: Lookup = (key) => tags[key];
  return assess(lookup, window, { hasOpeningHours: tags['opening_hours'] !== undefined });
}
