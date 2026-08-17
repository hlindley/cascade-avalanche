import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs';
import {CLUSTER_ORDER,CLUSTERS,ALL_OBS,OBS_FC,PATH_FC,CLUSTER_FC,rad} from './photo-modes-v13-data.js';

const $ = (id) => document.getElementById(id);
const NTA_URL = "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/NYC_Neighborhood_Tabulation_Areas_2020/FeatureServer/0/query?where=BoroName%3D%27Manhattan%27&outFields=NTA2020%2CNTAName%2CNTAAbbrev&returnGeometry=true&outSR=4326&f=geojson";
const NONE = '__none__';
const style = {
  version: 8,
  light: { anchor: 'viewport', color: '#eef6ff', intensity: 0.88, position: [1.35, 215, 34] },
  sources: { osm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#04080d' } },
    { id: 'roads', type: 'line', source: 'osm', 'source-layer': 'transportation', paint: { 'line-color': '#4b5968', 'line-opacity': 0.66, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.35, 16, 2.05] } },
    { id: 'buildings', type: 'fill-extrusion', source: 'osm', 'source-layer': 'building', minzoom: 12.4, paint: { 'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#121a22', 18, '#202b36', 55, '#394858', 120, '#657383', 260, '#a5b0ba'], 'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 12.4, 0, 14, ['*', ['coalesce', ['get', 'render_height'], 8], 0.83]], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.90, 'fill-extrusion-vertical-gradient': true } }
  ]
};

const clusterButtons = { flatiron: $('cluster-flatiron'), noho: $('cluster-noho'), central: $('cluster-central') };
const modeButtons = { world: $('world'), cluster: $('clusterMode'), pov: $('pov'), photo: $('photoBtn') };
let map, ready = false, mode = 'world', currentClusterId = null, currentObsIndex = 0, pendingClusterId = null, pendingObsIndex = 0;
let captureMarker, photoPlaneMarker, journeyToken = 0, journeying = false, currentArea = '', introTimer = null, introDone = false, photoVisible = false;
const lastIndex = { flatiron: 0, noho: 0, central: 0 };
const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const JOURNEY_DURATION = { lift: 3400, cruise: 5000, arrival: 2600, settle: 3400 };

function active(group, key) { Object.entries(group).forEach(([id, element]) => element.classList.toggle('active', id === key)); }
function displayClusterId() { return pendingClusterId || currentClusterId; }
function displayObsIndex() { return pendingClusterId ? pendingObsIndex : currentObsIndex; }
function getObs(clusterId = currentClusterId, index = currentObsIndex) { return clusterId ? CLUSTERS[clusterId].observations[index] : null; }

function renderDots() {
  const container = $('dots');
  container.innerHTML = '';
  const clusterId = displayClusterId();
  if (!clusterId) return;
  const cluster = CLUSTERS[clusterId], selectedIndex = displayObsIndex();
  cluster.observations.forEach((obs, index) => {
    const button = document.createElement('button');
    button.className = `dot${index === selectedIndex ? ' active' : ''}${index < selectedIndex ? ' visited' : ''}`;
    button.setAttribute('aria-label', `${index + 1}: ${obs.title}`);
    button.onclick = () => selectObservation(index);
    container.appendChild(button);
  });
}

