// Application controller: loads data, runs the routing engine, builds the colour bands, wires the UI.

import { Engine, toMetres } from './engine.js';
import { WalkGrid } from './walkgrid.js';
import { Warp } from './warp.js';
import { Renderer, COLOURS, blend } from './render.js';
import { Calculator } from './calculate.js';
import { RoutingClient } from './routing-client.js';
import { installSearch } from './search.js';
import { unpackTransit, unpackRuns } from './data.js';
import { MODES, BANDS, UNREACHABLE_COLOUR } from './model.js';

const DEFAULT_ORIGIN = { lat: 51.508, lon: -0.1281, name: 'Trafalgar Square', node: -1 };
const BASE_SIZE = 1000;
const RING_POINTS = 40;
const ANIM_MS = 950;
const RAIL_MODES = new Set(['tube', 'dlr', 'elizabeth-line', 'overground', 'national-rail', 'tram']);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const smallScreen = window.matchMedia('(max-width: 760px)');

const state = {
  enabled: { foot: false, underground: true, trains: true, bus: true, car: false },
  morph: 0,
  origin: { ...DEFAULT_ORIGIN },
  ghost: false,
  showStations: true,
  showBus: true,
  hover: -1,
};

const $ = (id) => document.getElementById(id);

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const modes = params.get('m');
  if (modes !== null) {
    const on = new Set(modes.split(',').filter(Boolean));
    for (const m of MODES) state.enabled[m.id] = on.has(m.id);
  }
  const s = params.get('s');
  if (s !== null && !Number.isNaN(+s)) state.morph = Math.max(0, Math.min(1, +s / 100));
  const o = params.get('o');
  if (o) {
    const [lat, lon] = o.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) state.origin = { lat, lon, name: params.get('n') || 'Custom point', node: -1 };
  }
}

function writeHash() {
  const m = MODES.filter((mode) => state.enabled[mode.id]).map((mode) => mode.id).join(',');
  const o = `${state.origin.lat.toFixed(5)},${state.origin.lon.toFixed(5)}`;
  const s = state.morph > 0 ? `&s=${Math.round(state.morph * 100)}` : '';
  const n = state.origin.node < 0 ? `&n=${encodeURIComponent(state.origin.name)}` : '';
  history.replaceState(null, '', `#o=${o}&m=${m}${s}${n}`);
}

