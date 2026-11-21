import { formatImageDate, MIN_CONFIDENCE, type KerbMarking, type MarkingType } from '../data/markings';
import type { LatLon } from '../data/overpass';
import { nearestOnLine } from '../geo/measure';
import type { Assessment } from '../rules/engine';

/** An observation applies to kerb points within this distance (m) of its line. */
export const MATCH_M = 3;

/** Restrictive markings: what they mean, and how they affect an unsurveyed kerb. */
const RESTRICTIVE: Partial<Record<MarkingType, { reason: string; status: 'no_parking' | 'restricted' }>> = {
  double_yellow: { reason: 'Double yellow lines: no waiting at any time', status: 'no_parking' },
  zigzag: { reason: 'Zig-zag lines: no stopping', status: 'no_parking' },
  red_route: { reason: 'Red route lines: no stopping', status: 'no_parking' },
  keep_clear: { reason: '"Keep clear" markings', status: 'no_parking' },
  bus_lane: { reason: 'Bus lane: no stopping during its hours', status: 'no_parking' },
  single_yellow: { reason: 'Single yellow line: no waiting during the hours on nearby signs', status: 'restricted' },
};

/** When observations overlap, the most restrictive wins. */
const PRECEDENCE: MarkingType[] = ['zigzag', 'red_route', 'double_yellow', 'keep_clear', 'bus_lane', 'single_yellow', 'bay', 'occluded', 'clear'];

interface Box {
  s: number;
  w: number;
  n: number;
  e: number;
}

function box(line: LatLon[]): Box {
  const b: Box = { s: Infinity, w: Infinity, n: -Infinity, e: -Infinity };
  for (const p of line) {
    b.s = Math.min(b.s, p.lat);
    b.n = Math.max(b.n, p.lat);
    b.w = Math.min(b.w, p.lon);
    b.e = Math.max(b.e, p.lon);
  }
  return b;
}

function bboxNear(a: LatLon[], b: LatLon[], m: number): boolean {
  const A = box(a);
  const B = box(b);
  const dLat = m / 111_320;
  const dLon = m / (111_320 * Math.cos((A.s * Math.PI) / 180));
  return B.s <= A.n + dLat && B.n >= A.s - dLat && B.w <= A.e + dLon && B.e >= A.w - dLon;
}

/** Observations that could apply to this kerb line. */
export function candidateMarkings(kerb: LatLon[], markings: KerbMarking[]): KerbMarking[] {
  return markings.filter((m) => m.confidence >= MIN_CONFIDENCE && bboxNear(kerb, m.geometry, MATCH_M));
}

/** The observation that applies at a point on the kerb, or -1. */
export function markingAt(p: LatLon, candidates: KerbMarking[]): number {
  let best = -1;
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i]!;
    if (nearestOnLine(m.geometry, p).distance > MATCH_M) continue;
    if (best < 0) {
      best = i;
      continue;
    }
    const b = candidates[best]!;
    const rank = PRECEDENCE.indexOf(m.marking) - PRECEDENCE.indexOf(b.marking);
    if (rank < 0 || (rank === 0 && m.confidence > b.confidence)) best = i;
  }
  return best;
}

export interface MarkingEffect {
  assessment: Assessment;
  /** Photo date, when the imagery confirms an unsurveyed kerb has no lines. */
  checked?: string;
  /** The photo contradicts mapped rules. */
  conflict?: boolean;
}

/**
 * Apply an observation to a kerb stretch.
 *  - Unsurveyed kerbs: restrictive markings rule parking out; a clear kerb
 *    becomes "Lines checked"; a bay is unknown until its sign is known.
 *  - Mapped kerbs: mapped rules win, but a contradicting photo adds a warning
 *    and lowers the tier, because the markings may have changed since mapping.
 */
export function applyMarking(m: KerbMarking, base: Assessment, inferred: boolean, unsurveyedNote: string): MarkingEffect {
  const when = `aerial photo, ${formatImageDate(m.imageDate)}`;
  const restrictive = RESTRICTIVE[m.marking];
  const parked = m.parkedVehicles ? [`Cars were parked here in the ${when}`] : [];

  if (!inferred) {
    if (restrictive && base.status === 'free') {
      const what = restrictive.reason.split(':')[0]!.toLowerCase();
      return {
        assessment: { ...base, reasons: [`The ${when} shows ${what} here: check before parking`, ...base.reasons] },
        conflict: true,
      };
    }
    return { assessment: base };
  }

  if (restrictive) {
    return { assessment: { status: restrictive.status, confidence: 'medium', reasons: [`${restrictive.reason} (${when})`], needsDisc: false } };
  }
  switch (m.marking) {
    case 'bay':
      return {
        assessment: {
          status: 'unknown',
          confidence: 'low',
          reasons: [`Marked bays (${when}): check the sign, most on-street bays are pay or permit`],
          needsDisc: false,
        },
      };
    case 'clear':
      return {
        assessment: {
          ...base,
          reasons: [
            ...base.reasons.filter((r) => r !== unsurveyedNote),
            `No yellow lines in the ${when}: still check for signs`,
            ...parked,
          ],
        },
        checked: m.imageDate,
      };
    default: // occluded: no information
      return { assessment: base };
  }
}
