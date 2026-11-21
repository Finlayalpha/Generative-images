import type { Tags } from './rules/engine';

/** Body dimensions in metres (width excludes mirrors). */
export interface Vehicle {
  length: number;
  width: number;
  height: number;
}

export interface VehiclePreset extends Vehicle {
  id: string;
  label: string;
}

/** Typical UK body sizes. Users can edit any value. */
export const PRESETS: VehiclePreset[] = [
  { id: 'city', label: 'City car', length: 3.7, width: 1.65, height: 1.5 },
  { id: 'hatch', label: 'Hatchback', length: 4.3, width: 1.8, height: 1.5 },
  { id: 'estate', label: 'Estate / saloon', length: 4.8, width: 1.85, height: 1.5 },
  { id: 'suv', label: 'Large SUV', length: 5.0, width: 2.0, height: 1.8 },
  { id: 'van', label: 'Medium van', length: 5.3, width: 2.05, height: 2.0 },
  { id: 'lwb', label: 'Large van (LWB, high roof)', length: 6.0, width: 2.1, height: 2.7 },
];

export const DEFAULT_VEHICLE: Vehicle = PRESETS[1]!;

/** Extra kerb length needed to get in and out of a parallel space. */
export const MANOEUVRE_M = 1.0;

/** UK design standards (Manual for Streets / British Parking Association guidance). */
export const BAY = {
  perpendicular: { length: 4.8, width: 2.4 },
  parallel: { length: 6.0, width: 2.0 },
};

/** Typical clearance of multi-storey and underground car parks when no limit is mapped. */
const TYPICAL_CAR_PARK_CLEARANCE = { min: 1.9, max: 2.1 };

export type FitVerdict = 'fits' | 'check' | 'too_big';

export interface Fit {
  verdict: FitVerdict;
  notes: string[];
}

const FITS: Fit = { verdict: 'fits', notes: [] };

function combine(...fits: Fit[]): Fit {
  const order: FitVerdict[] = ['fits', 'check', 'too_big'];
  let verdict: FitVerdict = 'fits';
  const notes: string[] = [];
  for (const f of fits) {
    if (order.indexOf(f.verdict) > order.indexOf(verdict)) verdict = f.verdict;
    notes.push(...f.notes);
  }
  return { verdict, notes };
}

/**
 * Parse an OSM length (maxheight, maxwidth, width, …) into metres.
 * Accepts "2.1", "2.1 m", "2,1", "6'6\"", "7'", "6 ft 6 in". Returns null for
 * "none", "default", "below_default" or anything unparseable.
 */
export function parseLengthM(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  const metric = /^(\d+(?:[.,]\d+)?)\s*(m)?$/.exec(s);
  if (metric) return Number(metric[1]!.replace(',', '.'));
  const imperial = /^(\d+)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inches)?)?$/.exec(s);
  if (imperial) return Number(imperial[1]) * 0.3048 + Number(imperial[2] ?? 0) * 0.0254;
  return null;
}

export function formatHeight(m: number): string {
  const totalIn = Math.round(m / 0.0254);
  return `${m.toFixed(2)} m (${Math.floor(totalIn / 12)}'${totalIn % 12}")`;
}

function limit(tags: Tags, key: string, have: number, what: string, prefix = ''): Fit {
  const max = parseLengthM(tags[`${prefix}${key}`]);
  if (max === null || have <= max) return FITS;
  return { verdict: 'too_big', notes: [`${what} limit ${key === 'maxheight' ? formatHeight(max) : `${max} m`}`] };
}

/** Restrictions on driving down the street at all (low bridge, width limit…). */
export function roadFit(v: Vehicle, tags: Tags): Fit {
  return combine(
    limit(tags, 'maxheight', v.height, 'Street height'),
    limit(tags, 'maxwidth', v.width, 'Street width'),
    limit(tags, 'maxlength', v.length, 'Street length'),
  );
}

/**
 * Would parking here leave enough road for traffic to pass? Highway Code rule 242:
 * you MUST NOT cause unnecessary obstruction. Uses the mapped carriageway width only.
 */
export function obstructionFit(v: Vehicle, tags: Tags, otherSideParked: boolean): Fit {
  const width = parseLengthM(tags['width:carriageway'] ?? tags['width']);
  if (width === null) return FITS;
  const remaining = width - v.width - (otherSideParked ? 1.9 : 0);
  if (remaining >= 3.0) return FITS;
  return { verdict: 'too_big', notes: [`Street too narrow (${width} m): parking would block traffic (Highway Code 242)`] };
}

/** Does the vehicle fit the bays / kerb on one side of a street? */
export function kerbFit(v: Vehicle, orientation: string | undefined, marked: boolean): Fit {
  if (orientation === 'perpendicular' || orientation === 'diagonal') {
    const b = BAY.perpendicular;
    if (v.length > b.length + 0.2 || v.width > b.width - 0.1) {
      return { verdict: 'too_big', notes: [`Bays are usually ${b.width} × ${b.length} m: you'd overhang the markings`] };
    }
    if (v.length > b.length - 0.3 || v.width > b.width - 0.4) return { verdict: 'check', notes: [`Tight fit in ${b.width} × ${b.length} m bays`] };
    return FITS;
  }
  if (marked) {
    const b = BAY.parallel;
    if (v.length > b.length - 0.3 || v.width > b.width) return { verdict: 'check', notes: [`Marked bays are often about ${b.width} × ${b.length} m`] };
  }
  return FITS;
}

export function carParkFit(v: Vehicle, tags: Tags): Fit {
  const fits = [limit(tags, 'maxheight', v.height, 'Height'), limit(tags, 'maxwidth', v.width, 'Width'), limit(tags, 'maxlength', v.length, 'Length')];
  const enclosed = tags['parking'] === 'multi-storey' || tags['parking'] === 'underground';
  if (enclosed && parseLengthM(tags['maxheight']) === null) {
    const { min, max } = TYPICAL_CAR_PARK_CLEARANCE;
    if (v.height > max) fits.push({ verdict: 'too_big', notes: [`Height limit not mapped; ${tags['parking']} car parks are usually ${min}–${max} m`] });
    else if (v.height > min) fits.push({ verdict: 'check', notes: [`Height limit not mapped; check the barrier (usually ${min}–${max} m)`] });
  }
  const b = BAY.perpendicular;
  if (v.length > b.length + 0.2 || v.width > b.width - 0.1) fits.push({ verdict: 'check', notes: [`Car park bays are usually ${b.width} × ${b.length} m`] });
  return combine(...fits);
}

export { combine as combineFits };
