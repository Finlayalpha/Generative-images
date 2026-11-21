import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';

import { buildAroundQuery, fetchParking, type LatLon, type ParkingData } from './data/overpass';
import { fetchMarkings, formatImageDate } from './data/markings';
import { fetchCouncilData } from './councils';
import { DEMO_CENTER, DEMO_DATA } from './data/demo';
import { directionTo } from './geo/measure';
import { geocode } from './search/geocode';
import { evaluate, sortResults, type Place, type SortMode, type Tier } from './search/rank';
import type { Status } from './rules/engine';
import { formatMinutes } from './rules/duration';
import { DEFAULT_VEHICLE, formatHeight, PRESETS, type Vehicle } from './vehicle';

const STATUS_STYLE: Record<Status, { color: string; label: string }> = {
  free: { color: '#16a34a', label: 'Free & legal for your stay' },
  time_limited: { color: '#d97706', label: 'Free, but max stay too short' },
  paid: { color: '#2563eb', label: 'Paid' },
  permit: { color: '#9333ea', label: 'Permit / residents / customers' },
  restricted: { color: '#dc2626', label: 'Not allowed during your stay' },
  no_parking: { color: '#b91c1c', label: 'No parking' },
  unknown: { color: '#9ca3af', label: 'Not mapped' },
};
const TOO_BIG_COLOR = '#9ca3af';

const TIER_LABEL: Record<Tier, string> = {
  confirmed: 'Rules mapped',
  partial: 'Partly mapped',
  checked: 'Lines checked',
  unsurveyed: 'Unsurveyed',
};
const TIER_DASH: Record<Tier, string | undefined> = { confirmed: undefined, partial: '10 6', checked: '5 5', unsurveyed: '1 9' };

