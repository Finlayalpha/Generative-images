import type { LatLon, ParkingData, StreetWay } from '../data/overpass';
import { EMPTY_COUNCIL_DATA, type CouncilBay } from '../councils/types';
import { assignBays, bayAssessment, bayFit, zoneAssessment, zoneLookup } from './council';
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
export type Source = 'council' | 'mapped' | 'inferred';

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
  /** The council bay this piece is, if any. */
  bay?: CouncilBay;
  /** Controlled parking zone the kerb is in, if known. */
  zone?: string;
}

export const UNSURVEYED_NOTE = 'Parking rules not mapped here: check for yellow lines and signs';
export const ZONE_CHECK_NOTE = 'Check for double yellow lines and signs';

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
 *  2. Otherwise apply UK national rules ("inferred"), plus a council's
 *     controlled-zone hours where the kerb is in a CPZ.
 *  3. Council bays override everything along their extent ("council").
 *  4. Cut out zones around junctions, crossings, bus stops, driveways, …
 *  5. Apply road markings seen in aerial photography, where available.
 *  6. Check the vehicle fits: street size limits, bay size, length of each gap.
 */
export function buildKerbs(data: ParkingData, zones: Zone[], stay: StayWindow, vehicle: Vehicle, now = new Date()): KerbPiece[] {
  const pieces: KerbPiece[] = [];
  const council = data.council ?? EMPTY_COUNCIL_DATA;

  // Pass 1: every street side we might show, with its base rules.
  interface StreetSide {
    key: string;
    way: StreetWay;
    tags: Tags;
    side: Side;
    kerb: LatLon[];
    assessment: Assessment;
    source: Source;
    /** Notes for an unsurveyed kerb, reused if part of it is in a controlled zone. */
    notes?: string[];
  }
  const sides: StreetSide[] = [];
  for (const way of data.streets) {
    const tags = normalizeLegacy(way.tags);
    for (const side of ['left', 'right'] as Side[]) {
      if (sideKind(tags, side) === 'separate') continue;
      const kerb = offsetLine(way.geometry, side === 'right' ? KERB_OFFSET_M : -KERB_OFFSET_M);
      let assessment = assessStreetSide(tags, side, stay);
      let source: Source = 'mapped';
      let notes: string[] | undefined;
      if (assessment.status === 'unknown') {
        const e = inferSide(tags, side);
        if (e.kind === 'skip') continue;
        source = 'inferred';
        if (e.kind === 'excluded') {
          assessment = { status: 'no_parking', confidence: 'medium', reasons: [e.reason], needsDisc: false };
        } else {
          notes = e.notes;
          assessment = { status: 'free', confidence: 'low', reasons: [...e.notes, UNSURVEYED_NOTE], needsDisc: false };
        }
      }
      sides.push({ key: `w${way.id}:${side}`, way, tags, side, kerb, assessment, source, notes });
    }
  }

  // Pass 2: put council bays on the right kerbs.
  const { byKerb, unmatched } = assignBays(
    sides.map((s) => ({ key: s.key, line: s.kerb })),
    council.bays,
  );
  const bayRules = new Map(council.bays.map((b) => [b.id, bayAssessment(b, stay, now)]));

  for (const s of sides) {
    const { way, tags, side, kerb, assessment, source } = s;
    const bays = byKerb.get(s.key) ?? [];
    const roadLimits = roadFit(vehicle, tags);
    const base = {
      wayId: way.id,
      side,
      name: tags['name'] ?? tags['ref'] ?? 'Unnamed street',
      detail: `${sideCompass(way.geometry, side)} side`,
      tags: way.tags,
    };

    if (assessment.status === 'no_parking' && !bays.length) {
      pieces.push({ ...base, source, id: s.key, geometry: kerb, assessment, fit: roadLimits });
      continue;
    }

    const orientation = assessment.orientation;
    const perpendicular = orientation === 'perpendicular' || orientation === 'diagonal';
    const marked = (tags[`parking:${side}:markings`] ?? tags['parking:both:markings']) === 'yes';
    const sideFit = combineFits(
      roadLimits,
      kerbFit(vehicle, orientation, marked),
      obstructionFit(vehicle, tags, otherSideParked(tags, side)),
    );
    const minGap = perpendicular ? BAY.perpendicular.width : vehicle.length + MANOEUVRE_M;

    const cutting = zones.filter(
      (z) => (source === 'inferred' || z.appliesToMapped) && bboxFilter(kerb, z) && nearestOnLine(kerb, z.center).distance <= z.near,
    );
    const observed = candidateMarkings(kerb, data.markings ?? []);
    // Controlled zones only change unsurveyed kerbs (mapped rules already say what applies).
    const inZone = s.notes && assessment.status === 'free' ? zoneLookup(kerb, council.zones) : () => -1;
    const zoneRules = new Map<number, Assessment>();
    const baseFor = (zi: number) => {
      if (zi < 0) return assessment;
      if (!zoneRules.has(zi)) zoneRules.set(zi, zoneAssessment(council.zones[zi]!, stay, s.notes ?? [], ZONE_CHECK_NOTE));
      return zoneRules.get(zi)!;
    };
    // Classify each metre of kerb: its controlled zone ("<zone>|"), then a council
    // bay ("b<i>"), a national-rule cut-out ("z<i>"), an aerial observation ("m<i>"),
    // or just the base rules ("").
    const runs = runsAlong(kerb, (p, along) => {
      const zone = inZone(p);
      const b = bays.findIndex((x) => along >= x.from && along <= x.to);
      if (b >= 0) return `${zone}|b${b}`;
      const z = cutting.findIndex((c) => distanceM(p, c.center) <= c.radius);
      if (z >= 0) return `${zone}|z${z}`;
      const m = observed.length ? markingAt(p, observed) : -1;
      return m >= 0 ? `${zone}|m${m}` : `${zone}|`;
    });

    type Part = { from: number; to: number; assessment: Assessment; checked?: string; conflict?: boolean; bay?: CouncilBay; zone?: string };
    const classified: Part[] = runs.map((run) => {
      const [zonePart, what] = run.value.split('|') as [string, string];
      const zi = Number(zonePart);
      const base = baseFor(zi);
      const span = { from: run.from, to: run.to, zone: zi >= 0 ? council.zones[zi]!.code : undefined };
      const i = Number(what.slice(1));
      switch (what[0]) {
        case 'b': {
          const bay = bays[i]!.bay;
          return { ...span, bay, assessment: bayRules.get(bay.id)! };
        }
        case 'z':
          return { ...span, assessment: { status: 'no_parking', confidence: 'medium', reasons: [cutting[i]!.reason], needsDisc: false } as Assessment };
        case 'm':
          return { ...span, ...applyMarking(observed[i]!, base, source === 'inferred', UNSURVEYED_NOTE, zi >= 0) };
        default:
          return { ...span, assessment: base };
      }
    });

    // Merge neighbouring stretches with the same outcome (e.g. an observation that
    // changed nothing), so kerbs aren't fragmented.
    const merged: Part[] = [];
    for (const part of classified) {
      const prev = merged[merged.length - 1];
      const same =
        prev &&
        prev.bay === part.bay &&
        prev.zone === part.zone &&
        (prev.assessment === part.assessment ||
          (prev.assessment.status === 'no_parking' && part.assessment.status === 'no_parking' && prev.assessment.reasons[0] === part.assessment.reasons[0])) &&
        prev.checked === part.checked &&
        prev.conflict === part.conflict;
      if (same) prev.to = part.to;
      else merged.push({ ...part });
    }
    const parts = merged.map((part) => ({
      ...part,
      geometry: merged.length === 1 ? kerb : sliceLine(kerb, part.from, part.to),
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
      const id = `${s.key}${parts.length > 1 ? `:${k}` : ''}`;
      if (part.bay) {
        // Marked council bays: the bay's own space size decides the fit.
        pieces.push({ ...base, id, source: 'council', geometry: part.geometry, assessment: part.assessment, fit: combineFits(roadLimits, bayFit(part.bay, vehicle)), bay: part.bay, zone: part.bay.zone ?? part.zone });
        return;
      }
      let fit = sideFit;
      const gap = groupLength[k]!;
      if (part.assessment.status === 'free' && gap < minGap) {
        fit = combineFits(fit, { verdict: 'too_big', notes: [`Gap is only ${Math.round(gap * 10) / 10} m: too short for your vehicle`] });
      }
      pieces.push({ ...base, id, source, geometry: part.geometry, assessment: part.assessment, fit, checked: part.checked, conflict: part.conflict, zone: part.zone });
    });
  }

  // Council bays we couldn't place on a kerb (e.g. in mews or car parks): show them as they are.
  for (const bay of unmatched) {
    pieces.push({
      id: `c${bay.council}:${bay.id}`,
      wayId: 0,
      side: 'left',
      name: bay.road ?? 'Parking bay',
      detail: 'marked bay',
      tags: {},
      geometry: bay.geometry,
      assessment: bayRules.get(bay.id)!,
      source: 'council',
      fit: bayFit(bay, vehicle),
      bay,
      zone: bay.zone,
    });
  }
  return pieces;
}
