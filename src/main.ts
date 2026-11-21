import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';

import { fetchParking, type ParkingData, type BBox } from './data/overpass';
import { DEMO_CENTER, DEMO_DATA } from './data/demo';
import { offsetLine } from './geo/offset';
import { assessCarPark, assessStreetSide, type Assessment, type Side, type Status, type Tags } from './rules/engine';
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

const MIN_SEARCH_ZOOM = 15;
const KERB_OFFSET_M = 4;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const arriveInput = $<HTMLInputElement>('arrive');
const stayInput = $<HTMLSelectElement>('stay');
const onlyFree = $<HTMLInputElement>('only-free');
const statusEl = $<HTMLParagraphElement>('status');
const searchBtn = $<HTMLButtonElement>('search');
const isDemo = new URLSearchParams(location.search).has('demo');

// ---------- map ----------
const map = L.map('map', { zoomControl: false }).setView(
  isDemo ? [DEMO_CENTER.lat, DEMO_CENTER.lon] : [51.5074, -0.1278],
  16,
);
L.control.zoom({ position: 'bottomright' }).addTo(map);
if (!isDemo) {
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
}
const layer = L.layerGroup().addTo(map);

let data: ParkingData | null = null;
let inflight: AbortController | null = null;

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

const legend = $<HTMLUListElement>('legend');
for (const s of ['free', 'time_limited', 'paid', 'permit', 'restricted', 'no_parking'] as Status[]) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="swatch" style="background:${STATUS_STYLE[s].color}"></span>${STATUS_STYLE[s].label}`;
  legend.append(li);
}

$<HTMLButtonElement>('collapse').addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? '▾' : '▸';
  $('panel-body').hidden = !open;
});

// ---------- rendering ----------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function popupHtml(title: string, a: Assessment, tags: Tags, osmUrl: string): string {
  const style = STATUS_STYLE[a.status];
  const lines: string[] = [];
  if (a.freeForMinutes !== undefined && a.status !== 'no_parking') {
    lines.push(
      a.freeForMinutes >= 24 * 60
        ? 'Free & legal for 24h+ from arrival'
        : a.freeForMinutes === 0
          ? 'Not free & legal at arrival time'
          : `Free & legal for ${formatMinutes(a.freeForMinutes)} from arrival`,
    );
  }
  lines.push(...a.reasons);
  const raw = Object.entries(tags)
    .filter(([k]) => k.startsWith('parking') || ['fee', 'access', 'maxstay', 'opening_hours', 'name', 'highway'].includes(k.split(':')[0]!))
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  return `<div class="popup">
    <strong>${escapeHtml(title)}</strong>
    <div class="badge" style="background:${style.color}">${style.label}</div>
    <div class="conf">Data confidence: ${a.confidence}</div>
    <ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    <details><summary>OSM tags</summary><table>${raw}</table></details>
    <a href="${osmUrl}" target="_blank" rel="noopener">View / fix on OpenStreetMap</a>
  </div>`;
}

function render() {
  layer.clearLayers();
  if (!data) return;
  const stay = stayWindow();
  const counts: Partial<Record<Status, number>> = {};

  for (const way of data.streets) {
    for (const side of ['left', 'right'] as Side[]) {
      const a = assessStreetSide(way.tags, side, stay);
      if (a.status === 'unknown') continue;
      if (a.status === 'no_parking' && way.tags[`parking:${side}`] === 'separate') continue;
      counts[a.status] = (counts[a.status] ?? 0) + 1;
      if (onlyFree.checked && a.status !== 'free') continue;
      const geom = offsetLine(way.geometry, side === 'right' ? KERB_OFFSET_M : -KERB_OFFSET_M);
      const name = way.tags['name'] ?? 'Unnamed street';
      L.polyline(
        geom.map((p) => [p.lat, p.lon] as [number, number]),
        {
          color: STATUS_STYLE[a.status].color,
          weight: 5,
          opacity: a.confidence === 'low' ? 0.55 : 0.9,
          dashArray: a.confidence === 'high' ? undefined : '8 6',
        },
      )
        .bindPopup(popupHtml(`${name} (${side} side)`, a, way.tags, `https://www.openstreetmap.org/way/${way.id}`))
        .addTo(layer);
    }
  }

  for (const cp of data.carParks) {
    const a = assessCarPark(cp.tags, stay);
    counts[a.status] = (counts[a.status] ?? 0) + 1;
    if (onlyFree.checked && a.status !== 'free') continue;
    L.circleMarker([cp.center.lat, cp.center.lon], {
      radius: 9,
      color: '#fff',
      weight: 2,
      fillColor: STATUS_STYLE[a.status].color,
      fillOpacity: 0.95,
    })
      .bindPopup(popupHtml(cp.tags['name'] ?? 'Car park', a, cp.tags, `https://www.openstreetmap.org/${cp.type}/${cp.id}`))
      .addTo(layer);
  }

  const free = counts.free ?? 0;
  const total = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);
  setStatus(
    total === 0
      ? 'No mapped parking regulations here yet. Try a city centre, or add them on OpenStreetMap.'
      : `${free} free & legal of ${total} mapped kerbs/car parks for this stay.${isDemo ? ' (Synthetic demo data.)' : ''}`,
  );
}

function setStatus(msg: string, busy = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('busy', busy);
}

// ---------- data ----------
async function search() {
  if (isDemo) {
    data = DEMO_DATA;
    render();
    return;
  }
  if (map.getZoom() < MIN_SEARCH_ZOOM) {
    setStatus('Zoom in a bit further to search (street level).');
    return;
  }
  inflight?.abort();
  inflight = new AbortController();
  const b = map.getBounds();
  const bbox: BBox = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  setStatus('Loading parking regulations…', true);
  searchBtn.disabled = true;
  try {
    data = await fetchParking(bbox, inflight.signal);
    render();
  } catch (e) {
    if ((e as Error).name !== 'AbortError') setStatus(`Couldn't load data: ${(e as Error).message}`);
  } finally {
    searchBtn.disabled = false;
  }
}

searchBtn.addEventListener('click', search);
arriveInput.addEventListener('change', render);
stayInput.addEventListener('change', render);
onlyFree.addEventListener('change', render);

$<HTMLButtonElement>('locate').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('Location is not available in this browser.');
  setStatus('Finding you…', true);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      map.setView([pos.coords.latitude, pos.coords.longitude], 17);
      L.circleMarker([pos.coords.latitude, pos.coords.longitude], { radius: 6, color: '#0f766e', fillOpacity: 1 }).addTo(map);
      search();
    },
    (err) => setStatus(`Couldn't get your location: ${err.message}`),
    { enableHighAccuracy: true, timeout: 10_000 },
  );
});

if (isDemo) search();
else setStatus('Pan to an area and press “Search this area”, or use “Locate me”.');