function renderUI(extra = '') {
  const clusterId = displayClusterId(), index = displayObsIndex();
  active(clusterButtons, clusterId);
  active(modeButtons, mode === 'journey' ? null : mode);
  modeButtons.photo.disabled = mode !== 'pov';
  modeButtons.photo.setAttribute('aria-disabled', String(mode !== 'pov'));
  if (!clusterId) {
    $('info').innerHTML = `<b>NYC Saturday · World view</b><span>${extra || '12 photos grouped into 3 spatial clusters.'}</span>`;
    $('pose').textContent = 'WORLD';
    $('observationTitle').textContent = 'Trip overview';
    $('observationMeta').textContent = '12 photos · 3 clusters';
    $('prevObservation').disabled = true;
    $('nextObservation').disabled = false;
    renderDots();
    return;
  }
  const cluster = CLUSTERS[clusterId], obs = cluster.observations[index];
  $('info').innerHTML = `<b>${cluster.name} · ${obs.time}</b><span>${extra || obs.title}</span>`;
  $('pose').textContent = mode === 'journey' ? (currentArea ? `AREA · ${currentArea}` : 'TRANSIT') : mode.toUpperCase();
  $('observationTitle').textContent = obs.title;
  $('observationMeta').textContent = `${index + 1} of ${cluster.observations.length} · ${obs.time}`;
  $('prevObservation').disabled = journeying || (index === 0 && CLUSTER_ORDER.indexOf(clusterId) === 0);
  $('nextObservation').disabled = journeying || (index === cluster.observations.length - 1 && CLUSTER_ORDER.indexOf(clusterId) === CLUSTER_ORDER.length - 1);
  renderDots();
}

function cancelIntro() { if (introTimer) { clearTimeout(introTimer); introTimer = null; } introDone = true; }
function cut(on) { if (ready && map.getLayer('buildings')) map.setPaintProperty('buildings', 'fill-extrusion-opacity', on ? 0.36 : 0.90); }
function sceneMarkers(on) { if (!captureMarker || !photoPlaneMarker) return; captureMarker.getElement().style.display = on ? 'block' : 'none'; photoPlaneMarker.getElement().style.display = on ? 'block' : 'none'; }
function setMarkerObservation(obs) { captureMarker.setLngLat(obs.coord); photoPlaneMarker.setLngLat(obs.subject); }

function setSpatialState(clusterId, obsId, level = 'world') {
  if (!ready || !map.getLayer('obs-all')) return;
  map.setFilter('cluster-path-active', ['==', ['get', 'cluster'], clusterId || NONE]);
  map.setFilter('obs-cluster', ['==', ['get', 'cluster'], clusterId || NONE]);
  map.setFilter('obs-current', ['==', ['get', 'id'], obsId || NONE]);
  const world = level === 'world', cluster = level === 'cluster';
  map.setPaintProperty('obs-all', 'circle-opacity', world ? 0.05 : cluster ? 0.28 : 0.10);
  map.setPaintProperty('cluster-fields', 'circle-opacity', world ? 0.32 : cluster ? 0.10 : 0.025);
  map.setPaintProperty('cluster-fields', 'circle-stroke-opacity', world ? 0.85 : cluster ? 0.24 : 0.05);
  map.setPaintProperty('cluster-labels', 'text-opacity', world ? 0.95 : cluster ? 0.22 : 0.04);
}

function neighborhoodOpacity(amount) {
  if (!ready || !map.getLayer('nta-lines')) return;
  map.setPaintProperty('nta-fill', 'fill-opacity', 0.055 * amount);
  map.setPaintProperty('nta-lines', 'line-opacity', 0.65 * amount);
  map.setPaintProperty('nta-labels', 'text-opacity', 0.9 * amount);
  map.setPaintProperty('nta-active-line', 'line-opacity', amount);
}

function updateAreaUnderCenter() {
  if (!journeying || !map.getLayer('nta-fill')) return;
  const canvas = map.getCanvas();
  const features = map.queryRenderedFeatures([canvas.clientWidth / 2, canvas.clientHeight / 2], { layers: ['nta-fill'] });
  const name = features[0]?.properties?.NTAName || '';
  if (name !== currentArea) {
    currentArea = name;
    map.setFilter('nta-active-line', name ? ['==', ['get', 'NTAName'], name] : ['==', ['get', 'NTAName'], NONE]);
    renderUI();
  }
}

