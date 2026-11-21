import type { LatLon, ParkingData } from '../data/overpass';
import { offsetLine } from '../geo/offset';
import { distanceM, nearestOnLine, runsAlong, sideCompass, sliceLine } from '../geo/measure';
import { assessStreetSide, type Assessment, type Side, type StayWindow, type Tags } from '../rules/engine';
import { normalizeLegacy } from '../rules/legacy';
import { combineFits, kerbFit, MANOEUVRE_M, obstructionFit, roadFit, BAY, type Fit, type Vehicle } from '../vehicle';
import { inferSide } from './streets';
import type { Zone } from './zones';
import { applyMarking, candidateMarkings, markingAt } from './markings';

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
  /** Aerial photo date, when imagery shows an unsurveyed kerb has no lines. */
  checked?: string;
  /** Aerial imagery contradicts the mapped rules. */
  conflict?: boolean;
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
 *  4. Apply road markings seen in aerial photography, where available.
 *  5. Check the vehicle fits: street size limits, bay size, length of each gap.
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
      const observed = candidateMarkings(kerb, data.markings ?? []);
      // Classify each metre of kerb: a national-rule zone ("z<i>"), an aerial
      // observation ("m<i>"), or nothing known ("").
      const runs =
        cutting.length || observed.length
          ? runsAlong(kerb, (p) => {
              const z = cutting.findIndex((zone) => distanceM(p, zone.center) <= zone.radius);
              if (z >= 0) return `z${z}`;
              const m = observed.length ? markingAt(p, observed) : -1;
              return m >= 0 ? `m${m}` : '';
            })
          : [{ from: 0, to: Infinity, value: '' }];

      type Part = { from: number; to: number; assessment: Assessment; checked?: string; conflict?: boolean };
      const classified: Part[] = runs.map((run) => {
        const span = { from: run.from, to: run.to };
        if (run.value.startsWith('z')) {
          const reason = cutting[Number(run.value.slice(1))]!.reason;
          return { ...span, assessment: { status: 'no_parking', confidence: 'medium', reasons: [reason], needsDisc: false } as Assessment };
        }
        if (run.value.startsWith('m')) {
          return { ...span, ...applyMarking(observed[Number(run.value.slice(1))]!, assessment, source === 'inferred', UNSURVEYED_NOTE) };
        }
        return { ...span, assessment };
      });

      // Merge neighbouring stretches with the same outcome (e.g. an observation that
      // changed nothing), so kerbs aren't fragmented.
      const merged: Part[] = [];
      for (const part of classified) {
        const prev = merged[merged.length - 1];
        const same =
          prev &&
          (prev.assessment === part.assessment ||
            (prev.assessment.status === 'no_parking' && part.assessment.status === 'no_parking' && prev.assessment.reasons[0] === part.assessment.reasons[0])) &&
          prev.checked === part.checked &&
          prev.conflict === part.conflict;
        if (same) prev.to = part.to;
        else merged.push({ ...part });
      }
      const parts = merged.map((part) => ({
        ...part,
        geometry: part.from === 0 && part.to === Infinity ? kerb : sliceLine(kerb, part.from, part.to),
        length: part.to - part.from,
      }));

      // A parked car needs one continuous free stretch, which may span several parts.
      const groupLength: number[] = [];
      for (let i = 0; i < parts.length; ) {
        let j = i;
        let total = 0;
        while (j < parts.length && parts[j]!.assessment.status === 'free') total += parts[j++]!.length;
        if (j === i) {
          groupLength[i++] = 0;
          continue;
        }
        for (let k = i; k < j; k++) groupLength[k] = total;
        i = j;
      }

      parts.forEach((part, k) => {
        const id = `w${way.id}:${side}${parts.length > 1 ? `:${k}` : ''}`;
        let fit = sideFit;
        const gap = groupLength[k]!;
        if (part.assessment.status === 'free' && gap < minGap) {
          fit = combineFits(fit, { verdict: 'too_big', notes: [`Gap is only ${Math.round(gap * 10) / 10} m: too short for your vehicle`] });
        }
        pieces.push({ ...base, id, geometry: part.geometry, assessment: part.assessment, fit, checked: part.checked, conflict: part.conflict });
      });
    }
  }
  return pieces;
}
