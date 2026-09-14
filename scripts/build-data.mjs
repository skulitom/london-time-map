#!/usr/bin/env node
// Builds the static data files for the London time map.
//
// Sources
//   - TfL Unified API: lines, stations, stops and route sequences for tube, DLR, Overground,
//     Elizabeth line, tram, National Rail and every bus route.
//   - ONS Open Geography Portal: London borough boundaries (super-generalised).
//   - OpenStreetMap via Overpass: River Thames, other water bodies, pedestrian bridges and foot
//     tunnels, major parks, motorways and trunk roads.
//
// Every remote response is cached in scripts/cache so re-runs are offline and fast.
// Delete a cache file to refresh that source.  Output goes to data/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WalkGrid, rasterisePolygon, rasteriseLine } from '../src/walkgrid.js';
import { packTransit } from '../src/transit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'scripts', 'cache');
const OUT = path.join(ROOT, 'data');
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// Greater London plus a margin, as south, west, north, east.
const BBOX = { s: 51.28, w: -0.55, n: 51.72, e: 0.40 };
const inBox = (lat, lon) => lat >= BBOX.s && lat <= BBOX.n && lon >= BBOX.w && lon <= BBOX.e;
const bboxStr = `${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}`;

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cached(name, producer) {
  const file = path.join(CACHE, name);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const value = await producer();
  fs.writeFileSync(file, JSON.stringify(value));
  return value;
}

async function getJSON(url, tries = 5) {
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      await sleep(3000 * (i + 1));
    }
  }
  throw lastError;
}

async function overpass(query) {
  for (const endpoint of OVERPASS) {
    try {
      const res = await fetch(endpoint, { method: 'POST', body: new URLSearchParams({ data: query }) });
      if (res.ok) return await res.json();
      console.warn(`  overpass ${endpoint} -> HTTP ${res.status}`);
    } catch (err) {
      console.warn(`  overpass ${endpoint} -> ${err.message}`);
    }
    await sleep(8000);
  }
  throw new Error('All Overpass endpoints failed');
}

// ---------------------------------------------------------------- geometry helpers

const EARTH_R = 6371008.8;
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

// Local equirectangular metres, good enough for simplification tolerances.
const KX = 111320 * Math.cos((51.5 * Math.PI) / 180);
const KY = 110574;
const toMetres = ([lon, lat]) => [lon * KX, lat * KY];
const metresBetween = (a, b) => {
  const [ax, ay] = toMetres(a);
  const [bx, by] = toMetres(b);
  return Math.hypot(ax - bx, ay - by);
};