function boundsForObservations(observations, fallbackDelta = 0.0018) {
  const first = observations[0].coord;
  const bounds = new maplibregl.LngLatBounds(first, first);
  observations.forEach((obs) => bounds.extend(obs.coord));
  if (observations.length === 1) {
    bounds.extend([first[0] - fallbackDelta, first[1] - fallbackDelta]);
    bounds.extend([first[0] + fallbackDelta, first[1] + fallbackDelta]);
  }
  return bounds;
}

function worldCamera() {
  const bounds = boundsForObservations(ALL_OBS, 0.003), fallback = { center: [-73.9825, 40.74845], zoom: 12.3 };
  let camera = fallback;
  try { camera = map.cameraForBounds(bounds, { padding: { top: 135, bottom: 280, left: 36, right: 36 }, maxZoom: 13.05 }) || fallback; } catch {}
  return { center: camera.center, zoom: camera.zoom, pitch: 58, bearing: -27 };
}

function clusterCamera(clusterId) {
  const cluster = CLUSTERS[clusterId], bounds = boundsForObservations(cluster.observations, 0.00135);
  const fallback = { center: cluster.center, zoom: cluster.observations.length === 1 ? 16.8 : 15.9 };
  let camera = fallback;
  try { camera = map.cameraForBounds(bounds, { padding: { top: 125, bottom: 285, left: 44, right: 44 }, maxZoom: 17.1 }) || fallback; } catch {}
  return { center: camera.center, zoom: camera.zoom, pitch: 62, bearing: -24 };
}

function showWorld(animate = true) {
  cancelIntro(); ++journeyToken; map?.stop(); journeying = false; pendingClusterId = null; currentArea = ''; currentClusterId = null; mode = 'world'; photoVisible = false;
  document.body.classList.remove('journeying'); cut(false); sceneMarkers(false); neighborhoodOpacity(0); setSpatialState(null, null, 'world');
  const camera = worldCamera();
  map[animate ? 'easeTo' : 'jumpTo']({ ...camera, duration: animate ? 1800 : 0, easing: easeInOut, essential: true });
  renderUI();
}

