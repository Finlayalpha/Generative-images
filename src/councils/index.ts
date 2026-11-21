import type { LatLon } from '../data/overpass';
import { fetchCamden, inCamden } from './camden';
import { EMPTY_COUNCIL_DATA, type CouncilData } from './types';

/**
 * Council adapters. Each one says whether it covers a search area and fetches
 * normalised bays and zones. Add councils here as their data is integrated.
 */
interface CouncilAdapter {
  id: string;
  covers(c: LatLon, radiusM: number): boolean;
  fetch(c: LatLon, radiusM: number, signal?: AbortSignal): Promise<CouncilData>;
}

export const ADAPTERS: CouncilAdapter[] = [{ id: 'camden', covers: inCamden, fetch: fetchCamden }];

export function mergeCouncilData(parts: CouncilData[]): CouncilData {
  return {
    councils: parts.flatMap((p) => p.councils),
    bays: parts.flatMap((p) => p.bays),
    zones: parts.flatMap((p) => p.zones),
  };
}

/** Fetch council data for a search area. A failing council is skipped, not fatal. */
export async function fetchCouncilData(c: LatLon, radiusM: number, signal?: AbortSignal): Promise<CouncilData> {
  const relevant = ADAPTERS.filter((a) => a.covers(c, radiusM));
  if (!relevant.length) return EMPTY_COUNCIL_DATA;
  const parts = await Promise.all(relevant.map((a) => a.fetch(c, radiusM, signal).catch(() => EMPTY_COUNCIL_DATA)));
  return mergeCouncilData(parts);
}

export type { CouncilData } from './types';
