import type { LatLon } from './overpass';

/**
 * Road markings detected along kerbs from aerial photography, surveyed once and
 * refreshed periodically. Spec: docs/KERB_MARKINGS_FORMAT.md
 *
 * Each observation is a stretch of kerb (a line drawn along the kerb edge) with
 * what the photo shows there.
 */
export const MARKING_TYPES = [
  'double_yellow',
  'single_yellow',
  'zigzag',
  'red_route',
  'keep_clear',
  'bus_lane',
  'bay',
  'clear',
  'occluded',
] as const;
export type MarkingType = (typeof MARKING_TYPES)[number];

export interface KerbMarking {
  marking: MarkingType;
  geometry: LatLon[];
  /** Detector confidence, 0–1. */
  confidence: number;
  /** Date the photo was taken (YYYY-MM-DD). */
  imageDate: string;
  /** Imagery source / survey id, for attribution and re-runs. */
  source: string;
  /** Vehicles were parked along this stretch in the photo. */
  parkedVehicles?: boolean;
}

export const FORMAT_ID = 'kerb-markings/1';

/** Observations below this confidence are ignored. */
export const MIN_CONFIDENCE = 0.6;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a kerb-markings GeoJSON FeatureCollection. Invalid features are
 * dropped rather than failing the whole file; their count is returned.
 */
export function parseMarkings(json: unknown): { markings: KerbMarking[]; rejected: number } {
  const markings: KerbMarking[] = [];
  let rejected = 0;
  const fc = json as { type?: string; features?: unknown[] } | null;
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return { markings, rejected };

  for (const f of fc.features) {
    const feat = f as { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> };
    const p = feat.properties ?? {};
    const coords = feat.geometry?.type === 'LineString' ? feat.geometry.coordinates : null;
    const valid =
      Array.isArray(coords) &&
      coords.length >= 2 &&
      coords.every((c) => Array.isArray(c) && c.length >= 2 && c.every((n) => typeof n === 'number' && Number.isFinite(n))) &&
      MARKING_TYPES.includes(p['marking'] as MarkingType) &&
      typeof p['confidence'] === 'number' &&
      p['confidence'] >= 0 &&
      p['confidence'] <= 1 &&
      typeof p['image_date'] === 'string' &&
      DATE_RE.test(p['image_date']) &&
      typeof p['source'] === 'string';
    if (!valid) {
      rejected++;
      continue;
    }
    markings.push({
      marking: p['marking'] as MarkingType,
      // GeoJSON is [lon, lat].
      geometry: (coords as number[][]).map(([lon, lat]) => ({ lat: lat!, lon: lon! })),
      confidence: p['confidence'] as number,
      imageDate: p['image_date'] as string,
      source: p['source'] as string,
      parkedVehicles: p['parked_vehicles'] === true ? true : undefined,
    });
  }
  return { markings, rejected };
}

/**
 * Load observations around a point. The service URL is configured at build time
 * with VITE_MARKINGS_URL, e.g. `https://example.org/markings?lat={lat}&lon={lon}&radius={radius}`.
 * With no service configured there are simply no observations.
 */
export async function fetchMarkings(c: LatLon, radiusM: number, signal?: AbortSignal): Promise<KerbMarking[]> {
  const template = import.meta.env.VITE_MARKINGS_URL as string | undefined;
  if (!template) return [];
  const url = template
    .replace('{lat}', c.lat.toFixed(6))
    .replace('{lon}', c.lon.toFixed(6))
    .replace('{radius}', String(Math.round(radiusM)));
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Markings ${res.status}`);
  return parseMarkings(await res.json()).markings;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2025-06-14" → "Jun 2025" */
export function formatImageDate(d: string): string {
  const [y, m] = d.split('-');
  return `${MONTHS[Number(m) - 1] ?? ''} ${y}`.trim();
}
