import type { LatLon } from '../data/overpass';

export interface Place {
  label: string;
  location: LatLon;
}

/**
 * Forward geocoding with OSM Nominatim. The public instance allows at most
 * 1 request/second and no autocomplete-as-you-type, so we only call it on submit.
 * https://operations.osmfoundation.org/policies/nominatim/
 * For production, use a commercial or self-hosted geocoder.
 */
export async function geocode(query: string, opts: { signal?: AbortSignal } = {}): Promise<Place[]> {
  // UK only for now.
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', addressdetails: '0', countrycodes: 'gb' });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    signal: opts.signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Geocoder ${res.status}`);
  const json = (await res.json()) as { display_name: string; lat: string; lon: string }[];
  return json.map((r) => ({ label: r.display_name, location: { lat: Number(r.lat), lon: Number(r.lon) } }));
}
