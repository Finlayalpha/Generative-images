import type { LatLon } from '../data/overpass';

const M_PER_DEG_LAT = 111_320;

/**
 * Offset a polyline sideways by `meters` (positive = right of travel direction),
 * so the left and right kerbs of a street can be drawn separately.
 * Uses a local equirectangular projection — fine at street scale.
 */
export function offsetLine(points: LatLon[], meters: number): LatLon[] {
  if (points.length < 2) return points;
  const lat0 = points[0]!.lat;
  const kx = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const xy = points.map((p) => ({ x: p.lon * kx, y: p.lat * M_PER_DEG_LAT }));

  // Unit right-hand normal of each segment.
  const normals = xy.slice(0, -1).map((a, i) => {
    const b = xy[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dy / len, y: -dx / len };
  });

  return xy.map((p, i) => {
    const n0 = normals[Math.max(0, i - 1)]!;
    const n1 = normals[Math.min(normals.length - 1, i)]!;
    let nx = n0.x + n1.x;
    let ny = n0.y + n1.y;
    const len = Math.hypot(nx, ny);
    if (len < 1e-9) {
      nx = n1.x;
      ny = n1.y;
    } else {
      // Miter: scale so the offset distance is preserved at corners, clamped for sharp turns.
      const cos = (nx * n1.x + ny * n1.y) / len;
      const scale = 1 / Math.max(cos, 0.5);
      nx = (nx / len) * scale;
      ny = (ny / len) * scale;
    }
    return { lat: (p.y + ny * meters) / M_PER_DEG_LAT, lon: (p.x + nx * meters) / kx };
  });
}