/** Tier label, with the photo date for imagery-checked places. */
function tierLabel(p: Place): string {
  if (p.source === 'council') return p.tier === 'confirmed' ? 'Council data' : 'Council data (partly read)';
  return p.tier === 'checked' && p.imageDate ? `${TIER_LABEL.checked} · ${formatImageDate(p.imageDate)}` : TIER_LABEL[p.tier];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('search-form');
const qInput = $<HTMLInputElement>('q');
const arriveInput = $<HTMLInputElement>('arrive');
const stayInput = $<HTMLSelectElement>('stay');
const radiusInput = $<HTMLSelectElement>('radius');
const sortInput = $<HTMLSelectElement>('sort');
const unsurveyedInput = $<HTMLInputElement>('unsurveyed');
const statusEl = $<HTMLParagraphElement>('status');
const resultsEl = $<HTMLOListElement>('results');
const sheet = $('sheet');
const grabber = $<HTMLButtonElement>('grabber');
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
const LIST_LIMIT = 20;
const PIN_LIMIT = 10;
let showAll = false;

// ---------- vehicle (remembered on this device) ----------
type StoredVehicle = Vehicle & { preset: string };
const VEHICLE_KEY = 'fpf.vehicle';
function loadVehicle(): StoredVehicle {
  try {
    const v = JSON.parse(localStorage.getItem(VEHICLE_KEY) ?? 'null');
    if (v && [v.length, v.width, v.height].every((n: unknown) => typeof n === 'number' && n > 0)) return v;
  } catch {
    /* storage unavailable */
  }
  return { length: DEFAULT_VEHICLE.length, width: DEFAULT_VEHICLE.width, height: DEFAULT_VEHICLE.height, preset: 'hatch' };
}
let vehicle = loadVehicle();
function saveVehicle() {
  try {
    localStorage.setItem(VEHICLE_KEY, JSON.stringify(vehicle));
  } catch {
    /* storage unavailable */
  }
}

const presetInput = $<HTMLSelectElement>('preset');
const vInputs = { length: $<HTMLInputElement>('v-length'), width: $<HTMLInputElement>('v-width'), height: $<HTMLInputElement>('v-height') };
for (const p of PRESETS) presetInput.add(new Option(p.label, p.id));
presetInput.add(new Option('Custom', 'custom'));

function showVehicle() {
  presetInput.value = vehicle.preset;
  for (const k of ['length', 'width', 'height'] as const) vInputs[k].value = String(vehicle[k]);
  const name = PRESETS.find((p) => p.id === vehicle.preset)?.label ?? 'Custom';
  $('vehicle-summary').textContent = `${name} · ${vehicle.length} × ${vehicle.width} m · ${formatHeight(vehicle.height)} high`;
}
presetInput.addEventListener('change', () => {
  const p = PRESETS.find((x) => x.id === presetInput.value);
  vehicle = p ? { length: p.length, width: p.width, height: p.height, preset: p.id } : { ...vehicle, preset: 'custom' };
  saveVehicle();
  showVehicle();
  render();
});
for (const k of ['length', 'width', 'height'] as const) {
  vInputs[k].addEventListener('change', () => {
    const n = Number(vInputs[k].value);
    if (n > 0) {
      vehicle = { ...vehicle, [k]: n, preset: 'custom' };
      saveVehicle();
    }
    showVehicle();
    render();
  });
}
showVehicle();

// ---------- map ----------
const map = L.map('map', { zoomControl: false }).setView(isDemo ? [DEMO_CENTER.lat, DEMO_CENTER.lon] : [54.3, -2.5], isDemo ? 16 : 6);
if (!isDemo) {
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
}
map.attributionControl.setPosition('topright');
const placesLayer = L.layerGroup().addTo(map);
const destLayer = L.layerGroup().addTo(map);
const rankLayer = L.layerGroup().addTo(map);

/** Fit the map to bounds, keeping them clear of the bottom sheet. */
function fitVisible(bounds: L.LatLngBounds) {
  const h = sheet.getBoundingClientRect().height;
  map.fitBounds(bounds, { paddingTopLeft: [8, 8], paddingBottomRight: [8, h + 8] });
}

/** Show the whole search area in whatever space the sheet leaves. */
function fitSearchArea() {
  if (!destination) return;
  const c = destination.location;
  fitVisible(L.latLng(c.lat, c.lon).toBounds(radius() * 2.1));
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
const legendItems: [string, string][] = [
  ...(['free', 'time_limited', 'paid', 'permit', 'restricted', 'no_parking'] as Status[]).map(
    (s) => [`<span class="swatch" style="background:${STATUS_STYLE[s].color}"></span>`, STATUS_STYLE[s].label] as [string, string],
  ),
  [`<span class="swatch" style="background:${TOO_BIG_COLOR}"></span>`, 'Free, but your vehicle won’t fit'],
  ['<span class="swatch dashed"></span>', 'Partly mapped (e.g. fee not recorded)'],
  ['<span class="swatch short-dashed"></span>', 'Lines checked: no yellow lines in the aerial photo'],
  ['<span class="swatch dotted"></span>', 'Unsurveyed: national rules only'],
];
for (const [sw, label] of legendItems) {
  const li = document.createElement('li');
  li.innerHTML = `${sw}${label}`;
  legend.append(li);
}

function setSheetOpen(open: boolean) {
  grabber.setAttribute('aria-expanded', String(open));
  sheet.classList.toggle('collapsed', !open);
}
grabber.addEventListener('click', () => {
  const open = grabber.getAttribute('aria-expanded') !== 'true';
  setSheetOpen(open);
  if (!open) fitSearchArea(); // more room for the map now
});

// ---------- formatting ----------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
const metres = (m: number) => (m < 10 ? '<10 m' : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
/** Straight-line distance × 1.3 ≈ street walking distance, at ~80 m/min. */
const walkMin = (m: number) => Math.max(1, Math.round((m * 1.3) / 80));

/** Does the stay include night hours (for the Highway Code 248 reminder)? */
function staysOvernight(): boolean {
  const { start, minutes } = stayWindow();
  for (let m = 0; m <= minutes; m += 30) {
    const h = new Date(start.getTime() + m * 60_000).getHours();
    if (h >= 22 || h < 6) return true;
  }
  return false;
}

function popupHtml(p: Place): string {
  const a = p.assessment;
  const tooBig = p.fit.verdict === 'too_big' && a.status === 'free';
  const badge = tooBig ? { color: TOO_BIG_COLOR, label: 'Your vehicle won’t fit' } : STATUS_STYLE[a.status];
  const lines: string[] = [];
  if (destination) lines.push(`${metres(p.distance)} from destination (~${walkMin(p.distance)} min walk)`);
  if (a.status !== 'no_parking' && a.freeForMinutes !== undefined) {
    lines.push(
      a.freeForMinutes >= 24 * 60
        ? 'Free & legal for 24h+ from arrival'
        : a.freeForMinutes === 0
          ? 'Not free & legal when you arrive'
          : `Free & legal for ${formatMinutes(a.freeForMinutes)} from arrival`,
    );
  }
  lines.push(...a.reasons, ...p.fit.notes);
  if (p.kind === 'kerb' && a.status === 'free' && staysOvernight()) {
    lines.push('At night, park facing the direction of traffic (Highway Code 248)');
  }
  const raw = Object.entries(p.tags)
    .filter(([k]) => /^(parking|fee|access|maxstay|maxheight|maxwidth|maxlength|width|opening_hours|name|highway|cycleway|busway|overtaking|capacity)/.test(k))
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  return `<div class="popup">
    <strong>${escapeHtml(p.name)}</strong>${p.detail ? ` <span class="muted">· ${escapeHtml(p.detail)}</span>` : ''}
    <div class="badges"><span class="badge" style="background:${badge.color}">${badge.label}</span>
      <span class="chip tier tier-${p.tier}">${escapeHtml(tierLabel(p))}</span></div>
    <ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    ${raw ? `<details><summary>OSM tags</summary><table>${raw}</table></details>` : ''}
    ${p.bay ? `<div class="muted">Source: council open data, bay ${escapeHtml(p.bay.id)}${p.zone ? `, zone ${escapeHtml(p.zone)}` : ''}</div>` : ''}
    ${p.osmUrl ? `<a href="${p.osmUrl}" target="_blank" rel="noopener">View / fix on OpenStreetMap</a>` : ''}
  </div>`;
}

// ---------- rendering ----------
function showAttribution() {
  const el = $('attribution');
  const lines = data?.council?.councils.map((c) => c.attribution) ?? [];
  el.textContent = lines.join('. ');
  el.hidden = lines.length === 0;
}

function render() {
  showAttribution();
  placesLayer.clearLayers();
  rankLayer.clearLayers();
  layersById.clear();
  resultsEl.replaceChildren();
  if (!data || !destination) return;

  const { places, results } = evaluate(data, {
    destination: destination.location,
    radiusM: radius(),
    stay: stayWindow(),
    vehicle,
    includeUnsurveyed: unsurveyedInput.checked,
  });
  const sorted = sortResults(results, sortInput.value as SortMode);
  const resultIds = new Set(results.map((r) => r.id));

  for (const p of places) {
    const isResult = resultIds.has(p.id);
    const tooBig = p.fit.verdict === 'too_big' && p.assessment.status === 'free';
    const color = tooBig ? TOO_BIG_COLOR : STATUS_STYLE[p.assessment.status].color;
    const layer: L.Path =
      p.kind === 'kerb'
        ? L.polyline(p.geometry.map((g) => [g.lat, g.lon] as [number, number]), {
            color,
            weight: isResult ? 6 : 4,
            opacity: isResult ? 0.95 : 0.55,
            lineCap: p.tier === 'unsurveyed' ? 'round' : 'butt',
            dashArray: p.assessment.status === 'free' ? TIER_DASH[p.tier] : undefined,
          })
        : L.circleMarker([p.point.lat, p.point.lon], { radius: isResult ? 10 : 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 0.95 });
    layer.bindPopup(popupHtml(p), { autoPanPaddingTopLeft: L.point(12, 40), autoPanPaddingBottomRight: L.point(12, 12) }).addTo(placesLayer);
    layersById.set(p.id, layer);
  }

  const shown = showAll ? sorted : sorted.slice(0, LIST_LIMIT);
  shown.forEach((r, i) => {
    resultsEl.append(resultItem(r, i + 1));
    if (i >= PIN_LIMIT) return;
    L.marker([r.labelPoint.lat, r.labelPoint.lon], {
      icon: L.divIcon({ className: `rank-pin tier-${r.tier}`, html: String(i + 1), iconSize: [24, 24] }),
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

  const hidden = places.filter((p) => p.assessment.status === 'free' && p.fit.verdict === 'too_big' && p.distance <= radius()).length;
  const sizeNote = hidden ? ` ${hidden} more hidden because your vehicle won’t fit.` : '';
  if (sorted.length === 0) {
    setStatus(
      places.length === 0
        ? `No streets found within ${metres(radius())} of ${destination.label}. Try a larger radius.`
        : `Nothing free & legal for this stay within ${metres(radius())}.${sizeNote} Try a larger radius, a shorter stay or another time.`,
    );
  } else {
    setStatus(`${sorted.length} free & legal place${sorted.length === 1 ? '' : 's'} near ${destination.label}.${sizeNote}${isDemo ? ' (Synthetic demo town.)' : ''}`);
  }
}

function resultItem(r: Place, rank: number): HTMLLIElement {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `result tier-${r.tier}`;
  const chips: string[] = [];
  if (r.kind === 'car_park') chips.push('<span class="chip">Car park</span>');
  chips.push(`<span class="chip tier tier-${r.tier}">${escapeHtml(tierLabel(r))}</span>`);
  if (r.assessment.maxStayMinutes !== undefined) chips.push(`<span class="chip">Max ${formatMinutes(r.assessment.maxStayMinutes)}</span>`);
  if (r.assessment.needsDisc) chips.push('<span class="chip">Disc</span>');
  if (r.fit.verdict === 'check') chips.push('<span class="chip warn">Check size</span>');
  const dir = r.distance >= 10 && destination ? ` ${directionTo(destination.location, r.point)}` : '';
  btn.innerHTML = `
    <span class="rank">${rank}</span>
    <span class="main">
      <span class="name">${escapeHtml(r.name)}${r.kind === 'kerb' ? ` <span class="muted">${escapeHtml(r.detail ?? '')}</span>` : ''}</span>
      <span class="meta">${metres(r.distance)}${dir} · ~${walkMin(r.distance)} min walk</span>
      <span class="chips">${chips.join('')}</span>
    </span>`;
  btn.addEventListener('click', () => focusPlace(r));
  li.append(btn);
  return li;
}

function focusPlace(r: Place) {
  setSheetOpen(false);
  map.setView([r.labelPoint.lat, r.labelPoint.lon], Math.max(map.getZoom(), 17));
  layersById.get(r.id)?.openPopup([r.labelPoint.lat, r.labelPoint.lon]);
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

function setStatus(msg: string, busy = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('busy', busy);
}

/** The controls fill the sheet; jump to the results after a search. */
function revealResults() {
  statusEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ---------- flow ----------
async function loadAround(dest: Destination) {
  destination = dest;
  showAll = false;
  setSheetOpen(true);
  drawDestination();
  const r = radius();
  const c = dest.location;
  fitSearchArea();

  if (isDemo) {
    data = DEMO_DATA;
    fetchedRadius = Infinity;
    render();
    revealResults();
    return;
  }

  inflight?.abort();
  const ctrl = (inflight = new AbortController());
  setStatus('Loading streets and parking rules…', true);
  resultsEl.replaceChildren();
  placesLayer.clearLayers();
  rankLayer.clearLayers();
  try {
    // Aerial-imagery markings and council data are optional: if those services fail, carry on without them.
    const [parking, markings, council] = await Promise.all([
      fetchParking(buildAroundQuery(c, r), ctrl.signal),
      fetchMarkings(c, r, ctrl.signal).catch(() => []),
      fetchCouncilData(c, r, ctrl.signal),
    ]);
    data = { ...parking, markings, council };
    fetchedRadius = r;
    render();
    revealResults();
  } catch (e) {
    if (!ctrl.signal.aborted) setStatus(`Couldn't load map data: ${(e as Error).message}. Please try again.`);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  qInput.blur(); // close the phone keyboard
  const q = qInput.value.trim();
  if (!q) return;
  if (isDemo) return void loadAround({ label: q, location: DEMO_CENTER });
  setStatus(`Finding “${q}”…`, true);
  try {
    const hits = await geocode(q);
    const first = hits[0];
    if (!first) return setStatus(`Couldn't find “${q}” in the UK. Try adding a town or postcode.`);
    await loadAround({ label: first.label.split(',').slice(0, 2).join(',').trim(), location: first.location });
  } catch (err) {
    setStatus(`Search failed: ${(err as Error).message}`);
  }
});

$<HTMLButtonElement>('locate').addEventListener('click', () => {
  if (isDemo) return void loadAround({ label: 'your location', location: DEMO_CENTER });
  if (!navigator.geolocation) return setStatus('Location is not available on this device.');
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
for (const el of [arriveInput, stayInput, sortInput, unsurveyedInput]) el.addEventListener('change', render);

setStatus(isDemo ? 'Demo mode: search any text to load the synthetic demo town.' : 'Enter where you’re going to see free, legal parking nearby.');

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
