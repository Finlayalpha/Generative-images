import type { LatLon, ParkingData } from '../data/overpass';
import { distanceM, midpoint, nearestOnLine, splitLine } from '../geo/measure';
import { assessCarPark, type Assessment, type StayWindow, type Tags } from '../rules/engine';
import { buildKerbs, type Source } from '../uk/kerbs';
import { buildZones } from '../uk/zones';
import { carParkFit, type Fit, type Vehicle } from '../vehicle';

/** Long kerbs are split into blocks of at most this length, each listed on its own. */
export const KERB_BLOCK_M = 100;

/**
 * How sure we are about the rules:
 *   confirmed  — fee and restrictions mapped explicitly
 *   partial    — parking mapped, but not every rule (e.g. no fee tag), or
 *                aerial imagery contradicts what's mapped
 *   checked    — no local rules mapped, but aerial imagery shows no yellow lines
 *   unsurveyed — no local rules mapped; only national rules applied
 */
export type Tier = 'confirmed' | 'partial' | 'checked' | 'unsurveyed';
export const TIER_ORDER: Tier[] = ['confirmed', 'partial', 'checked', 'unsurveyed'];

export type SortMode = 'nearest' | 'certain';

export interface Place {
  id: string;
  kind: 'kerb' | 'car_park';
  name: string;
  detail?: string;
  geometry: LatLon[];
  /** Closest point to the destination. */
  point: LatLon;
  /** Where to put a map label. */
  labelPoint: LatLon;
  distance: number;
  assessment: Assessment;
  source: Source;
  tier: Tier;
  /** Date of the aerial photo behind a "checked" tier. */
  imageDate?: string;
  fit: Fit;
  tags: Tags;
  osmUrl: string;
}

export interface SearchOptions {
  destination: LatLon;
  radiusM: number;
  stay: StayWindow;
  vehicle: Vehicle;
  includeUnsurveyed: boolean;
}

export interface SearchOutcome {
  /** Everything evaluated, for drawing on the map. */
  places: Place[];
  /** Free, legal places in range that the vehicle fits. Unsorted. */
  results: Place[];
}

function tierOf(source: Source, a: Assessment, evidence: { checked?: string; conflict?: boolean } = {}): Tier {
  if (source === 'inferred') return evidence.checked ? 'checked' : 'unsurveyed';
  return a.confidence === 'high' && !evidence.conflict ? 'confirmed' : 'partial';
}

export function isResult(p: Place, opts: SearchOptions): boolean {
  return (
    p.assessment.status === 'free' &&
    p.fit.verdict !== 'too_big' &&
    p.distance <= opts.radiusM &&
    (opts.includeUnsurveyed || p.tier !== 'unsurveyed')
  );
}

export function evaluate(data: ParkingData, opts: SearchOptions): SearchOutcome {
  const { destination, stay, vehicle } = opts;
  const places: Place[] = [];

  const zones = buildZones(data);
  for (const piece of buildKerbs(data, zones, stay, vehicle)) {
    // Split parkable kerbs into blocks so each result points at a specific stretch.
    const blocks = piece.assessment.status === 'no_parking' ? [piece.geometry] : splitLine(piece.geometry, KERB_BLOCK_M);
    blocks.forEach((geometry, i) => {
      const near = nearestOnLine(geometry, destination);
      places.push({
        id: blocks.length > 1 ? `${piece.id}:b${i}` : piece.id,
        kind: 'kerb',
        name: piece.name,
        detail: piece.detail,
        geometry,
        point: near.point,
        labelPoint: midpoint(geometry),
        distance: near.distance,
        assessment: piece.assessment,
        source: piece.source,
        tier: tierOf(piece.source, piece.assessment, piece),
        imageDate: piece.checked,
        fit: piece.fit,
        tags: piece.tags,
        osmUrl: `https://www.openstreetmap.org/way/${piece.wayId}`,
      });
    });
  }

  for (const cp of data.carParks) {
    const assessment = assessCarPark(cp.tags, stay);
    places.push({
      id: `${cp.type[0]}${cp.id}`,
      kind: 'car_park',
      name: cp.tags['name'] ?? 'Car park',
      detail: 'car park',
      geometry: [cp.center],
      point: cp.center,
      labelPoint: cp.center,
      distance: distanceM(cp.center, destination),
      assessment,
      source: 'mapped',
      tier: tierOf('mapped', assessment),
      fit: carParkFit(vehicle, cp.tags),
      tags: cp.tags,
      osmUrl: `https://www.openstreetmap.org/${cp.type}/${cp.id}`,
    });
  }

  return { places, results: places.filter((p) => isResult(p, opts)) };
}

export function sortResults(results: Place[], mode: SortMode): Place[] {
  const tierRank = (p: Place) => TIER_ORDER.indexOf(p.tier);
  const cmp =
    mode === 'nearest'
      ? (a: Place, b: Place) => a.distance - b.distance || tierRank(a) - tierRank(b)
      : (a: Place, b: Place) => tierRank(a) - tierRank(b) || a.distance - b.distance;
  return [...results].sort(cmp);
}
