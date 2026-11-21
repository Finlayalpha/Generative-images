import type { Tags } from '../rules/engine';
import type { KerbMarking } from './markings';
import type { CouncilData } from '../councils/types';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface StreetWay {
  id: number;
  tags: Tags;
  geometry: LatLon[];
  /** OSM node ids, parallel to `geometry`. Needed to find junctions and driveways. */
  nodes?: number[];
}

/** Point features that affect parking: crossings, bus stops, dropped kerbs, … */
export interface PointFeature {
  id: number;
  lat: number;
  lon: number;
  tags: Tags;
}

export interface CarPark {
  id: number;
  type: 'node' | 'way' | 'relation';
  tags: Tags;
  center: LatLon;
}

export interface ParkingData {
  streets: StreetWay[];
  points: PointFeature[];
  carParks: CarPark[];
  /** Road markings detected from aerial photography, if any (see data/markings.ts). */
  markings?: KerbMarking[];
  /** Council bays and controlled parking zones, where a council publishes them (see councils/). */
  council?: CouncilData;
}

const ROAD_TYPES =
  'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road';

/** Public Overpass endpoints; tried in order. For production, run your own instance. */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * Everything needed to work out parking within `radiusM` of a point: every road
 * (with node ids, to find junctions), point features that rule out parking
 * nearby, and car parks.
 */
export function buildAroundQuery(c: LatLon, radiusM: number): string {
  const ll = `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;
  const r = Math.round(radiusM);
  const rp = r + 30; // points just outside the radius still cut kerbs inside it
  return `[out:json][timeout:40];
way(around:${r},${ll})["highway"~"^(${ROAD_TYPES})$"];
out body geom;
(
  node(around:${rp},${ll})["highway"~"^(crossing|bus_stop)$"];
  node(around:${rp},${ll})["railway"="level_crossing"];
  node(around:${rp},${ll})["kerb"~"^(lowered|flush)$"];
  node(around:${rp},${ll})["amenity"="taxi"];
  node(around:${rp},${ll})["traffic_calming"="island"];
  node(around:${rp},${ll})["crossing:island"="yes"];
);
out body;
nwr(around:${r},${ll})["amenity"="parking"];
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
  nodes?: number[];
}

export function parseOverpass(json: { elements?: OverpassElement[] }): ParkingData {
  const streets: StreetWay[] = [];
  const points: PointFeature[] = [];
  const carParks: CarPark[] = [];
  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    if (tags['amenity'] === 'parking') {
      const center = el.center ?? (el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : undefined);
      if (center) carParks.push({ id: el.id, type: el.type, tags, center });
    } else if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
      streets.push({ id: el.id, tags, geometry: el.geometry, nodes: el.nodes });
    } else if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      points.push({ id: el.id, lat: el.lat, lon: el.lon, tags });
    }
  }
  return { streets, points, carParks };
}

export async function fetchParking(query: string, signal?: AbortSignal): Promise<ParkingData> {
  const body = new URLSearchParams({ data: query });
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
