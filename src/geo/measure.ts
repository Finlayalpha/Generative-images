import type { LatLon } from '../data/overpass';

const M_PER_DEG_LAT = 111_320;

/** Local flat projection (metres) centred on `origin`. Accurate to well under 1% within a few km. */
function projector(origin: LatLon) {
  const kx = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return {
    to: (p: LatLon) => ({ x: (p.lon - origin.lon) * kx, y: (p.lat - origin.lat) * M_PER_DEG_LAT }),
    from: (x: number, y: number): LatLon => ({ lat: origin.lat + y / M_PER_DEG_LAT, lon: origin.lon + x / kx }),
  };
}

export function distanceM(a: LatLon, b: LatLon): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Closest point on a polyline to `target`, and its distance in metres. */
export function nearestOnLine(line: LatLon[], target: LatLon): { point: LatLon; distance: number } {
  const pj = projector(target);
  let best = { x: 0, y: 0, d2: Infinity };
  const pts = line.map(pj.to);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2));
    const x = a.x + t * dx;
    const y = a.y + t * dy;
    const d2 = x * x + y * y;
    if (d2 < best.d2) best = { x, y, d2 };
  }
  if (pts.length === 1) best = { x: pts[0]!.x, y: pts[0]!.y, d2: pts[0]!.x ** 2 + pts[0]!.y ** 2 };
  return { point: pj.from(best.x, best.y), distance: Math.sqrt(best.d2) };
}

/** Length (m) of the part of a polyline that lies within `radius` metres of `center`. */
export function lengthWithin(line: LatLon[], center: LatLon, radius: number): number {
  const pj = projector(center);
  const pts = line.map(pj.to);
  const r2 = radius * radius;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / 5));
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const x = a.x + t * (b.x - a.x);
      const y = a.y + t * (b.y - a.y);
      if (x * x + y * y <= r2) total += len / steps;
    }
  }
  return total;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/**
 * Compass name ("north", "south-west", …) of a kerb, so results can say
 * "east side" instead of OSM's direction-relative "right side".
 */
export function sideCompass(line: LatLon[], side: 'left' | 'right'): string {
  const first = line[0]!;
  const last = line[line.length - 1]!;
  const pj = projector(first);
  const end = pj.to(last);
  // Right-hand normal of the overall direction.
  let nx = end.y;
  let ny = -end.x;
  if (side === 'left') {
    nx = -nx;
    ny = -ny;
  }
  const bearing = (Math.atan2(nx, ny) * 180) / Math.PI; // 0 = north, clockwise
  const idx = Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  return COMPASS[idx]!;
}

export function lineLength(line: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += distanceM(line[i - 1]!, line[i]!);
  return total;
}

/** Cumulative distance (m) at each vertex. */
function cumulative(line: LatLon[]): number[] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1]! + distanceM(line[i - 1]!, line[i]!));
  return cum;
}

function interpolate(line: LatLon[], cum: number[], d: number): LatLon {
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < d) i++;
  const seg = cum[i]! - cum[i - 1]!;
  const t = seg === 0 ? 0 : Math.max(0, Math.min(1, (d - cum[i - 1]!) / seg));
  const a = line[i - 1]!;
  const b = line[i]!;
  return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
}

/** The part of a polyline between distances `d0` and `d1` (m) from its start. */
export function sliceLine(line: LatLon[], d0: number, d1: number, cum = cumulative(line)): LatLon[] {
  const piece = [interpolate(line, cum, d0)];
  for (let i = 1; i < line.length - 1; i++) if (cum[i]! > d0 && cum[i]! < d1) piece.push(line[i]!);
  piece.push(interpolate(line, cum, d1));
  return piece;
}

/**
 * Split a polyline into consecutive pieces of roughly equal length, none longer
 * than `maxLenM`, so a long street becomes several block-sized results.
 */
export function splitLine(line: LatLon[], maxLenM: number): LatLon[][] {
  if (line.length < 2) return [line];
  const cum = cumulative(line);
  const total = cum[cum.length - 1]!;
  const n = Math.max(1, Math.ceil(total / maxLenM - 1e-6));
  if (n === 1) return [line];
  return Array.from({ length: n }, (_, k) => sliceLine(line, (total * k) / n, (total * (k + 1)) / n, cum));
}

/**
 * Walk along a line in ~1 m steps and split it into runs where `classify`
 * returns the same value. Returns each run's range and value.
 */
export function runsAlong<T>(line: LatLon[], classify: (p: LatLon) => T, stepM = 1): { from: number; to: number; value: T }[] {
  const cum = cumulative(line);
  const total = cum[cum.length - 1]!;
  if (total === 0) return [];
  const steps = Math.max(1, Math.ceil(total / stepM));
  const runs: { from: number; to: number; value: T }[] = [];
  for (let k = 0; k < steps; k++) {
    const d0 = (total * k) / steps;
    const d1 = (total * (k + 1)) / steps;
    const value = classify(interpolate(line, cum, (d0 + d1) / 2));
    const last = runs[runs.length - 1];
    if (last && last.value === value) last.to = d1;
    else runs.push({ from: d0, to: d1, value });
  }
  return runs;
}

const SHORT_COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Short compass direction ("N", "SW", …) from `from` to `to`. */
export function directionTo(from: LatLon, to: LatLon): string {
  const pj = projector(from);
  const p = pj.to(to);
  const bearing = (Math.atan2(p.x, p.y) * 180) / Math.PI;
  return SHORT_COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;
}

/** The point halfway along a polyline (by length). */
export function midpoint(line: LatLon[]): LatLon {
  if (line.length < 2) return line[0]!;
  const pj = projector(line[0]!);
  const pts = line.map(pj.to);
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y));
  let remaining = lens.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lens.length; i++) {
    const len = lens[i]!;
    if (remaining <= len) {
      const t = len === 0 ? 0 : remaining / len;
      const a = pts[i]!;
      const b = pts[i + 1]!;
      return pj.from(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y));
    }
    remaining -= len;
  }
  return line[line.length - 1]!;
}