function animateNeighborhoodOpacity(from, to, duration, token) {
  const started = performance.now();
  function tick(now) { if (token !== journeyToken) return; const t = Math.min(1, (now - started) / duration); neighborhoodOpacity(from + (to - from) * easeInOut(t)); if (t < 1) requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
}

async function stage(options, duration, token, opacityFrom = null, opacityTo = null) {
  if (token !== journeyToken) return false;
  if (opacityFrom !== null && opacityTo !== null) animateNeighborhoodOpacity(opacityFrom, opacityTo, duration, token);
  map.easeTo({ ...options, duration, easing: easeInOut, essential: true, freezeElevation: true });
  await sleep(duration + 45);
  return token === journeyToken;
}

function bearingBetween(a, b) {
  const lon1 = rad(a[0]), lon2 = rad(b[0]), lat1 = rad(a[1]), lat2 = rad(b[1]);
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2), x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

async function enterClusterFromWorld(clusterId, automatic = false) {
  if (!ready) return;
  if (!automatic) cancelIntro();
  const token = ++journeyToken;
  map.stop(); journeying = true; document.body.classList.add('journeying'); pendingClusterId = clusterId; pendingObsIndex = lastIndex[clusterId] || 0; mode = 'journey';
  const cluster = CLUSTERS[clusterId], targetCamera = clusterCamera(clusterId);
  cut(false); sceneMarkers(false); setSpatialState(null, null, 'world'); renderUI(`Entering ${cluster.name}…`);
  if (!await stage({ center: cluster.center, zoom: 15.2, pitch: 58, bearing: -24 }, 2200, token, 0, 0.50)) return;
  setSpatialState(clusterId, cluster.observations[pendingObsIndex].id, 'cluster');
  renderUI(`Resolving ${cluster.observations.length} photo location${cluster.observations.length === 1 ? '' : 's'}…`);
  if (!await stage(targetCamera, 2600, token, 0.50, 0)) return;
  currentClusterId = clusterId; currentObsIndex = pendingObsIndex; pendingClusterId = null; mode = 'cluster'; journeying = false; document.body.classList.remove('journeying');
  setMarkerObservation(getObs()); cut(false); sceneMarkers(false); setSpatialState(currentClusterId, getObs().id, 'cluster'); renderUI();
}

async function cameraJourney(destClusterId, destIndex = lastIndex[destClusterId] || 0) {
  if (!ready || !currentClusterId || destClusterId === currentClusterId) return;
  cancelIntro();
  const fromObs = getObs(), destCluster = CLUSTERS[destClusterId], destObs = getObs(destClusterId, destIndex), destinationCamera = clusterCamera(destClusterId);
  const token = ++journeyToken;
  map.stop(); journeying = true; document.body.classList.add('journeying'); pendingClusterId = destClusterId; pendingObsIndex = destIndex; mode = 'journey';
  cut(false); sceneMarkers(false); setSpatialState(null, null, 'world');
  const liftCenter = map.getCenter().toArray(), travelBearing = bearingBetween(fromObs.coord, destCluster.center); currentArea = '';
  renderUI(`Lifting away from ${CLUSTERS[currentClusterId].name}…`);
  if (!await stage({ center: liftCenter, zoom: 16.4, pitch: 58, bearing: travelBearing }, JOURNEY_DURATION.lift, token, 0, 0.95)) return;
  renderUI('High transit · cluster and neighborhood context revealed');
  if (!await stage({ center: destCluster.center, zoom: 16.4, pitch: 58, bearing: travelBearing }, JOURNEY_DURATION.cruise, token, 0.95, 1)) return;
  setSpatialState(destClusterId, destObs.id, 'cluster'); renderUI(`Arriving over ${destCluster.name}…`);
  if (!await stage({ center: destCluster.center, zoom: Math.min(destinationCamera.zoom - 0.55, 16.9), pitch: 60, bearing: destinationCamera.bearing }, JOURNEY_DURATION.arrival, token, 1, 0.45)) return;
  if (!await stage(destinationCamera, JOURNEY_DURATION.settle, token, 0.45, 0)) return;
  currentClusterId = destClusterId; currentObsIndex = destIndex; lastIndex[destClusterId] = destIndex; pendingClusterId = null; mode = 'cluster'; journeying = false;
  document.body.classList.remove('journeying'); currentArea = ''; setMarkerObservation(destObs); cut(false); sceneMarkers(false); setSpatialState(destClusterId, destObs.id, 'cluster'); renderUI();
}

function showCluster(clusterId = currentClusterId, animate = true) {
  cancelIntro();
  if (!clusterId) { enterClusterFromWorld(CLUSTER_ORDER[0]); return; }
  ++journeyToken; map.stop(); journeying = false; pendingClusterId = null; currentArea = ''; neighborhoodOpacity(0); currentClusterId = clusterId; currentObsIndex = lastIndex[clusterId] || 0; mode = 'cluster'; photoVisible = false;
  document.body.classList.remove('journeying'); cut(false); sceneMarkers(false);
  const obs = getObs(); setMarkerObservation(obs); setSpatialState(clusterId, obs.id, 'cluster');
  const camera = clusterCamera(clusterId);
  map[animate ? 'easeTo' : 'jumpTo']({ ...camera, duration: animate ? 1500 : 0, easing: easeInOut, essential: true }); renderUI();
}

function showPov(animate = true) {
  cancelIntro();
  if (!currentClusterId) { enterClusterFromWorld(CLUSTER_ORDER[0]); return; }
  ++journeyToken; map.stop(); journeying = false; pendingClusterId = null; currentArea = ''; neighborhoodOpacity(0); mode = 'pov'; photoVisible = false;
  document.body.classList.remove('journeying'); cut(false); sceneMarkers(false);
  const obs = getObs(); setMarkerObservation(obs); setSpatialState(currentClusterId, obs.id, 'pov');
  map[animate ? 'easeTo' : 'jumpTo']({ ...obs.pov, duration: animate ? 1350 : 0, easing: easeInOut, essential: true }); renderUI();
}

function selectCluster(clusterId) {
  cancelIntro();
  if (journeying) { ++journeyToken; map.stop(); journeying = false; document.body.classList.remove('journeying'); }
  if (!currentClusterId) { enterClusterFromWorld(clusterId); return; }
  if (clusterId === currentClusterId) { showCluster(clusterId); return; }
  cameraJourney(clusterId, lastIndex[clusterId] || 0);
}

function selectObservation(index, animate = true) {
  cancelIntro();
  if (journeying || !currentClusterId) return;
  const cluster = CLUSTERS[currentClusterId];
  index = Math.max(0, Math.min(index, cluster.observations.length - 1));
  currentObsIndex = index; lastIndex[currentClusterId] = index;
  const obs = getObs(); setMarkerObservation(obs); setSpatialState(currentClusterId, obs.id, mode === 'cluster' ? 'cluster' : 'pov');
  if (mode === 'cluster') { renderUI(); return; }
  mode = 'pov'; map.stop(); map[animate ? 'easeTo' : 'jumpTo']({ ...obs.pov, duration: animate ? 1750 : 0, easing: easeInOut, essential: true }); renderUI();
}

function stepObservation(delta) {
  cancelIntro();
  if (journeying) return;
  if (!currentClusterId) { enterClusterFromWorld(delta < 0 ? CLUSTER_ORDER.at(-1) : CLUSTER_ORDER[0]); return; }
  const cluster = CLUSTERS[currentClusterId], next = currentObsIndex + delta;
  if (next >= 0 && next < cluster.observations.length) { selectObservation(next); return; }
  const clusterIndex = CLUSTER_ORDER.indexOf(currentClusterId), nextClusterIndex = clusterIndex + (delta > 0 ? 1 : -1);
  if (nextClusterIndex < 0 || nextClusterIndex >= CLUSTER_ORDER.length) return;
  const destination = CLUSTER_ORDER[nextClusterIndex], destinationIndex = delta > 0 ? 0 : CLUSTERS[destination].observations.length - 1;
  cameraJourney(destination, destinationIndex);
}

function togglePhoto() {
  if (mode !== 'pov') return;
  photoVisible = !photoVisible;
  modeButtons.photo.classList.toggle('active', photoVisible);
  $('note').textContent = photoVisible ? 'Photo is structurally limited to POV. The actual image renderer remains parked for the next reliability pass.' : 'POV restored. Photo remains a same-perspective toggle only.';
}

map = new maplibregl.Map({ container: 'map', style, center: [-73.9825, 40.74845], zoom: 12.3, pitch: 58, bearing: -27, maxPitch: 105, centerClampedToGround: false, fadeDuration: 0, canvasContextAttributes: { antialias: true } });
const cameraDot = document.createElement('div'); cameraDot.className = 'captureDot';
captureMarker = new maplibregl.Marker({ element: cameraDot, anchor: 'center' }).setLngLat(CLUSTERS.flatiron.observations[0].coord).addTo(map);
const photoPlane = document.createElement('div'); photoPlane.className = 'photoPlane';
photoPlaneMarker = new maplibregl.Marker({ element: photoPlane, anchor: 'center' }).setLngLat(CLUSTERS.flatiron.observations[0].subject).addTo(map);
sceneMarkers(false);

map.on('style.load', () => {
  ready = true; $('status').classList.add('ready');
  map.addSource('obs', { type: 'geojson', data: OBS_FC }); map.addSource('paths', { type: 'geojson', data: PATH_FC }); map.addSource('clusters', { type: 'geojson', data: CLUSTER_FC });
  map.addLayer({ id: 'cluster-fields', type: 'circle', source: 'clusters', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 24, 15, 48], 'circle-color': '#6ee0cc', 'circle-opacity': 0.32, 'circle-blur': 0.72, 'circle-stroke-color': '#aaf6e9', 'circle-stroke-width': 1.3, 'circle-stroke-opacity': 0.85 } });
  map.addLayer({ id: 'cluster-labels', type: 'symbol', source: 'clusters', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 15, 14], 'text-offset': [0, -2.1], 'text-anchor': 'bottom', 'text-allow-overlap': true }, paint: { 'text-color': '#e8fffb', 'text-halo-color': 'rgba(4,8,13,.9)', 'text-halo-width': 1.4, 'text-opacity': 0.95 } });
  map.addLayer({ id: 'cluster-path-active', type: 'line', source: 'paths', filter: ['==', ['get', 'cluster'], NONE], paint: { 'line-color': '#71dec9', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1.2, 19, 4], 'line-opacity': 0.58, 'line-dasharray': [1.2, 1.4] } });
  map.addLayer({ id: 'obs-all', type: 'circle', source: 'obs', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3, 18, 5], 'circle-color': '#9ba8b6', 'circle-opacity': 0.62, 'circle-stroke-color': '#061018', 'circle-stroke-width': 1 } });
  map.addLayer({ id: 'obs-cluster', type: 'circle', source: 'obs', filter: ['==', ['get', 'cluster'], NONE], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 4, 19, 7], 'circle-color': '#69e3cd', 'circle-opacity': 0.9, 'circle-stroke-color': '#effffc', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'obs-current', type: 'circle', source: 'obs', filter: ['==', ['get', 'id'], NONE], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 7, 19, 11], 'circle-color': '#ffb66a', 'circle-opacity': 0.98, 'circle-stroke-color': '#fff4e8', 'circle-stroke-width': 2.5 } });
  try {
    map.addSource('nta', { type: 'geojson', data: NTA_URL });
    map.addLayer({ id: 'nta-fill', type: 'fill', source: 'nta', paint: { 'fill-color': '#7adfcf', 'fill-opacity': 0 } });
    map.addLayer({ id: 'nta-lines', type: 'line', source: 'nta', paint: { 'line-color': '#9fe7dd', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.7, 17, 2.2], 'line-opacity': 0 } });
    map.addLayer({ id: 'nta-active-line', type: 'line', source: 'nta', filter: ['==', ['get', 'NTAName'], NONE], paint: { 'line-color': '#fff2ba', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 17, 4], 'line-opacity': 0 } });
    map.addLayer({ id: 'nta-labels', type: 'symbol', source: 'nta', layout: { 'text-field': ['get', 'NTAName'], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 15], 'text-letter-spacing': 0.08, 'text-transform': 'uppercase', 'text-allow-overlap': false }, paint: { 'text-color': '#e6fbf7', 'text-halo-color': 'rgba(5,10,15,.82)', 'text-halo-width': 1.4, 'text-opacity': 0 } });
  } catch (error) { console.warn('Neighborhood layer unavailable', error); }
  showWorld(false);
  introDone = false;
  introTimer = setTimeout(() => { introTimer = null; if (!introDone) enterClusterFromWorld('flatiron', true); }, 2300);
});

map.on('move', updateAreaUnderCenter);
map.on('dragstart', cancelIntro);
map.on('error', (event) => { if (!ready) $('status').textContent = `Map error: ${event.error?.message || 'unknown'}`; });
clusterButtons.flatiron.onclick = () => selectCluster('flatiron');
clusterButtons.noho.onclick = () => selectCluster('noho');
clusterButtons.central.onclick = () => selectCluster('central');
$('prevObservation').onclick = () => stepObservation(-1);
$('nextObservation').onclick = () => stepObservation(1);
modeButtons.world.onclick = () => showWorld();
modeButtons.cluster.onclick = () => showCluster();
modeButtons.pov.onclick = () => showPov();
modeButtons.photo.onclick = togglePhoto;
document.querySelectorAll('button').forEach((button) => button.addEventListener('pointerdown', cancelIntro, { passive: true }));
