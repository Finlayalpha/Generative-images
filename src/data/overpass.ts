import type { Tags } from '../rules/engine';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface StreetWay {
  id: number;
  tags: Tags;
  geometry: LatLon[];
}

export interface CarPark {
  id: number;
  type: 'node' | 'way' | 'relation';
  tags: Tags;
  center: LatLon;
}

export interface ParkingData {
  streets: StreetWay[];
  carParks: CarPark[];
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Public Overpass endpoints; tried in order. For production, run your own instance. */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export function buildQuery(b: BBox): string {
  const bbox = [b.south, b.west, b.north, b.east].map((n) => n.toFixed(6)).join(',');
  return `[out:json][timeout:25][bbox:${bbox}];
way["highway"][~"^parking:"~"."];
out tags geom;
nwr["amenity"="parking"];
out tags center;`;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Tags;
  lat?: number;
  lon?: number;
  center?: LatLon;
  geometry?: LatLon[];
}

export function parseOverpass(json: { elements?: OverpassElement[] }): ParkingData {
  const streets: StreetWay[] = [];
  const carParks: CarPark[] = [];
  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    if (tags['amenity'] === 'parking') {
      const center = el.center ?? (el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : undefined);
      if (center) carParks.push({ id: el.id, type: el.type, tags, center });
    } else if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
      streets.push({ id: el.id, tags, geometry: el.geometry });
    }
  }
  return { streets, carParks };
}

export async function fetchParking(b: BBox, signal?: AbortSignal): Promise<ParkingData> {
  const body = new URLSearchParams({ data: buildQuery(b) });
  let lastErr: unknown;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST', body, signal });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return parseOverpass(await res.json());
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Overpass request failed');
}
