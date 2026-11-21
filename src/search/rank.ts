import type { LatLon, ParkingData } from '../data/overpass';
import { offsetLine } from '../geo/offset';
import { distanceM, lengthWithin, midpoint, nearestOnLine, sideCompass, splitLine } from '../geo/measure';
import { assessCarPark, assessStreetSide, type Assessment, type Side, type StayWindow, type Tags } from '../rules/engine';
import { estimateCarParkCapacity, estimateKerbCapacity, likelihood, type Likelihood, type PlaceKind } from './likelihood';

export const KERB_OFFSET_M = 4;

/** Long kerbs are split into blocks of at most this length, each ranked on its own. */
export const KERB_BLOCK_M = 100;

/**
 * Distance at which a result's score drops to 1/e (~37%). A spot this much further
 * away has to be ~2.7× as likely to rank level with the nearer one.
 */
export const DISTANCE_SCALE_M = 400;

export type SortMode = 'best' | 'nearest' | 'likely';

export interface Place {
  id: string;
  kind: PlaceKind;
  name: string;
  /** e.g. "east side" for kerbs. */
  detail?: string;
  /** Kerb line (already offset to the correct side) or a single car-park point. */
  geometry: LatLon[];
  /** Closest point to the destination. */
  point: LatLon;
  /** Where to put a map label: middle of the block, or the car park. */
  labelPoint: LatLon;
  distance: number;
  assessment: Assessment;
  tags: Tags;
  osmUrl: string;
}

export interface Result extends Place {
  likelihood: Likelihood;
  score: number;
}

export interface SearchOutcome {
  /** Everything evaluated, for drawing on the map. */
  places: Place[];
  /** Free & legal places within the radius, unsorted. */
  results: Result[];
}

export function evaluate(data: ParkingData, destination: LatLon, radiusM: number, stay: StayWindow): SearchOutcome {
  const places: Place[] = [];
  const results: Result[] = [];

  for (const way of data.streets) {
    for (const side of ['left', 'right'] as Side[]) {
      const assessment = assessStreetSide(way.tags, side, stay);
      if (assessment.status === 'unknown') continue;
      if (way.tags[`parking:${side}`] === 'separate') continue;
      const kerb = offsetLine(way.geometry, side === 'right' ? KERB_OFFSET_M : -KERB_OFFSET_M);
      const blocks = splitLine(kerb, KERB_BLOCK_M);
      blocks.forEach((geometry, i) => {
        const near = nearestOnLine(geometry, destination);
        const place: Place = {
          id: `w${way.id}:${side}${blocks.length > 1 ? `:${i}` : ''}`,
          kind: 'kerb',
          name: way.tags['name'] ?? 'Unnamed street',
          detail: `${sideCompass(way.geometry, side)} side`,
          geometry,
          point: near.point,
          labelPoint: midpoint(geometry),
          distance: near.distance,
          assessment,
          tags: way.tags,
          osmUrl: `https://www.openstreetmap.org/way/${way.id}`,
        };
        places.push(place);

        if (assessment.status !== 'free' || near.distance > radiusM) return;
        const tagged = way.tags[`parking:${side}:capacity`] ?? way.tags['parking:both:capacity'];
        const inRange = lengthWithin(geometry, destination, radiusM);
        // A tagged capacity covers the whole way; share it out by length.
        const share = tagged !== undefined ? String(Math.round((Number(tagged) * inRange) / Math.max(1, lineLength(kerb)))) : undefined;
        const cap = estimateKerbCapacity(inRange, assessment.orientation, share);
        if (cap.capacity <= 0) return;
        const lk = likelihood('kerb', assessment.confidence, cap.capacity, cap.known, stay.start);
        results.push({ ...place, likelihood: lk, score: score(lk.probability, near.distance) });
      });
    }
  }

  for (const cp of data.carParks) {
    const assessment = assessCarPark(cp.tags, stay);
    const distance = distanceM(cp.center, destination);
    const place: Place = {
      id: `${cp.type[0]}${cp.id}`,
      kind: 'car_park',
      name: cp.tags['name'] ?? 'Car park',
      detail: 'car park',
      geometry: [cp.center],
      point: cp.center,
      labelPoint: cp.center,
      distance,
      assessment,
      tags: cp.tags,
      osmUrl: `https://www.openstreetmap.org/${cp.type}/${cp.id}`,
    };
    places.push(place);
    if (assessment.status !== 'free' || distance > radiusM) continue;
    const cap = estimateCarParkCapacity(cp.tags['capacity']);
    const lk = likelihood('car_park', assessment.confidence, cap.capacity, cap.known, stay.start);
    results.push({ ...place, likelihood: lk, score: score(lk.probability, distance) });
  }

  return { places, results };
}

function lineLength(line: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += distanceM(line[i - 1]!, line[i]!);
  return total;
}

export function score(probability: number, distanceM: number): number {
  return probability * Math.exp(-distanceM / DISTANCE_SCALE_M);
}

export function sortResults(results: Result[], mode: SortMode): Result[] {
  const key: Record<SortMode, (a: Result, b: Result) => number> = {
    best: (a, b) => b.score - a.score || a.distance - b.distance,
    nearest: (a, b) => a.distance - b.distance || b.likelihood.probability - a.likelihood.probability,
    likely: (a, b) => b.likelihood.probability - a.likelihood.probability || a.distance - b.distance,
  };
  return [...results].sort(key[mode]);
}
