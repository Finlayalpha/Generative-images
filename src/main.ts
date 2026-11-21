import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';

import { buildAroundQuery, fetchParking, type LatLon, type ParkingData } from './data/overpass';
import { DEMO_CENTER, DEMO_DATA } from './data/demo';
import { geocode } from './search/geocode';
import { evaluate, sortResults, type Place, type Result, type SortMode } from './search/rank';
import type { Assessment, Status } from './rules/engine';
import { directionTo } from './geo/measure';
import { formatMinutes } from './rules/duration';

const STATUS_STYLE: Record<Status, { color: string; label: string }> = {
  free: { color: '#16a34a', label: 'Free & legal for your stay' },
  time_limited: { color: '#d97706', label: 'Free, but max stay too short' },
  paid: { color: '#2563eb', label: 'Paid' },
  permit: { color: '#9333ea', label: 'Permit / residents / customers' },
  restricted: { color: '#dc2626', label: 'Not allowed during your stay' },
  no_parking: { color: '#7f1d1d', label: 'No parking' },
  unknown: { color: '#9ca3af', label: 'Not mapped' },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('search-form');
const qInput = $<HTMLInputElement>('q');
const arriveInput = $<HTMLInputElement>('arrive');
const stayInput = $<HTMLSelectElement>('stay');
const radiusInput = $<HTMLSelectElement>('radius');
const sortInput = $<HTMLSelectElement>('sort');
const statusEl = $<HTMLParagraphElement>('status');
const resultsEl = $<HTMLOListElement>('results');
const isDemo = new URLSearchParams(location.search).has('demo');

// ---------- state ----------
interface Destination {
  label: string;
  location: LatLon;
}
let destination: Destination | null = null;
let data: ParkingData | null = null;
let fetchedRadius = 0;
let inflight: AbortController | null = null;
const layersById = new Map<string, L.Path>();
const LIST_LIMIT = 15;
const PIN_LIMIT = 10;
let showAll = false;

// ---------- map ----------
const map = L.map('map', { zoomControl: false }).setView(
  isDemo ? [DEMO_CENTER.lat, DEMO_CENTER.lon] : [51.5074, -0.1278],
  isDemo ? 16 : 13,
);
L.control.zoom({ position: 'topright' }).addTo(map);
if (!isDemo) {
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
}
const placesLayer = L.layerGroup().addTo(map);
const destLayer = L.layerGroup().addTo(map);
const rankLayer = L.layerGroup().addTo(map);
const isPhone = () => window.matchMedia('(max-width: 640px)').matches;

/** Fit the map to bounds while keeping them clear of the panel / bottom sheet. */
function fitVisible(bounds: L.LatLngBounds) {
  const panel = $('panel').getBoundingClientRect();
  if (isPhone()) map.fitBounds(bounds, { paddingTopLeft: [12, 12], paddingBottomRight: [12, panel.height + 12] });
  else map.fitBounds(bounds, { paddingTopLeft: [panel.right + 12, 12], paddingBottomRight: [12, 12] });
}

// ---------- controls ----------
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
arriveInput.value = toLocalInputValue(new Date());

function stayWindow() {
  const start = arriveInput.value ? new Date(arriveInput.value) : new Date();
  return { start, minutes: Number(stayInput.value) };
}
const radius = () => Number(radiusInput.value);

const legend = $<HTMLUListElement>('legend');
for (const s of ['free', 'time_limited', 'paid', 'permit', 'restricted', 'no_parking'] as Status[]) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="swatch" style="background:${STATUS_STYLE[s].color}"></span>${STATUS_STYLE[s].label}`;
  legend.append(li);
}
const dashed = document.createElement('li');
dashed.innerHTML = '<span class="swatch dashed"></span>Dashed: fee not mapped, assumed free';
legend.append(dashed);

$<HTMLButtonElement>('collapse').addEventListener('click', (e) => togglePanel(e.currentTarget as HTMLButtonElement));
function togglePanel(btn: HTMLButtonElement, open = btn.getAttribute('aria-expanded') !== 'true') {
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? '▾' : '▸';
  $('panel-body').hidden = !open;
}

// ---------- formatting ----------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
const pct = (p: number) => `${Math.round(p * 100)}%`;
const metres = (m: number) => (m < 10 ? '<10 m' : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
/** Straight-line distance × 1.3 ≈ street walking distance, at ~80 m/min. */
const walkMin = (m: number) => Math.max(1, Math.round((m * 1.3) / 80));

function freeForText(a: Assessment): string | undefined {
  if (a.freeForMinutes === undefined || a.status === 'no_parking') return undefined;
  if (a.freeForMinutes >= 24 * 60) return 'Free & legal for 24h+ from arrival';
  if (a.freeForMinutes === 0) return 'Not free & legal at arrival time';
  return `Free & legal for ${formatMinutes(a.freeForMinutes)} from arrival`;
}

function popupHtml(p: Place, r?: Result): string {
  const a = p.assessment;
  const style = STATUS_STYLE[a.status];
  const lines = [freeForText(a), ...a.reasons].filter(Boolean) as string[];
  if (destination) lines.unshift(`${metres(p.distance)} from destination (~${walkMin(p.distance)} min walk)`);
  const chance = r
    ? `<div class="chance"><strong>${pct(r.likelihood.probability)}</strong> chance you can park here
        <small>rules correct ~${pct(r.likelihood.legal)} × space free ~${pct(r.likelihood.available)}
        (${r.likelihood.capacityKnown ? '' : '~'}${r.likelihood.capacity} spaces)</small></div>`
    : '';
  const raw = Object.entries(p.tags)
    .filter(([k]) => k.startsWith('parking') || ['fee', 'access', 'maxstay', 'opening_hours', 'name', 'highway', 'capacity'].includes(k.split(':')[0]!))
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  return `<div class="popup">
    <strong>${escapeHtml(p.name)}</strong>${p.detail ? ` <span class="muted">· ${escapeHtml(p.detail)}</span>` : ''}
    <div class="badge" style="background:${style.color}">${style.label}</div>
    ${chance}
    <ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    <div class="muted">Rule data confidence: ${a.confidence}</div>
    <details><summary>OSM tags</summary><table>${raw}</table></details>
    <a href="${p.osmUrl}" target="_blank" rel="noopener">View / fix on OpenStreetMap</a>
  </div>`;
}

// ---------- rendering ----------
function render() {
  placesLayer.clearLayers();
  rankLayer.clearLayers();
  layersById.clear();
  resultsEl.replaceChildren();
  if (!data || !destination) return;

  const { places, results } = evaluate(data, destination.location, radius(), stayWindow());
  const sorted = sortResults(results, sortInput.value as SortMode);
  const resultById = new Map(results.map((r) => [r.id, r]));

  for (const p of places) {
    const r = resultById.get(p.id);
    const color = STATUS_STYLE[p.assessment.status].color;
    const layer: L.Path =
      p.kind === 'kerb'
        ? L.polyline(p.geometry.map((g) => [g.lat, g.lon] as [number, number]), {
            color,
            weight: r ? 6 : 4,
            opacity: r ? 0.95 : 0.6,
            dashArray: p.assessment.confidence === 'high' ? undefined : '8 6',
          })
        : L.circleMarker([p.point.lat, p.point.lon], { radius: r ? 10 : 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 0.95 });
    layer.bindPopup(popupHtml(p, r), { autoPanPaddingTopLeft: L.point(12, 12) }).addTo(placesLayer);
    layersById.set(p.id, layer);
  }

  const shown = showAll ? sorted : sorted.slice(0, LIST_LIMIT);
  shown.forEach((r, i) => {
    resultsEl.append(resultItem(r, i + 1));
    if (i >= PIN_LIMIT) return;
    L.marker([r.labelPoint.lat, r.labelPoint.lon], {
      icon: L.divIcon({ className: 'rank-pin', html: String(i + 1), iconSize: [22, 22] }),
      title: `${i + 1}. ${r.name}`,
      zIndexOffset: 1000 - i,
    })
      .on('click', () => focusPlace(r))
      .addTo(rankLayer);
  });
  if (shown.length < sorted.length) {
    const li = document.createElement('li');
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'link';
    more.textContent = `Show all ${sorted.length} results`;
    more.addEventListener('click', () => {
      showAll = true;
      render();
    });
    li.append(more);
    resultsEl.append(li);
  }

  if (sorted.length === 0) {
    setStatus(
      places.length === 0
        ? `No parking rules are mapped within ${metres(radius())} of ${destination.label} yet. Try a larger radius, or help by mapping them on OpenStreetMap.`
        : `Nothing free & legal for this stay within ${metres(radius())}. Try a larger radius, a shorter stay or a different time.`,
    );
  } else {
    setStatus(`${sorted.length} free & legal option${sorted.length === 1 ? '' : 's'} near ${destination.label}${isDemo ? ' (synthetic demo data)' : ''}.`);
  }
}

function resultItem(r: Result, rank: number): HTMLLIElement {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'result';
  const notes: string[] = [];
  if (r.assessment.maxStayMinutes !== undefined) notes.push(`max ${formatMinutes(r.assessment.maxStayMinutes)}`);
  if (r.assessment.needsDisc) notes.push('disc');
  if (r.assessment.confidence !== 'high') notes.push(r.assessment.confidence === 'medium' ? 'fee not mapped' : 'check signs');
  if (r.kind === 'car_park') notes.unshift('car park');
  btn.innerHTML = `
    <span class="rank">${rank}</span>
    <span class="main">
      <span class="name">${escapeHtml(r.name)}${r.kind === 'kerb' ? ` <span class="muted">${escapeHtml(r.detail ?? '')}</span>` : ''}</span>
      <span class="meta">${metres(r.distance)}${r.distance >= 10 && destination ? ` ${directionTo(destination.location, r.point)}` : ''} · ~${walkMin(r.distance)} min walk${notes.length ? ` · ${escapeHtml(notes.join(' · '))}` : ''}</span>
    </span>
    <span class="prob" title="Estimated chance you can park here">
      <span class="pct">${pct(r.likelihood.probability)}</span>
      <span class="bar"><span style="width:${pct(r.likelihood.probability)}"></span></span>
    </span>`;
  btn.addEventListener('click', () => focusPlace(r));
  li.append(btn);
  return li;
}

function focusPlace(r: Result) {
  const layer = layersById.get(r.id);
  map.setView([r.labelPoint.lat, r.labelPoint.lon], Math.max(map.getZoom(), 17));
  layer?.openPopup([r.labelPoint.lat, r.labelPoint.lon]);
  if (isPhone()) togglePanel($<HTMLButtonElement>('collapse'), false);
}

function drawDestination() {
  destLayer.clearLayers();
  if (!destination) return;
  const { lat, lon } = destination.location;
  L.circle([lat, lon], { radius: radius(), color: '#0f766e', weight: 1, fillOpacity: 0.04, interactive: false }).addTo(destLayer);
  L.marker([lat, lon], { title: destination.label, icon: L.divIcon({ className: 'dest-pin', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 22] }) })
    .bindTooltip(destination.label)
    .addTo(destLayer);
}

/** On phones the controls fill the sheet; jump to the results after a search. */
function revealResults() {
  if (isPhone()) statusEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function setStatus(msg: string, busy = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('busy', busy);
}

// ---------- flow ----------
async function loadAround(dest: Destination) {
  destination = dest;
  showAll = false;
  drawDestination();
  const r = radius();
  const c = dest.location;
  fitVisible(L.latLng(c.lat, c.lon).toBounds(r * 2.2));

  if (isDemo) {
    data = DEMO_DATA;
    fetchedRadius = Infinity;
    render();
    revealResults();
    return;
  }

  inflight?.abort();
  const ctrl = (inflight = new AbortController());
  setStatus('Loading parking rules…', true);
  resultsEl.replaceChildren();
  placesLayer.clearLayers();
  rankLayer.clearLayers();
  try {
    data = await fetchParking(buildAroundQuery(c, r), ctrl.signal);
    fetchedRadius = r;
    render();
    revealResults();
  } catch (e) {
    if (!ctrl.signal.aborted) setStatus(`Couldn't load parking data: ${(e as Error).message}. Please try again.`);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = qInput.value.trim();
  if (!q) return;
  if (isDemo) {
    await loadAround({ label: q, location: DEMO_CENTER });
    return;
  }
  setStatus(`Finding “${q}”…`, true);
  try {
    const c = map.getCenter();
    const hits = await geocode(q, { near: { lat: c.lat, lon: c.lng } });
    const first = hits[0];
    if (!first) return setStatus(`Couldn't find “${q}”. Try adding a town or postcode.`);
    await loadAround({ label: first.label.split(',').slice(0, 2).join(',').trim(), location: first.location });
  } catch (err) {
    setStatus(`Search failed: ${(err as Error).message}`);
  }
});

$<HTMLButtonElement>('locate').addEventListener('click', () => {
  if (isDemo) return void loadAround({ label: 'your location', location: DEMO_CENTER });
  if (!navigator.geolocation) return setStatus('Location is not available in this browser.');
  setStatus('Finding you…', true);
  navigator.geolocation.getCurrentPosition(
    (pos) => loadAround({ label: 'your location', location: { lat: pos.coords.latitude, lon: pos.coords.longitude } }),
    (err) => setStatus(`Couldn't get your location: ${err.message}`),
    { enableHighAccuracy: true, timeout: 10_000 },
  );
});

radiusInput.addEventListener('change', () => {
  if (!destination) return;
  if (radius() > fetchedRadius) return void loadAround(destination);
  drawDestination();
  render();
});
for (const el of [arriveInput, stayInput, sortInput]) el.addEventListener('change', render);

setStatus(isDemo ? 'Demo mode: search any text to load synthetic streets.' : 'Enter where you are going to see free, legal parking nearby.');