function simplify(coords, tolerance) {
  if (coords.length <= 2) return coords;
  const pts = coords.map(toMetres);
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

const round5 = (v) => Math.round(v * 1e5) / 1e5;
const roundCoords = (coords) => coords.map(([lon, lat]) => [round5(lon), round5(lat)]);

// Splits a line into pieces that stay inside the bounding box.
function clipLineToBox(coords) {
  const pieces = [];
  let current = [];
  for (const [lon, lat] of coords) {
    if (inBox(lat, lon)) current.push([lon, lat]);
    else if (current.length) {
      pieces.push(current);
      current = [];
    }
  }
  if (current.length) pieces.push(current);
  return pieces.filter((p) => p.length >= 2);
}

// Sutherland-Hodgman clipping of a ring against the bounding box.
function clipRingToBox(ring) {
  const edges = [
    { inside: (p) => p[0] >= BBOX.w, axis: 0, value: BBOX.w },
    { inside: (p) => p[0] <= BBOX.e, axis: 0, value: BBOX.e },
    { inside: (p) => p[1] >= BBOX.s, axis: 1, value: BBOX.s },
    { inside: (p) => p[1] <= BBOX.n, axis: 1, value: BBOX.n },
  ];
  let output = ring;
  for (const edge of edges) {
    const input = output;
    output = [];
    if (!input.length) break;
    let prev = input[input.length - 1];
    for (const curr of input) {
      const currIn = edge.inside(curr);
      const prevIn = edge.inside(prev);
      if (currIn !== prevIn) {
        const t = (edge.value - prev[edge.axis]) / (curr[edge.axis] - prev[edge.axis]);
        output.push(edge.axis === 0
          ? [edge.value, prev[1] + t * (curr[1] - prev[1])]
          : [prev[0] + t * (curr[0] - prev[0]), edge.value]);
      }
      if (currIn) output.push(curr);
      prev = curr;
    }
  }
  return output;
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = toMetres(ring[j]);
    const [x2, y2] = toMetres(ring[i]);
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

const coordKey = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

// Joins way fragments that share endpoints into chains. Input: arrays of [lon, lat].
function chainWays(ways) {
  const remaining = new Set(ways.map((_, i) => i));
  const byEnd = new Map();
  ways.forEach((w, i) => {
    for (const key of [coordKey(w[0]), coordKey(w[w.length - 1])]) {
      if (!byEnd.has(key)) byEnd.set(key, []);
      byEnd.get(key).push(i);
    }
  });
  const chains = [];
  while (remaining.size) {
    const first = remaining.values().next().value;
    remaining.delete(first);
    let coords = ways[first].slice();
    let extended = true;
    while (extended && coordKey(coords[0]) !== coordKey(coords[coords.length - 1])) {
      extended = false;
      const endKey = coordKey(coords[coords.length - 1]);
      for (const j of byEnd.get(endKey) || []) {
        if (!remaining.has(j)) continue;
        remaining.delete(j);
        const w = ways[j];
        coords = coords.concat(coordKey(w[0]) === endKey ? w.slice(1) : w.slice(0, -1).reverse());
        extended = true;
        break;
      }
      const startKey = coordKey(coords[0]);
      for (const j of byEnd.get(startKey) || []) {
        if (!remaining.has(j)) continue;
        remaining.delete(j);
        const w = ways[j];
        coords = (coordKey(w[w.length - 1]) === startKey ? w.slice(0, -1) : w.slice(1).reverse()).concat(coords);
        extended = true;
        break;
      }
    }
    const closed = coordKey(coords[0]) === coordKey(coords[coords.length - 1]) && coords.length > 3;
    chains.push({ coords, closed });
  }
  return chains;
}

// Greedily joins open chains end-to-end (nearest endpoints) into closed rings.
function joinOpenChains(chains) {
  const pool = chains.map((c) => c.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.pop();
    for (;;) {
      const end = ring[ring.length - 1];
      let best = -1;
      let bestD = Infinity;
      let reverse = false;
      pool.forEach((c, i) => {
        const d0 = metresBetween(end, c[0]);
        const d1 = metresBetween(end, c[c.length - 1]);
        if (d0 < bestD) { bestD = d0; best = i; reverse = false; }
        if (d1 < bestD) { bestD = d1; best = i; reverse = true; }
      });
      if (best < 0 || metresBetween(end, ring[0]) <= bestD) break;
      let piece = pool.splice(best, 1)[0];
      if (reverse) piece = piece.reverse();
      ring = ring.concat(piece);
    }
    rings.push(ring);
  }
  return rings;
}

const osmCoords = (geometry) => geometry.map((p) => [p.lon, p.lat]);

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Converts Overpass ways/relations into polygons: [{ id, name, rings: [outer, inner...] }]
function osmPolygons(elements) {
  const out = [];
  for (const el of elements) {
    const name = el.tags?.name || '';
    if (el.type === 'way' && el.geometry && el.geometry.length > 3) {
      const ring = osmCoords(el.geometry);
      if (coordKey(ring[0]) === coordKey(ring[ring.length - 1])) out.push({ id: el.id, name, rings: [ring] });
    } else if (el.type === 'relation' && el.members) {
      const outers = el.members.filter((m) => m.type === 'way' && m.geometry && m.role !== 'inner').map((m) => osmCoords(m.geometry));
      const inners = el.members.filter((m) => m.type === 'way' && m.geometry && m.role === 'inner').map((m) => osmCoords(m.geometry));
      const outerChains = chainWays(outers);
      const rings = outerChains.filter((c) => c.closed).map((c) => c.coords);
      const open = outerChains.filter((c) => !c.closed).map((c) => c.coords);
      if (open.length) rings.push(...joinOpenChains(open));
      const innerRings = chainWays(inners).filter((c) => c.closed).map((c) => c.coords);
      for (const ring of rings) out.push({ id: el.id, name, rings: [ring, ...innerRings.filter((r) => pointInRing(r[0], ring))] });
    }
  }
  return out;
}

function finishPolygon(rings, tolerance) {
  return rings
    .map((r) => clipRingToBox(r))
    .filter((r) => r.length >= 4)
    .map((r) => roundCoords(simplify(r, tolerance)))
    .filter((r) => r.length >= 4);
}

// ---------------------------------------------------------------- TfL

const LINE_COLOURS = {
  bakerloo: '#B36305', central: '#E32017', circle: '#FFD300', district: '#00853F',
  'hammersmith-city': '#F3A9BB', jubilee: '#A0A5A9', metropolitan: '#9B0056', northern: '#E8E8E8',
  piccadilly: '#2E6BDF', victoria: '#0098D4', 'waterloo-city': '#95CDBA',
  dlr: '#00A4A7', elizabeth: '#8B6FD0', tram: '#84B817',
  lioness: '#F5B500', mildmay: '#3E8FD8', windrush: '#EF5A3C', weaver: '#B0367C', suffragette: '#5FBF6C', liberty: '#8E97A3',
};
const NATIONAL_RAIL_COLOUR = '#8892A0';
const BUS_COLOUR = '#E4573D';

// Typical wait for the next service, in minutes (roughly half the headway).
const WAIT_BY_MODE = { tube: 3, dlr: 3, 'elizabeth-line': 4, overground: 5, tram: 4, 'national-rail': 8, bus: 5 };
const INTERCITY = new Set(['avanti-west-coast', 'london-north-eastern-railway', 'lumo', 'hull-trains', 'grand-central',
  'crosscountry', 'east-midlands-railway', 'transpennine-express', 'transport-for-wales', 'scotrail', 'merseyrail',
  'northern-rail', 'island-line']);
const lineWait = (line) => {
  if (INTERCITY.has(line.id)) return 20;
  if (line.id === 'heathrow-express' || line.id === 'gatwick-express') return 8;
  if (line.modeName === 'bus' && /^N/.test(line.name)) return 15; // night buses
  return WAIT_BY_MODE[line.modeName] ?? 8;
};

function cleanStationName(name) {
  let n = name
    .replace(/ (Underground|Rail|DLR|Overground|Tram|Elizabeth line) ?(Station|Stop)$/i, '')
    .replace(/ Station$/i, '')
    .replace(/\s*\(H&C Line\)-Underground$/i, '')
    .replace(/\s*\(London\)$/i, '')
    .replace(/\s*\(Berks\)$/i, '')
    .trim();
  if (/^London /.test(n) && !/^London (Bridge|Fields|City Airport|Road)/.test(n)) n = n.replace(/^London /, '');
  return n;
}

// National Rail branches absent from TfL's route sequences, as ordered station lists.
const EXTRA_ROUTES = [
  { line: 'southeastern', stations: ['Lewisham', 'Blackheath', 'Kidbrooke', 'Eltham', 'Falconwood', 'Welling', 'Bexleyheath', 'Barnehurst', 'Slade Green'] },
  { line: 'southeastern', stations: ['Barnehurst', 'Dartford'] },
  { line: 'southeastern', stations: ['Blackheath', 'Charlton'] },
  { line: 'south-western-railway', stations: ['Surbiton', 'Hinchley Wood', 'Claygate', 'Oxshott', "Cobham & Stoke d'Abernon", 'Effingham Junction'] },
];

// Keeps only what the build needs from a route-sequence response (the cache stays small).
const trimSequence = (seq) => (seq && seq.stopPointSequences ? {
  stopPointSequences: seq.stopPointSequences.map((b) => ({
    direction: b.direction,
    stopPoint: b.stopPoint.map((s) => ({ id: s.id, stationId: s.stationId, name: s.name, lat: s.lat, lon: s.lon, topMostParentId: s.topMostParentId })),
  })),
  lineStrings: seq.lineStrings,
} : null);

async function buildTransit() {
  console.log('TfL: fetching line lists');
  const railLines = await cached('tfl-lines.json', () =>
    getJSON('https://api.tfl.gov.uk/Line/Mode/tube,dlr,overground,elizabeth-line,tram,national-rail'));
  const busLines = await cached('tfl-bus-lines.json', () => getJSON('https://api.tfl.gov.uk/Line/Mode/bus'));

  const stops = [];       // [lat, lon]
  const stopIndex = new Map();
  const stations = [];    // rail stations: { name, stop, hub, modes }
  const stationByStop = new Map();
  const lines = [];
  const platforms = [];   // [stop, line]
  const platformIndex = new Map();
  const rides = [];       // [fromPlatform, toPlatform, metres]
  const rideKeys = new Set();

  const stopFor = (s) => {
    const key = s.stationId || s.id;
    if (stopIndex.has(key)) return stopIndex.get(key);
    const idx = stops.length;
    stopIndex.set(key, idx);
    stops.push([round5(s.lat), round5(s.lon)]);
    return idx;
  };
  const platformFor = (stop, line) => {
    const key = `${stop}|${line}`;
    if (platformIndex.has(key)) return platformIndex.get(key);
    const idx = platforms.length;
    platformIndex.set(key, idx);
    platforms.push([stop, line]);
    return idx;
  };
  const addRide = (a, b, line, metres, bothWays) => {
    const pa = platformFor(a, line);
    const pb = platformFor(b, line);
    for (const [x, y] of bothWays ? [[pa, pb], [pb, pa]] : [[pa, pb]]) {
      const key = `${x}|${y}`;
      if (rideKeys.has(key)) continue;
      rideKeys.add(key);
      rides.push([x, y, Math.round(metres)]);
    }
  };
  const stationFor = (s, stop, mode) => {
    if (!stationByStop.has(stop)) {
      const st = { name: cleanStationName(s.name), stop, modes: [] };
      if (s.topMostParentId && s.topMostParentId.startsWith('HUB')) st.hub = s.topMostParentId;
      stationByStop.set(stop, stations.length);
      stations.push(st);
    }
    const st = stations[stationByStop.get(stop)];
    if (!st.modes.includes(mode)) st.modes.push(mode);
  };

  // Rail: undirected hops between adjacent stations.
  for (const line of railLines) {
    const seq = await cached(`tfl-seq-${line.id}.json`, async () => {
      await sleep(400);
      console.log(`TfL: fetching ${line.name}`);
      return getJSON(`https://api.tfl.gov.uk/Line/${line.id}/Route/Sequence/all?excludeCrowding=true`);
    });
    if (!seq || !seq.stopPointSequences) continue;
    const lineIdx = lines.length;
    let count = 0;
    for (const branch of seq.stopPointSequences) {
      const sp = branch.stopPoint;
      for (let i = 0; i + 1 < sp.length; i++) {
        const a = sp[i];
        const b = sp[i + 1];
        if (!inBox(a.lat, a.lon) || !inBox(b.lat, b.lon)) continue;
        const sa = stopFor(a);
        const sb = stopFor(b);
        if (sa === sb) continue;
        stationFor(a, sa, line.modeName);
        stationFor(b, sb, line.modeName);
        addRide(sa, sb, lineIdx, haversine(a.lat, a.lon, b.lat, b.lon), true);
        count++;
      }
    }
    if (!count) {
      console.log(`  skipping ${line.name} (no hops inside London)`);
      continue;
    }
    const seen = new Set();
    const geometry = [];
    for (const ls of seq.lineStrings || []) {
      let parsed;
      try { parsed = JSON.parse(ls); } catch { continue; }
      const parts = Array.isArray(parsed[0][0]) ? parsed : [parsed];
      for (const part of parts) {
        for (const piece of clipLineToBox(part)) {
          const simplified = roundCoords(simplify(piece, 8));
          const key = JSON.stringify(simplified);
          if (seen.has(key)) continue;
          seen.add(key);
          geometry.push(simplified);
        }
      }
    }
    lines.push({ id: line.id, name: line.name, mode: line.modeName, colour: LINE_COLOURS[line.id] || NATIONAL_RAIL_COLOUR, wait: lineWait(line), geometry });
    console.log(`  ${line.name}: ${count} hops`);
  }

  // National Rail branches that TfL's sequences miss, from the stop-point list.
  const nrStops = await cached('tfl-nr-stops.json', async () => {
    const out = [];
    for (let page = 1; page <= 12; page++) {
      await sleep(400);
      const res = await getJSON(`https://api.tfl.gov.uk/StopPoint/Mode/national-rail?page=${page}`);
      const list = res?.stopPoints || [];
      for (const s of list) {
        if (s.stopType === 'NaptanRailStation' && inBox(s.lat, s.lon)) {
          out.push({ id: s.id, name: s.commonName, lat: s.lat, lon: s.lon, hub: s.hubNaptanCode || null });
        }
      }
      if (list.length < (res?.pageSize || 1000)) break;
    }
    return out;
  });
  const stopByName = new Map(nrStops.map((s) => [cleanStationName(s.name).toLowerCase(), s]));
  for (const route of EXTRA_ROUTES) {
    const lineIdx = lines.findIndex((l) => l.id === route.line);
    if (lineIdx < 0) continue;
    const seq = route.stations.map((name) => stopByName.get(name.toLowerCase())).filter(Boolean);
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = seq[i];
      const b = seq[i + 1];
      const sa = stopFor({ id: a.id, lat: a.lat, lon: a.lon });
      const sb = stopFor({ id: b.id, lat: b.lat, lon: b.lon });
      stationFor({ name: a.name, topMostParentId: a.hub }, sa, 'national-rail');
      stationFor({ name: b.name, topMostParentId: b.hub }, sb, 'national-rail');
      addRide(sa, sb, lineIdx, haversine(a.lat, a.lon, b.lat, b.lon), true);
      lines[lineIdx].geometry.push(roundCoords([[a.lon, a.lat], [b.lon, b.lat]]));
    }
    console.log(`  extra route on ${route.line}: ${seq.length} of ${route.stations.length} stations found`);
  }
  const railStopCount = stops.length;

  // Buses: directed hops along every route's stop sequence.
  let busCount = 0;
  let busHops = 0;
  for (const line of busLines) {
    const seq = await cached(`tfl-bus-${line.id}.json`, async () => {
      await sleep(350);
      process.stdout.write(`\rTfL: fetching bus ${line.name}      `);
      return trimSequence(await getJSON(`https://api.tfl.gov.uk/Line/${line.id}/Route/Sequence/all?excludeCrowding=true`));
    });
    if (!seq || !seq.stopPointSequences) continue;
    const lineIdx = lines.length;
    let count = 0;
    for (const branch of seq.stopPointSequences) {
      const sp = branch.stopPoint;
      for (let i = 0; i + 1 < sp.length; i++) {
        const a = sp[i];
        const b = sp[i + 1];
        if (!inBox(a.lat, a.lon) || !inBox(b.lat, b.lon)) continue;
        const sa = stopFor({ id: a.id, lat: a.lat, lon: a.lon });
        const sb = stopFor({ id: b.id, lat: b.lat, lon: b.lon });
        if (sa === sb) continue;
        addRide(sa, sb, lineIdx, haversine(a.lat, a.lon, b.lat, b.lon), false);
        count++;
      }
    }
    if (!count) continue;
    lines.push({ id: line.id, name: line.name, mode: 'bus', colour: BUS_COLOUR, wait: lineWait({ ...line, modeName: 'bus' }) });
    busCount++;
    busHops += count;
  }
  console.log(`\nTfL: ${lines.length} lines (${busCount} bus routes, ${busHops} bus hops), ${stations.length} stations, ${stops.length - railStopCount} bus stops, ${platforms.length} platforms, ${rides.length} rides`);
  return { generated: new Date().toISOString(), lines, stops, stations, platforms, rides };
}

// ---------------------------------------------------------------- base geography

// OSM water-area relations for each reach of the Thames from Chertsey to Dartford, plus the
// Isle of Dogs reach, which is a single closed way.
const THAMES_RELATIONS = [2006294, 2001594, 2001806, 2001566, 28938, 2110237, 308126, 318374, 28934, 70347, 11511596, 2727629];
const THAMES_WAYS = [199827370];

const PARK_NAMES = ["Hyde Park", "The Regent's Park", "Regent's Park", 'Richmond Park', 'Hampstead Heath', 'Greenwich Park',
  'Victoria Park', 'Battersea Park', 'Clapham Common', 'Wimbledon Common', 'Bushy Park', 'Kensington Gardens', "St James's Park",
  'The Green Park', 'Green Park', 'Finsbury Park', 'Alexandra Park', 'Crystal Palace Park', 'Wormwood Scrubs', 'Blackheath',
  'Brockwell Park', 'Dulwich Park', 'Burgess Park', 'Queen Elizabeth Olympic Park', 'Wanstead Flats', 'Hackney Marshes',
  'Trent Park', 'Osterley Park', 'Gunnersbury Park', 'Holland Park', 'Primrose Hill', 'Peckham Rye Park', 'Tooting Bec Common',
  'Tooting Common', 'Streatham Common', 'Mitcham Common', 'Morden Hall Park', 'Hainault Forest Country Park', 'Valentines Park',
  'Royal Botanic Gardens', 'Kew Gardens', 'Wandsworth Common', 'Southwark Park', 'Lloyd Park', 'Danson Park', 'Hampton Court Park',
  'Home Park', 'Walthamstow Marshes', 'Woolwich Common', 'Eltham Common', 'Oxleas Wood', 'Beckenham Place Park',
  'South Norwood Country Park', 'Ruislip Woods', 'Bentley Priory', 'Fryent Country Park', 'Horsenden Hill', 'Highgate Wood',
  "Queen's Wood", 'Cannizaro Park', 'Nonsuch Park', 'Coulsdon Common', 'Farthing Downs', 'Epping Forest', 'Lee Valley Park'];

async function buildBase() {
  console.log('ONS: borough boundaries');
  const ons = await cached('ons-boroughs.json', () => getJSON(
    'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Local_Authority_Districts_December_2023_Boundaries_UK_BSC/FeatureServer/0/query'
    + "?where=LAD23CD%20LIKE%20'E09%25'&outFields=LAD23CD,LAD23NM&outSR=4326&f=geojson"));
  const boroughs = ons.features.map((f) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return {
      name: f.properties.LAD23NM,
      polygons: polys.map((rings) => rings.map((r) => roundCoords(simplify(r, 15)))),
    };
  });

  console.log('OSM: River Thames');
  const thamesRaw = await cached('osm-thames.json', () => overpass(
    `[out:json][timeout:240];rel(id:${THAMES_RELATIONS.join(',')})->.r;.r out body;`
    + `(way(r.r)(${bboxStr});way(id:${THAMES_WAYS.join(',')}););out geom;`));
  const wayById = new Map(thamesRaw.elements.filter((e) => e.type === 'way' && e.geometry).map((w) => [w.id, w]));
  const thamesPolygons = [];
  for (const relation of thamesRaw.elements.filter((e) => e.type === 'relation')) {
    const memberWays = relation.members.map((m) => ({ role: m.role, way: wayById.get(m.ref) })).filter((m) => m.way);
    const outerChains = chainWays(memberWays.filter((m) => m.role !== 'inner').map((m) => osmCoords(m.way.geometry)));
    const outerRings = outerChains.filter((c) => c.closed).map((c) => c.coords)
      .concat(joinOpenChains(outerChains.filter((c) => !c.closed).map((c) => c.coords)));
    const innerRings = chainWays(memberWays.filter((m) => m.role === 'inner').map((m) => osmCoords(m.way.geometry)))
      .filter((c) => c.closed).map((c) => c.coords);
    for (const outer of outerRings) {
      const rings = finishPolygon([outer, ...innerRings.filter((r) => pointInRing(r[0], outer))], 10);
      if (rings.length && ringArea(rings[0]) > 20000) thamesPolygons.push(rings);
    }
  }
  for (const id of THAMES_WAYS) {
    const way = wayById.get(id);
    if (!way) continue;
    const rings = finishPolygon([osmCoords(way.geometry)], 10);
    if (rings.length) thamesPolygons.push(rings);
  }
  console.log(`  Thames: ${thamesPolygons.length} polygons`);

  const centreRaw = await cached('osm-thames-centreline.json', () =>
    overpass(`[out:json][timeout:120];way["waterway"="river"]["name"="River Thames"](${bboxStr});out geom;`));
  const centreChains = chainWays(centreRaw.elements.filter((e) => e.type === 'way' && e.geometry).map((w) => osmCoords(w.geometry)));
  const thamesCentreline = centreChains.flatMap((c) => clipLineToBox(c.coords)).map((c) => roundCoords(simplify(c, 20)));

  console.log('OSM: other water');
  let water = [];
  try {
    const waterRaw = await cached('osm-water.json', () => overpass(
      `[out:json][timeout:240];(way["natural"="water"](${bboxStr})(if:length()>1200);rel["natural"="water"](${bboxStr});wr["waterway"="dock"](${bboxStr}););out geom;`));
    const skip = new Set([...THAMES_RELATIONS, ...THAMES_WAYS]);
    water = osmPolygons(waterRaw.elements)
      .filter((p) => !skip.has(p.id))
      .map((p) => finishPolygon(p.rings, 12))
      .filter((rings) => rings.length && ringArea(rings[0]) > 15000);
    console.log(`  water bodies: ${water.length}`);
  } catch (err) {
    console.warn(`  water bodies unavailable (${err.message}); continuing with the Thames only`);
  }

  console.log('OSM: parks');
  const nameRegex = `^(${PARK_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
  const parksRaw = await cached('osm-parks.json', () => overpass(
    `[out:json][timeout:180];(wr["leisure"~"^(park|nature_reserve|common|garden)$"]["name"~"${nameRegex}"](${bboxStr});`
    + `wr["natural"~"^(wood|heath)$"]["name"~"^(Epping Forest|Hampstead Heath|Wimbledon Common|Oxleas Wood|Highgate Wood|Queen's Wood|Ruislip Woods)$"](${bboxStr}););out geom;`));
  const parks = osmPolygons(parksRaw.elements)
    .map((p) => ({ name: p.name, rings: finishPolygon(p.rings, 12) }))
    .filter((p) => p.rings.length && ringArea(p.rings[0]) > 80000)
    .sort((a, b) => ringArea(b.rings[0]) - ringArea(a.rings[0]));
  console.log(`  parks: ${parks.length}`);

  console.log('OSM: roads');
  const roadsRaw = await cached('osm-roads.json', () => overpass(
    `[out:json][timeout:180];way["highway"~"^(motorway|trunk|motorway_link|trunk_link)$"](${bboxStr});out geom;`));
  const roadWays = roadsRaw.elements.filter((e) => e.type === 'way' && e.geometry && /^(motorway|trunk)$/.test(e.tags?.highway || ''));
  const byClass = { motorway: [], trunk: [] };
  for (const w of roadWays) byClass[w.tags.highway].push(osmCoords(w.geometry));
  const roads = {};
  for (const cls of Object.keys(byClass)) {
    const chains = chainWays(byClass[cls]);
    roads[cls] = chains.flatMap((c) => clipLineToBox(c.coords)).map((c) => roundCoords(simplify(c, 15))).filter((c) => c.length >= 2);
    console.log(`  ${cls}: ${roads[cls].length} lines, ${roads[cls].reduce((a, c) => a + c.length, 0)} vertices`);
  }

  return { bbox: BBOX, boroughs, thames: { polygons: thamesPolygons, centreline: thamesCentreline }, water, parks, roads };
}

// ---------------------------------------------------------------- walking grid

async function buildGrid(base) {
  console.log('Grid: rasterising water');
  const grid = WalkGrid.create(BBOX);
  const blocked = new Uint8Array(grid.count);
  for (const rings of base.thames.polygons) rasterisePolygon(grid, rings, blocked, 1);
  for (const rings of base.water) rasterisePolygon(grid, rings, blocked, 1);
  const waterCells = blocked.reduce((a, b) => a + b, 0);

  console.log('OSM: pedestrian bridges and foot tunnels');
  let crossings = 0;
  try {
    const bridgesRaw = await cached('osm-bridges.json', () => overpass(
      `[out:json][timeout:240];(way["bridge"~"^(yes|viaduct|movable|cantilever|suspension)$"]`
      + `["highway"~"^(primary|secondary|tertiary|residential|unclassified|pedestrian|footway|path|cycleway|living_street|service|steps|primary_link|secondary_link|tertiary_link|track|bridleway)$"]`
      + `["foot"!="no"](${bboxStr});way["tunnel"="yes"]["highway"~"^(footway|path|pedestrian|cycleway|steps)$"](${bboxStr}););out geom;`));
    const open = new Uint8Array(grid.count);
    for (const way of bridgesRaw.elements) {
      if (way.type === 'way' && way.geometry) rasteriseLine(grid, osmCoords(way.geometry), open, 1);
    }
    for (let c = 0; c < grid.count; c++) if (open[c] && blocked[c]) { blocked[c] = 0; crossings++; }
  } catch (err) {
    console.warn(`  bridges unavailable (${err.message}); water stays uncrossable`);
  }
  for (let c = 0; c < grid.count; c++) grid.mask[c] = blocked[c] ? 0 : 1;
  for (const b of base.boroughs) for (const rings of b.polygons) rasterisePolygon(grid, rings, grid.london, 1);
  const londonCells = grid.london.reduce((a, b) => a + b, 0);
  console.log(`  ${grid.cols} x ${grid.rows} cells of ${grid.cell} m; ${waterCells} water cells, ${crossings} reopened by crossings, ${londonCells} cells in Greater London`);
  return grid;
}

// ---------------------------------------------------------------- main

const base = await buildBase();
fs.writeFileSync(path.join(OUT, 'base.json'), JSON.stringify(base));
const grid = await buildGrid(base);
fs.writeFileSync(path.join(OUT, 'walkgrid.json'), JSON.stringify(grid.toJSON()));
const transit = await buildTransit();
fs.writeFileSync(path.join(OUT, 'transit.json'), JSON.stringify(packTransit(transit)));
const places = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'places.json'), 'utf8'));
fs.writeFileSync(path.join(OUT, 'places.json'), JSON.stringify(places));
for (const stale of ['network.json']) {
  const f = path.join(OUT, stale);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

for (const f of ['base.json', 'walkgrid.json', 'transit.json', 'places.json']) {
  console.log(`${f}: ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)} KB`);
}