function formatMinutes(t) {
  if (!Number.isFinite(t)) return 'unreachable';
  const m = Math.round(t);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

async function main() {
  const [base, gridJson, transitJson, places] = await Promise.all([
    loadJSON('data/base.json'), loadJSON('data/walkgrid.json'), loadJSON('data/transit.json'), loadJSON('data/places.json'),
  ]);
  readHash();

  const transit = unpackTransit(transitJson);
  const grid = WalkGrid.fromJSON(gridJson);
  if (grid.cellOf(state.origin.lon, state.origin.lat) < 0) state.origin = { ...DEFAULT_ORIGIN };
  const engine = new Engine(transit, grid);
  const { stopLat, stopLon, platformStop, platformLine, rideFrom, rideTo } = transit;

  // ---------------------------------------------------------------- places and stations
  const stationByStop = new Map(transit.stations.map((s, i) => [s.stop, i]));
  const stationLines = transit.stations.map(() => new Set());
  for (let p = 0; p < platformStop.length; p++) {
    const stop = platformStop[p];
    const line = platformLine[p];
    if (RAIL_MODES.has(transit.lines[line].mode) && stationByStop.has(stop)) stationLines[stationByStop.get(stop)].add(line);
  }
  const nodes = [];
  transit.stations.forEach((s, i) => {
    nodes.push({ name: s.name, lat: stopLat[s.stop], lon: stopLon[s.stop], kind: 'station', hub: s.hub, modes: s.modes, lineIds: stationLines[i], stop: s.stop, index: nodes.length });
  });
  for (const p of places) nodes.push({ name: p.name, lat: p.lat, lon: p.lon, kind: 'place', tier: p.tier, lineIds: new Set(), index: nodes.length });
  const N = nodes.length;
  const nodeCell = Int32Array.from(nodes, (n) => (n.kind === 'station' ? engine.stopCell[n.stop] : grid.nearestWalkable(grid.cellOf(n.lon, n.lat))));
  const nodeMx = new Float64Array(N);
  const nodeMy = new Float64Array(N);
  nodes.forEach((n, i) => {
    const [x, y] = toMetres(n.lon, n.lat);
    nodeMx[i] = x;
    nodeMy[i] = y;
  });
  const nearestNodeTo = (lat, lon, maxMetres) => {
    const [x, y] = toMetres(lon, lat);
    let best = -1;
    let bestD = maxMetres;
    for (let i = 0; i < N; i++) {
      const d = Math.hypot(nodeMx[i] - x, nodeMy[i] - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  // ---------------------------------------------------------------- projection and mesh
  const { s, w, n, e } = base.bbox;
  // Clockwise ring: d3-geo treats counter-clockwise rings as enclosing the rest of the sphere.
  const bboxFeature = { type: 'Polygon', coordinates: [[[w, s], [w, n], [e, n], [e, s], [w, s]]] };
  const projection = d3.geoMercator().fitExtent([[0, 0], [BASE_SIZE, BASE_SIZE]], bboxFeature);
  const proj = (lon, lat) => projection([lon, lat]);
  const [bx0, by0] = proj(w, n);
  const [bx1, by1] = proj(e, s);
  const baseBounds = { x0: bx0, y0: by0, x1: bx1, y1: by1 };

  // Every ring and line of the map goes into one interleaved list of projected points; layers hold
  // [first point, count] runs into it.
  const meshList = [];
  const addRing = (coords) => {
    const start = meshList.length / 2;
    for (const [lon, lat] of coords) {
      const [x, y] = proj(lon, lat);
      meshList.push(x, y);
    }
    return [start, coords.length];
  };
  const addRuns = (packed) => {
    const { counts, coords } = unpackRuns(packed);
    const runs = [];
    for (let run = 0, k = 0; run < counts.length; run++) {
      const start = meshList.length / 2;
      for (let i = 0; i < counts[run]; i++, k += 2) {
        const [x, y] = proj(coords[k], coords[k + 1]);
        meshList.push(x, y);
      }
      runs.push([start, counts[run]]);
    }
    return runs;
  };
  const layers = {
    boroughs: base.boroughs.flatMap((b) => b.polygons.map((rings) => ({ name: b.name, rings: addRuns(rings) }))),
    parks: base.parks.map((p) => ({ rings: addRuns(p.rings) })),
    thames: base.thames.polygons.map((rings) => ({ rings: addRuns(rings) })),
    water: (base.water || []).map((rings) => ({ rings: addRuns(rings) })),
    thamesLine: addRuns(base.thames.centreline),
    roads: { motorway: addRuns(base.roads.motorway), trunk: addRuns(base.roads.trunk) },
    railByMode: {},
  };
  transit.lines.forEach((line, li) => {
    if (!line.geometry) return;
    const segs = line.geometry.map(addRing);
    if (!layers.railByMode[line.mode]) layers.railByMode[line.mode] = [];
    layers.railByMode[line.mode].push([li, segs]);
  });
  const mesh = { base: Float64Array.from(meshList), warped: Float32Array.from(meshList) };

  // Bus network as straight stop-to-stop segments (one per undirected pair), projecting each stop once.
  const busPairs = new Set();
  const busList = [];
  const stopXY = new Float64Array(2 * stopLat.length).fill(NaN);
  const stopPoint = (s) => {
    if (Number.isNaN(stopXY[2 * s])) [stopXY[2 * s], stopXY[2 * s + 1]] = proj(stopLon[s], stopLat[s]);
    busList.push(stopXY[2 * s], stopXY[2 * s + 1]);
  };
  for (let r = 0; r < rideFrom.length; r++) {
    if (transit.lines[platformLine[rideFrom[r]]].mode !== 'bus') continue;
    const a = platformStop[rideFrom[r]];
    const b = platformStop[rideTo[r]];
    const key = a < b ? a * 1e6 + b : b * 1e6 + a;
    if (busPairs.has(key)) continue;
    busPairs.add(key);
    stopPoint(a);
    stopPoint(b);
  }
  const busSegments = Float32Array.from(busList);

  // ---------------------------------------------------------------- control points (for the time-stretch option)
  const cpCount = N + RING_POINTS;
  const cpX = new Float64Array(cpCount);
  const cpY = new Float64Array(cpCount);
  const seen = new Set();
  nodes.forEach((node, i) => {
    let [x, y] = proj(node.lon, node.lat);
    let key = `${x.toFixed(2)},${y.toFixed(2)}`;
    while (seen.has(key)) {
      x += (Math.random() - 0.5) * 0.3;
      y += (Math.random() - 0.5) * 0.3;
      key = `${x.toFixed(2)},${y.toFixed(2)}`;
    }
    seen.add(key);
    cpX[i] = x;
    cpY[i] = y;
  });
  const cx = (baseBounds.x0 + baseBounds.x1) / 2;
  const cy = (baseBounds.y0 + baseBounds.y1) / 2;
  const rx = (baseBounds.x1 - baseBounds.x0) * 0.95;
  const ry = (baseBounds.y1 - baseBounds.y0) * 0.95;
  for (let j = 0; j < RING_POINTS; j++) {
    const a = (j / RING_POINTS) * Math.PI * 2;
    cpX[N + j] = cx + rx * Math.cos(a);
    cpY[N + j] = cy + ry * Math.sin(a);
  }

  // The mesh warp only serves the time-stretch option, so it is built the first time that is used.
  let stretch = null;
  function stretcher() {
    if (!stretch) {
      const warp = new Warp(cpX, cpY);
      const ringNeighbours = [];
      for (let j = 0; j < RING_POINTS; j++) {
        const nearest = Array.from({ length: N }, (_, i) => [Math.hypot(cpX[i] - cpX[N + j], cpY[i] - cpY[N + j]), i])
          .sort((p, q) => p[0] - q[0]).slice(0, 8).map((p) => p[1]);
        ringNeighbours.push(nearest);
      }
      stretch = { warp, binding: warp.bind(mesh.base), ringNeighbours };
    }
    return stretch;
  }

  // Grid cells project cheaply: Mercator is affine in longitude, and latitude only depends on the
  // row, so one multiply plus a row table replaces a projection call per vertex. Worth it because
  // the colour bands re-project tens of thousands of contour vertices on every recalculation.
  const [gridLon0, gridLat0] = grid.lonLatOfGrid(0, 0);
  const [gridLon1, gridLat1] = grid.lonLatOfGrid(1, 1);
  const gridDLon = gridLon1 - gridLon0;
  const gridDLat = gridLat1 - gridLat0;
  const gridX0 = proj(gridLon0, gridLat0)[0];
  const gridDX = proj(gridLon0 + gridDLon, gridLat0)[0] - gridX0;
  const gridYAt = new Float64Array(grid.rows + 2);
  for (let j = 0; j < gridYAt.length; j++) gridYAt[j] = proj(gridLon0, gridLat0 + j * gridDLat)[1];
  const gridProjY = (gy) => {
    const j = Math.max(0, Math.min(gridYAt.length - 2, Math.floor(gy)));
    return gridYAt[j] + (gy - j) * (gridYAt[j + 1] - gridYAt[j]);
  };
  (() => { // the fast projector must agree with the real one
    let worst = 0;
    for (const [gx, gy] of [[0.5, 0.5], [17.3, 91.7], [grid.cols - 0.5, grid.rows - 0.5], [200.25, 160.75]]) {
      const [lon, lat] = grid.lonLatOfGrid(gx, gy);
      const [ex, ey] = proj(lon, lat);
      worst = Math.max(worst, Math.abs(ex - (gridX0 + gx * gridDX)), Math.abs(ey - gridProjY(gy)));
    }
    if (worst > 0.01) console.warn(`fast grid projection off by ${worst.toFixed(4)} base units`);
  })();

  // ---------------------------------------------------------------- computation
  let originBase = proj(state.origin.lon, state.origin.lat);
  let lastResult = null;
  let times = null;        // minutes to each node, or null when nothing is ticked
  let nodeByCar = null;
  let surface = null;      // minutes to each grid cell
  let bandsGeom = null;
  let coverage = { londonCells: 0, within45: 0 };
  let lastTiming = {};

  // Version counters. The renderer caches the map layer and its geometry paths, and re-renders only
  // when one of these changes.
  let geomVersion = 0;   // warped geometry moved
  let bandsVersion = 0;  // colour bands rebuilt
  let dataVersion = 0;   // times, routing result
  let styleVersion = 0;  // toggles that change how things are drawn

  function buildBands({ coords, bands }) {
    for (let i = 0; i < coords.length; i += 2) {
      coords[i] = gridX0 + coords[i] * gridDX;
      coords[i + 1] = gridProjY(coords[i + 1]);
    }
    const list = bands.map((rings, k) => ({ colour: k < BANDS.length ? BANDS[k].colour : UNREACHABLE_COLOUR, rings }));
    return { base: coords, coords, list, binding: null, warped: null };
  }

  // Time-stretch targets (experimental): bearing kept, radius proportional to minutes. They depend on
  // the times and the start point but not on how far the map is stretched, so they are worked out
  // once per recalculation, the first time the stretch needs them.
  let full = null;
  function fullStretch() {
    if (!full) full = computeFull();
    return full;
  }

  function computeFull() {
    const tx = new Float64Array(cpCount);
    const ty = new Float64Array(cpCount);
    const [ox, oy] = originBase;
    let num = 0;
    let den = 0;
    for (let i = 0; i < N; i++) {
      const t = times[i];
      if (!Number.isFinite(t) || t <= 0) continue;
      const r = Math.hypot(cpX[i] - ox, cpY[i] - oy);
      num += r * t;
      den += t * t;
    }
    const ringScale = den > 0 ? num / den : 0;
    const rho = new Float64Array(N).fill(NaN);
    for (let i = 0; i < N; i++) {
      const r = Math.hypot(cpX[i] - ox, cpY[i] - oy);
      if (r < 1e-6) rho[i] = 1;
      else if (Number.isFinite(times[i])) rho[i] = (ringScale * times[i]) / r;
    }
    for (let i = 0; i < N; i++) {
      if (!Number.isNaN(rho[i])) continue;
      const near = [];
      for (let j = 0; j < N; j++) if (!Number.isNaN(rho[j])) near.push([Math.hypot(nodeMx[j] - nodeMx[i], nodeMy[j] - nodeMy[i]), rho[j]]);
      near.sort((p, q) => p[0] - q[0]);
      const rhos = near.slice(0, 6).map((p) => p[1]).sort((p, q) => p - q);
      rho[i] = rhos.length ? rhos[Math.floor(rhos.length / 2)] : 1;
    }
    for (let i = 0; i < N; i++) {
      tx[i] = ox + (cpX[i] - ox) * rho[i];
      ty[i] = oy + (cpY[i] - oy) * rho[i];
    }
    const { ringNeighbours } = stretcher();
    for (let j = 0; j < RING_POINTS; j++) {
      const rhos = ringNeighbours[j].map((i) => rho[i]).sort((p, q) => p - q);
      const median = rhos[Math.floor(rhos.length / 2)];
      tx[N + j] = ox + (cpX[N + j] - ox) * median;
      ty[N + j] = oy + (cpY[N + j] - oy) * median;
    }
    return { tx, ty, ringScale };
  }

  // Control point positions at the current stretch.
  function withMorph() {
    const sVal = state.morph;
    const tx = new Float64Array(cpCount);
    const ty = new Float64Array(cpCount);
    if (sVal <= 0 || !times) {
      tx.set(cpX);
      ty.set(cpY);
      return { tx, ty, ringScale: 0 };
    }
    const target = fullStretch();
    for (let i = 0; i < cpCount; i++) {
      tx[i] = cpX[i] + sVal * (target.tx[i] - cpX[i]);
      ty[i] = cpY[i] + sVal * (target.ty[i] - cpY[i]);
    }
    return { tx, ty, ringScale: target.ringScale };
  }

  // ---------------------------------------------------------------- rendering and animation
  const canvas = $('map');
  const renderer = new Renderer(canvas, { onSettle: () => requestFrame() });
  let transform = d3.zoomIdentity;
  let cur = { tx: cpX.slice(), ty: cpY.slice(), ringScale: 0 };
  let anim = null;
  let morphQueued = false;
  let calculating = false;
  let navigating = false;
  let interactionReady = false;
  let frameRequested = false;
  let route = null;
  let wasStretched = false;

  // Geometry only moves while the map is stretched, so the version only changes then (and once more
  // on the way back), leaving the renderer's paths and map layer alone otherwise.
  function applyWarp() {
    const stretched = state.morph > 0 || !!anim;
    if (stretched) {
      const { warp, binding } = stretcher();
      warp.apply(binding, cur.tx, cur.ty, mesh.warped);
    } else if (wasStretched) mesh.warped.set(mesh.base);
    if (bandsGeom) {
      if (stretched) {
        const { warp } = stretcher();
        if (!bandsGeom.binding) {
          bandsGeom.binding = warp.bind(bandsGeom.base);
          bandsGeom.warped = new Float32Array(bandsGeom.base.length);
        }
        warp.apply(bandsGeom.binding, cur.tx, cur.ty, bandsGeom.warped);
        bandsGeom.coords = bandsGeom.warped;
      } else bandsGeom.coords = bandsGeom.base;
    }
    if (stretched || wasStretched) geomVersion++;
    wasStretched = stretched;
  }

  function draw() {
    return renderer.draw({
      transform, layers, mesh, lines: transit.lines, enabled: state.enabled, warped: state.morph > 0 || !!anim,
      bands: bandsGeom, busSegments, showBus: state.showBus && state.morph === 0 && !anim,
      nodes, nodeX: cur.tx, nodeY: cur.ty, times,
      origin: { x: originBase[0], y: originBase[1], name: state.origin.name, node: state.origin.node },
      ringScale: cur.ringScale, morph: state.morph,
      hover: state.hover, route, ghost: state.ghost && state.morph > 0, showStations: state.showStations,
      geomVersion, bandsVersion, dataVersion, styleVersion,
    });
  }

  function requestFrame() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(frame);
  }

  function frame(now) {
    frameRequested = false;
    if (morphQueued) {
      morphQueued = false;
      remorph();
    }
    if (anim) {
      const u = reducedMotion.matches ? 1 : Math.min(1, (now - anim.start) / ANIM_MS);
      const ease = d3.easeCubicInOut(u);
      for (let i = 0; i < cpCount; i++) {
        cur.tx[i] = anim.from.tx[i] + (anim.to.tx[i] - anim.from.tx[i]) * ease;
        cur.ty[i] = anim.from.ty[i] + (anim.to.ty[i] - anim.from.ty[i]) * ease;
      }
      cur.ringScale = anim.from.ringScale + (anim.to.ringScale - anim.from.ringScale) * ease;
      if (u >= 1) anim = null;
      applyWarp();
    }
    draw();
    // Frames are only requested while the stretch animation is running. Otherwise the page goes
    // completely idle: no timers, no repaints.
    if (anim) requestFrame();
  }

  function transitionTo(target) {
    if (reducedMotion.matches) {
      anim = null;
      cur = target;
      applyWarp();
      requestFrame();
      return;
    }
    anim = {
      from: { tx: cur.tx.slice(), ty: cur.ty.slice(), ringScale: cur.ringScale },
      to: target,
      start: performance.now(),
    };
    requestFrame();
  }

  // ---------------------------------------------------------------- view
  function boundsOf(target) {
    if (state.morph <= 0 || !times) return baseBounds;
    const xs = [];
    const ys = [];
    for (let i = 0; i < N; i++) {
      if (!Number.isFinite(times[i])) continue;
      xs.push(target.tx[i]);
      ys.push(target.ty[i]);
    }
    if (xs.length < 10) return baseBounds;
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    const lo = Math.floor(xs.length * 0.02);
    const hi = Math.ceil(xs.length * 0.98) - 1;
    const [ox, oy] = originBase;
    return { x0: Math.min(xs[lo], ox), y0: Math.min(ys[lo], oy), x1: Math.max(xs[hi], ox), y1: Math.max(ys[hi], oy) };
  }

  let viewBounds = baseBounds;
  function fitTransform(bounds = viewBounds) {
    viewBounds = bounds;
    // The size measured at the last resize: reading the canvas here would force a layout.
    const W = renderer.w || window.innerWidth || 1280;
    const H = renderer.h || window.innerHeight || 720;
    const panelW = W > 760 ? 380 : 0;
    const panelH = W <= 760 ? 106 : 0;
    const pad = 24;
    const bw = Math.max(bounds.x1 - bounds.x0, 1);
    const bh = Math.max(bounds.y1 - bounds.y0, 1);
    const k = Math.max(0.2, Math.min(24, (W - panelW - pad * 2) / bw, (H - panelH - pad * 2) / bh));
    const tx = panelW + (W - panelW - bw * k) / 2 - bounds.x0 * k;
    const ty = panelH + (H - panelH - bh * k) / 2 - bounds.y0 * k;
    return d3.zoomIdentity.translate(tx, ty).scale(k);
  }

  // The view keeps re-fitting to the window until the user pans or zooms by hand.
  let autoFit = true;
  const zoom = d3.zoom().scaleExtent([0.2, 24]).duration(reducedMotion.matches ? 0 : 250).clickDistance(5).on('start', (ev) => {
    if (!interactionReady) return;
    navigating = true;
    clearHover();
    canvas.style.cursor = 'grabbing';
  }).on('end', () => {
    navigating = false;
    canvas.style.cursor = 'crosshair';
    if (interactionReady && pointerInside && !pointerQueued) {
      pointerQueued = true;
      requestAnimationFrame(handlePointer);
    }
  }).on('zoom', (ev) => {
    if (ev.sourceEvent) autoFit = false;
    transform = ev.transform;
    requestFrame();
  });
  const selection = d3.select(canvas).call(zoom);
  reducedMotion.addEventListener('change', () => zoom.duration(reducedMotion.matches ? 0 : 250));
  $('zoomIn').onclick = () => { autoFit = false; selection.interrupt().transition().duration(reducedMotion.matches ? 0 : 250).call(zoom.scaleBy, 1.6); };
  $('zoomOut').onclick = () => { autoFit = false; selection.interrupt().transition().duration(reducedMotion.matches ? 0 : 250).call(zoom.scaleBy, 1 / 1.6); };
  $('zoomReset').onclick = () => { autoFit = true; selection.interrupt().transition().duration(reducedMotion.matches ? 0 : 400).call(zoom.transform, fitTransform()); };

  function resize() {
    renderer.resize();
    if (autoFit) selection.call(zoom.transform, fitTransform());
    requestFrame();
  }
  let resizeQueued = false;
  const queueResize = () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; resize(); });
  };
  window.addEventListener('resize', queueResize);
  if (window.ResizeObserver) new ResizeObserver(queueResize).observe(canvas);
  resize();

  // ---------------------------------------------------------------- recompute
  const statsEl = $('stats');

  let fallbackCalculator;
  const routing = new RoutingClient(
    { transit: transitJson, grid: gridJson, nodes: nodes.map(({ lat, lon, kind, stop }) => ({ lat, lon, kind, stop })) },
    (origin, enabled) => (fallbackCalculator ||= new Calculator(engine, nodes)).compute(origin, enabled),
    applyCalculation,
  );

  function recompute() {
    calculating = true;
    clearHover();
    canvas.setAttribute('aria-busy', 'true');
    $('mapStatus').hidden = false;
    writeHash();
    routing.request(state.origin, state.enabled);
  }

  function applyCalculation(output) {
    lastResult = output.result;
    times = output.times;
    nodeByCar = output.nodeByCar;
    surface = output.surface;
    coverage = output.coverage;
    lastTiming = output.timing;
    bandsGeom = output.contours ? buildBands(output.contours) : null;
    dataVersion++;
    bandsVersion++;
    calculating = false;
    canvas.setAttribute('aria-busy', 'false');
    $('mapStatus').hidden = true;
    $('loading').classList.add('done');
    full = null;
    const target = withMorph();
    updateRoute();
    updateStats();
    invalidateTooltip();
    writeHash();
    if (state.morph > 0) {
      transitionTo(target);
      if (autoFit) selection.interrupt().transition().duration(reducedMotion.matches ? 0 : ANIM_MS).ease(d3.easeCubicInOut).call(zoom.transform, fitTransform(boundsOf(target)));
    } else {
      cur = { tx: target.tx, ty: target.ty, ringScale: target.ringScale };
      anim = null;
      applyWarp();
      if (autoFit) selection.interrupt().call(zoom.transform, fitTransform(boundsOf(target)));
      draw();
    }
  }

  // Dragging the slider fires input events far faster than anyone needs the address bar updated, and
  // browsers throttle history updates, so the hash is written once the slider pauses.
  let hashTimer = 0;
  function remorph() {
    const target = withMorph();
    cur = { tx: target.tx, ty: target.ty, ringScale: target.ringScale };
    anim = null;
    applyWarp();
    clearTimeout(hashTimer);
    hashTimer = setTimeout(writeHash, 250);
    if (autoFit) selection.interrupt().call(zoom.transform, fitTransform(boundsOf(target)));
  }

  function updateStats() {
    if (!times) {
      statsEl.textContent = 'Choose a way to travel to see journey times.';
      return;
    }
    const finite = Array.from(times).filter(Number.isFinite).sort((a, b) => a - b);
    const median = finite.length ? finite[Math.floor(finite.length / 2)] : NaN;
    const share = coverage.londonCells ? Math.round((100 * coverage.within45) / coverage.londonCells) : 0;
    const unreachable = N - finite.length;
    statsEl.innerHTML = `Median place <b>${formatMinutes(median)}</b> away · <b>${share}%</b> of London within 45 min`
      + (unreachable ? ` · <b>${unreachable}</b> of ${N} places out of reach` : '');
  }

  // ---------------------------------------------------------------- interaction
  function nearestNode(sx, sy, maxPx) {
    const { x: tx, y: ty, k } = transform;
    let best = -1;
    let bestD = maxPx * maxPx;
    for (let i = 0; i < N; i++) {
      if (!state.showStations && nodes[i].kind === 'station' && i !== state.origin.node) continue;
      const dx = cur.tx[i] * k + tx - sx;
      const dy = cur.ty[i] * k + ty - sy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  function journeyTo(i) {
    if (!times || !Number.isFinite(times[i])) return null;
    if (nodeByCar[i]) {
      return {
        legs: [{ kind: 'car', minutes: times[i] }],
        segments: [{ kind: 'car', coords: Float32Array.from([...originBase, cpX[i], cpY[i]]) }],
      };
    }
    const j = engine.journey(lastResult, nodeCell[i]);
    if (!j) return null;
    const segments = j.segments.map((seg) => {
      const coords = new Float32Array(seg.points.length * 2);
      seg.points.forEach(([lon, lat], k) => {
        const [x, y] = proj(lon, lat);
        coords[2 * k] = x;
        coords[2 * k + 1] = y;
      });
      return { kind: seg.kind, line: seg.line, coords };
    });
    return { legs: j.legs, segments };
  }

  function updateRoute() {
    route = state.hover >= 0 ? journeyTo(state.hover) : null;
  }

  const tooltip = $('tooltip');
  let tipFor = -2;
  let tipSize = { w: 0, h: 0 };

  // Rebuilding the tooltip markup forces a layout, so it only happens when the place changes.
  function fillTooltip(i) {
    const node = nodes[i];
    const modes = node.kind === 'station' ? [...node.lineIds].map((l) => transit.lines[l].name).join(', ') : 'Place';
    let html = `<div class="name">${node.name}</div><div class="kind">${modes}</div>`;
    if (times) {
      const t = times[i];
      html += `<div class="time${Number.isFinite(t) ? '' : ' unreachable'}">${formatMinutes(t)}</div>`;
      const j = route && state.hover === i ? route : journeyTo(i);
      if (j) {
        const parts = j.legs.filter((leg) => leg.kind !== 'walk' || leg.minutes >= 0.75).map((leg) => {
          if (leg.kind === 'walk') return `Walk <span>${Math.max(1, Math.round(leg.minutes))}</span>`;
          if (leg.kind === 'car') return `<i style="background:${COLOURS.accent}"></i>Drive <span>${Math.round(leg.minutes)}</span>`;
          const line = transit.lines[leg.line];
          const label = line.mode === 'bus' ? `Bus ${line.name}` : line.name;
          return `<i style="background:${line.colour}"></i>${label} <span>${Math.round(leg.minutes)}</span>${leg.stops ? ` (${leg.stops} stop${leg.stops > 1 ? 's' : ''})` : ''}`;
        });
        html += `<div class="legs">${parts.join(' → ')}</div>`;
      }
    }
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const rect = tooltip.getBoundingClientRect();
    tipSize = { w: rect.width, h: rect.height };
  }

  function placeTooltip(sx, sy) {
    let x = sx + 16;
    let y = sy + 16;
    if (x + tipSize.w > window.innerWidth - 8) x = sx - tipSize.w - 12;
    if (y + tipSize.h > window.innerHeight - 8) y = sy - tipSize.h - 12;
    tooltip.style.transform = `translate(${Math.round(Math.max(8, x))}px, ${Math.round(Math.max(8, y))}px)`;
  }

  // Pointer moves arrive far faster than frames, so the hit test runs at most once per frame.
  let pointerX = 0;
  let pointerY = 0;
  let pointerQueued = false;
  let pointerInside = false;

  function handlePointer() {
    pointerQueued = false;
    if (!pointerInside || navigating || calculating || anim || morphQueued) return;
    const i = nearestNode(pointerX, pointerY, 12);
    if (i !== state.hover) {
      state.hover = i;
      updateRoute();
      requestFrame();
    }
    if (i >= 0) {
      if (i !== tipFor) {
        fillTooltip(i);
        tipFor = i;
      }
      placeTooltip(pointerX, pointerY);
    } else if (tipFor !== -1) {
      tooltip.hidden = true;
      tipFor = -1;
    }
    canvas.style.cursor = i >= 0 ? 'pointer' : 'crosshair';
  }

  canvas.addEventListener('pointermove', (ev) => {
    if (ev.pointerType === 'touch' || ev.buttons) return;
    pointerInside = true;
    pointerX = ev.clientX;
    pointerY = ev.clientY;
    if (pointerQueued) return;
    pointerQueued = true;
    requestAnimationFrame(handlePointer);
  });
  function clearHover() {
    pointerInside = false;
    state.hover = -1;
    updateRoute();
    tooltip.hidden = true;
    tipFor = -1;
    requestFrame();
  }
  canvas.addEventListener('pointerleave', clearHover);
  // The hovered place is drawn into the cached layer, so its tooltip must be refreshed too.
  function invalidateTooltip() {
    tipFor = -2;
    if (state.hover >= 0) {
      fillTooltip(state.hover);
      tipFor = state.hover;
      placeTooltip(pointerX, pointerY);
    }
  }

  // A start point within a few metres of a known place takes that place's identity and name.
  function snapOrigin(origin) {
    if (origin.node >= 0) return origin;
    const near = nearestNodeTo(origin.lat, origin.lon, 60);
    if (near < 0) return origin;
    const node = nodes[near];
    return { lat: node.lat, lon: node.lon, name: node.name, node: near };
  }

  function setOrigin(origin) {
    searchController?.reset();
    state.origin = snapOrigin(origin);
    originBase = proj(state.origin.lon, state.origin.lat);
    $('originName').textContent = state.origin.name;
    if (smallScreen.matches) setCollapsed(true);
    recompute();
  }

  canvas.addEventListener('click', (ev) => {
    const i = nearestNode(ev.clientX, ev.clientY, 12);
    if (i >= 0) {
      const node = nodes[i];
      setOrigin({ lat: node.lat, lon: node.lon, name: node.name, node: i });
      return;
    }
    const { x: tx, y: ty, k } = transform;
    const bx = (ev.clientX - tx) / k;
    const by = (ev.clientY - ty) / k;
    const inv = state.morph > 0 ? stretcher().warp.invert(bx, by, cur.tx, cur.ty) : [bx, by];
    if (!inv) return;
    const [lon, lat] = projection.invert(inv);
    if (grid.cellOf(lon, lat) < 0) return;
    const near = nearestNodeTo(lat, lon, 300);
    const name = near >= 0 ? `Near ${nodes[near].name}` : 'Custom point';
    setOrigin({ lat, lon, name, node: -1 });
  });

  // ---------------------------------------------------------------- panel
  const modeIcons = {
    foot: '<circle cx="14" cy="4" r="2"/><path d="m7 21 3-7m6 7-2-7-3-3 1-4m-6 6 3-5 3-1 3 5 4 1"/>',
    underground: '<circle cx="12" cy="12" r="8"/><path d="M2 9h20v6H2z"/>',
    trains: '<rect x="5" y="3" width="14" height="15" rx="4"/><path d="M5 11h14M12 3v8m-5 11 3-4m7 4-3-4M8 15h1m6 0h1"/>',
    bus: '<rect x="4" y="3" width="16" height="16" rx="3"/><path d="M4 11h16M8 15h1m6 0h1M7 19v2m10-2v2"/>',
    car: '<path d="m5 8 2-4h10l2 4 2 3v7H3v-7zm-2 3h18M6 15h2m8 0h2M6 18v3m12-3v3"/>',
  };
  const modesEl = $('modes');
  for (const m of MODES) {
    const label = document.createElement('label');
    label.className = `mode${state.enabled[m.id] ? ' on' : ''}`;
    label.innerHTML = `<input type="checkbox" ${state.enabled[m.id] ? 'checked' : ''}><span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${modeIcons[m.id]}</svg></span><span class="text"><span class="label">${m.label}</span><span class="sub">${m.hint}</span></span>`;
    const input = label.querySelector('input');
    input.addEventListener('change', () => {
      state.enabled[m.id] = input.checked;
      label.classList.toggle('on', input.checked);
      recompute();
    });
    modesEl.appendChild(label);
  }

  const bandsEl = $('bands');
  const bandLabels = ['10', '20', '30', '45', '60', '90', '120', '2h+'];
  bandsEl.innerHTML = BANDS.map((b, i) => `<div class="band"><i style="background:${blend(b.colour, COLOURS.land, 0.62)}"></i><span>${bandLabels[i]}</span></div>`).join('')
    + `<div class="band"><i style="background:${blend(UNREACHABLE_COLOUR, COLOURS.land, 0.62)}"></i><span>none</span></div>`;

  const morphInput = $('morph');
  morphInput.value = Math.round(state.morph * 100);
  $('morphValue').textContent = `${Math.round(state.morph * 100)}%`;
  morphInput.addEventListener('input', () => {
    state.morph = +morphInput.value / 100;
    $('morphValue').textContent = `${morphInput.value}%`;
    clearHover();
    morphQueued = true;
    requestFrame();
  });
  if (state.morph > 0) $('more').open = true;

  const setFlag = (key, value) => {
    state[key] = value;
    styleVersion++;
    if (key === 'showStations') clearHover();
    requestFrame();
  };
  $('ghost').addEventListener('change', (ev) => setFlag('ghost', ev.target.checked));
  $('stations').addEventListener('change', (ev) => setFlag('showStations', ev.target.checked));
  $('busnet').addEventListener('change', (ev) => setFlag('showBus', ev.target.checked));
  function setCollapsed(collapsed) {
    if (collapsed && $('panelBody').contains(document.activeElement)) $('collapse').focus();
    $('panel').classList.toggle('collapsed', collapsed);
    $('panelBody').inert = collapsed;
    $('collapse').setAttribute('aria-expanded', String(!collapsed));
    $('collapse').setAttribute('aria-label', collapsed ? 'Expand controls' : 'Collapse controls');
    $('collapse').title = collapsed ? 'Expand controls' : 'Collapse controls';
  }
  setCollapsed(smallScreen.matches);
  smallScreen.addEventListener('change', (event) => setCollapsed(event.matches));
  $('collapse').addEventListener('click', () => setCollapsed(!$('panel').classList.contains('collapsed')));

  const searchController = installSearch(nodes, {
    onSelect: setOrigin,
    contains: (lon, lat) => grid.cellOf(lon, lat) >= 0,
  });

  // Keep keyboard navigation local to the focused map, leaving form controls alone.
  canvas.addEventListener('keydown', (event) => {
    const moves = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] };
    if (moves[event.key]) {
      event.preventDefault();
      autoFit = false;
      clearHover();
      const [dx, dy] = moves[event.key];
      selection.interrupt().call(zoom.translateBy, dx / transform.k, dy / transform.k);
    } else if (event.key === '+' || event.key === '=') { event.preventDefault(); $('zoomIn').click(); }
    else if (event.key === '-') { event.preventDefault(); $('zoomOut').click(); }
    else if (event.key === 'Home') { event.preventDefault(); $('zoomReset').click(); }
  });

  // Line legend.
  const legend = $('legend');
  const legendLines = transit.lines.filter((l) => ['tube', 'dlr', 'elizabeth-line', 'tram'].includes(l.mode));
  const overground = transit.lines.filter((l) => l.mode === 'overground');
  const html = legendLines.map((l) => `<div class="legend-line"><i style="background:${l.colour}"></i>${l.name}</div>`);
  html.push(`<div class="legend-line"><i style="background:linear-gradient(90deg,${overground.map((l) => l.colour).join(',')})"></i>Overground</div>`);
  html.push(`<div class="legend-line"><i class="dashed" style="--c:${COLOURS.rail}"></i>National Rail</div>`);
  html.push(`<div class="legend-line"><i style="background:${COLOURS.bus}"></i>Bus routes</div>`);
  html.push(`<div class="legend-line"><i style="background:${COLOURS.walk};height:2px"></i>Walking leg</div>`);
  legend.innerHTML = html.join('');

  // Debug handle (not used by the page itself).
  window.__app = {
    engine, grid, state, nodes, cpX, cpY,
    get warp() { return stretcher().warp; },
    get result() { return lastResult; },
    get times() { return times; },
    get surface() { return surface; },
    get transform() { return transform; },
    get cur() { return cur; },
    get timing() { return lastTiming; },
    get calculating() { return calculating; },
    get workerActive() { return !!routing.worker; },
    get renderStats() { return renderer.stats; },
    screenOf(i) { return [cur.tx[i] * transform.k + transform.x, cur.ty[i] * transform.k + transform.y]; },
    gridProject(gx, gy) { return [gridX0 + gx * gridDX, gridProjY(gy)]; },
    journeyTo,
    // Times one draw. relayout repaints even if nothing changed, rerender also renders the map layer
    // again, and rebuildPaths also rebuilds every path.
    timeFrame({ relayout = false, rerender = false, rebuildPaths = false } = {}) {
      if (rebuildPaths) renderer.pathKey = renderer.bandKey = null;
      if (rebuildPaths || rerender) renderer.held = null;
      if (rebuildPaths || rerender || relayout) renderer.frameKey = null;
      const t0 = performance.now();
      const painted = draw();
      return { ms: performance.now() - t0, painted, pathMs: renderer.stats.pathMs, layerMs: renderer.stats.layerMs };
    },
  };

  // ---------------------------------------------------------------- go
  interactionReady = true;
  // Keep the loading screen until the first complete result is ready.
  state.origin = snapOrigin(state.origin);
  originBase = proj(state.origin.lon, state.origin.lat);
  $('originName').textContent = state.origin.name;
  cur = { tx: cpX.slice(), ty: cpY.slice(), ringScale: 0 };
  applyWarp();
  recompute();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      renderer.fontsChanged();
      requestFrame();
    });
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestFrame(); });
}

main().catch((err) => {
  console.error(err);
  const loading = $('loading');
  loading.classList.remove('done');
  loading.replaceChildren();
  const message = document.createElement('p');
  message.textContent = 'London could not load. Check your connection and try again.';
  const retry = document.createElement('button');
  retry.textContent = 'Try again';
  retry.onclick = () => location.reload();
  loading.append(message, retry);
});
