import type { Confidence } from '../rules/engine';

/**
 * How likely is it that you'll actually be able to park here?
 *
 *   P(success) = P(the mapped rules are right) × P(at least one space is empty)
 *
 * P(at least one space is empty) = 1 − occupancy^capacity, treating spaces as
 * independent. The occupancy rates below are placeholder assumptions until we have
 * real data (city sensors, crowdsourced "leaving now" reports, historical patterns).
 * Swap `occupancyRate` for a data-driven model without touching the ranking.
 */

export type PlaceKind = 'kerb' | 'car_park';

export const LEGAL_PROBABILITY: Record<Confidence, number> = {
  high: 0.95, // fee and restrictions explicitly mapped
  medium: 0.75, // parking mapped but fee not: assumed free
  low: 0.5, // some rule couldn't be evaluated
};

/** Typical kerb length one car takes up, by parking orientation (m). */
const SPACE_LENGTH_M: Record<string, number> = {
  parallel: 6,
  diagonal: 3.5,
  perpendicular: 2.8,
};

const DEFAULT_CAR_PARK_CAPACITY = 20;

export function estimateKerbCapacity(lengthM: number, orientation?: string, taggedCapacity?: string): {
  capacity: number;
  known: boolean;
} {
  const tagged = taggedCapacity !== undefined ? Number.parseInt(taggedCapacity, 10) : NaN;
  if (Number.isFinite(tagged) && tagged >= 0) return { capacity: tagged, known: true };
  const spacing = SPACE_LENGTH_M[orientation ?? 'parallel'] ?? SPACE_LENGTH_M['parallel']!;
  return { capacity: Math.floor(lengthM / spacing), known: false };
}

export function estimateCarParkCapacity(taggedCapacity?: string): { capacity: number; known: boolean } {
  const tagged = taggedCapacity !== undefined ? Number.parseInt(taggedCapacity, 10) : NaN;
  if (Number.isFinite(tagged) && tagged >= 0) return { capacity: tagged, known: true };
  return { capacity: DEFAULT_CAR_PARK_CAPACITY, known: false };
}

/** Assumed share of spaces taken at time `t`. Free spaces are popular, so this is high. */
export function occupancyRate(kind: PlaceKind, t: Date): number {
  const h = t.getHours();
  const weekend = t.getDay() === 0 || t.getDay() === 6;
  if (kind === 'car_park') {
    if (h >= 23 || h < 6) return 0.5;
    return weekend ? 0.85 : 0.8;
  }
  if (h >= 22 || h < 7) return 0.93; // residents are home
  if (weekend) return 0.88;
  return 0.9; // weekday daytime and evening
}

export interface Likelihood {
  probability: number;
  legal: number;
  available: number;
  capacity: number;
  capacityKnown: boolean;
}

export function likelihood(kind: PlaceKind, confidence: Confidence, capacity: number, capacityKnown: boolean, arrival: Date): Likelihood {
  const legal = LEGAL_PROBABILITY[confidence];
  const available = capacity <= 0 ? 0 : 1 - occupancyRate(kind, arrival) ** capacity;
  return { probability: legal * available, legal, available, capacity, capacityKnown };
}
