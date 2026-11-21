import type { LatLon, ParkingData } from '../data/overpass';
import { offsetLine } from '../geo/offset';
import { distanceM, nearestOnLine, runsAlong, sideCompass, sliceLine } from '../geo/measure';
import { assessStreetSide, type Assessment, type Side, type StayWindow, type Tags } from '../rules/engine';
import { normalizeLegacy } from '../rules/legacy';
import { combineFits, kerbFit, MANOEUVRE_M, obstructionFit, roadFit, BAY, type Fit, type Vehicle } from '../vehicle';
import { inferSide } from './streets';
import type { Zone } from './zones';

export const KERB_OFFSET_M = 4;

/** Where a kerb's rules come from. */
export type Source = 'mapped' | 'inferred';

export interface KerbPiece {
  id: string;
  wayId: number;
  side: Side;
  name: string;
  /** e.g. "east side" */
  detail: string;
  tags: Tags;
  geometry: LatLon[];
  assessment: Assessment;
  source: Source;
  fit: Fit;
}

export const UNSURVEYED_NOTE = 'Parking rules not mapped here: check for yellow lines and signs';

const NO_PARKING_KINDS = new Set(['no', 'separate', 'no_parking', 'no_stopping', 'fire_lane']);

function sideKind(tags: Tags, side: Side): string | undefined {
  return tags[`parking:${side}`] ?? tags['parking:both'];
}

/** Is parking likely on the other side too? Used for the road-width check. */
function otherSideParked(tags: Tags, side: Side): boolean {
  const other: Side = side === 'left' ? 'right' : 'left';
  const kind = sideKind(tags, other);
  if (kind !== undefined) return !NO_PARKING_KINDS.has(kind);
  return inferSide(tags, other).kind === 'ok';
}

function bboxFilter(line: LatLon[], z: Zone): boolean {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const p of line) {
    s = Math.min(s, p.lat); n = Math.max(n, p.lat);
    w = Math.min(w, p.lon); e = Math.max(e, p.lon);
  }
  const dLat = z.near / 111_320;
  const dLon = z.near / (111_320 * Math.cos((z.center.lat * Math.PI) / 180));
  return z.center.lat >= s - dLat && z.center.lat <= n + dLat && z.center.lon >= w - dLon && z.center.lon <= e + dLon;
}

/**
 * Turn every street side into kerb pieces with a parking assessment:
 *  1. Use mapped OSM parking rules where they exist ("mapped").
 *  2. Otherwise apply UK national rules to the street ("inferred").
 *  3. Cut out zones around junctions, crossings, bus stops, driveways, …
 *  4. Check the vehicle fits: street size limits, bay size, length of each gap.
 */
export function buildKerbs(data: ParkingData, zones: Zone[], stay: StayWindow, vehicle: Vehicle): KerbPiece[] {
  const pieces: KerbPiece[] = [];

  for (const way of data.streets) {
    const tags = normalizeLegacy(way.tags);
    const roadLimits = roadFit(vehicle, tags);

    for (const side of ['left', 'right'] as Side[]) {
      if (sideKind(tags, side) === 'separate') continue;

      let assessment = assessStreetSide(tags, side, stay);
      let source: Source = 'mapped';
      if (assessment.status === 'unknown') {
        const e = inferSide(tags, side);
        if (e.kind === 'skip') continue;
        source = 'inferred';
        assessment =
          e.kind === 'excluded'
            ? { status: 'no_parking', confidence: 'medium', reasons: [e.reason], needsDisc: false }
            : { status: 'free', confidence: 'low', reasons: [...e.notes, UNSURVEYED_NOTE], needsDisc: false };
      }

      const kerb = offsetLine(way.geometry, side === 'right' ? KERB_OFFSET_M : -KERB_OFFSET_M);
      const base = {
        wayId: way.id,
        side,
        name: tags['name'] ?? tags['ref'] ?? 'Unnamed street',
        detail: `${sideCompass(way.geometry, side)} side`,
        tags: way.tags,
        source,
      };

      if (assessment.status === 'no_parking') {
        pieces.push({ ...base, id: `w${way.id}:${side}`, geometry: kerb, assessment, fit: roadLimits });
        continue;
      }

      const orientation = assessment.orientation;
      const bays = orientation === 'perpendicular' || orientation === 'diagonal';
      const marked = (tags[`parking:${side}:markings`] ?? tags['parking:both:markings']) === 'yes';
      const sideFit = combineFits(
        roadLimits,
        kerbFit(vehicle, orientation, marked),
        obstructionFit(vehicle, tags, otherSideParked(tags, side)),
      );
      const minGap = bays ? BAY.perpendicular.width : vehicle.length + MANOEUVRE_M;

      const cutting = zones.filter(
        (z) => (source === 'inferred' || z.appliesToMapped) && bboxFilter(kerb, z) && nearestOnLine(kerb, z.center).distance <= z.near,
      );
      const runs = cutting.length
        ? runsAlong(kerb, (p) => cutting.findIndex((z) => distanceM(p, z.center) <= z.radius))
        : [{ from: 0, to: Infinity, value: -1 }];

      runs.forEach((run, k) => {
        const geometry = run.to === Infinity ? kerb : sliceLine(kerb, run.from, run.to);
        const id = `w${way.id}:${side}${runs.length > 1 ? `:${k}` : ''}`;
        if (run.value >= 0) {
          const reason = cutting[run.value]!.reason;
          pieces.push({ ...base, id, geometry, fit: sideFit, assessment: { status: 'no_parking', confidence: 'medium', reasons: [reason], needsDisc: false } });
          return;
        }
        let fit = sideFit;
        const len = run.to === Infinity ? Infinity : run.to - run.from;
        if (len < minGap) {
          fit = combineFits(fit, { verdict: 'too_big', notes: [`Gap is only ${Math.round(len * 10) / 10} m: too short for your vehicle`] });
        }
        pieces.push({ ...base, id, geometry, assessment, fit });
      });
    }
  }
  return pieces;
}
