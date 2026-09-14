// File formats of data/transit.json and data/base.json, shared by the build script (Node) and the
// browser.
//
// Both files keep their bulk as columns of integers, each value written as its difference from the
// one before. Coordinates are counted in units of 1e-5 degrees, the precision the build rounds them
// to, so they decode to exactly the numbers the build wrote. Neighbouring entries are mostly
// neighbours on the ground or along a route, so the differences are small and repetitive: compressed,
// transit.json downloads at about a third of its plain size (215 KB rather than 600 KB) and base.json
// at 71 KB rather than 118 KB, and a few flat arrays of numbers parse far faster than tens of
// thousands of little ones.

const deltas = (values) => values.map((v, i) => (i ? v - values[i - 1] : v));

function sums(list, Type) {
  const out = new Type(list.length);
  let v = 0;
  for (let i = 0; i < list.length; i++) out[i] = v += list[i];
  return out;
}

// ---------------------------------------------------------------- transit.json

// Lines and stations are stored as they are; stops, platforms and rides as columns.
// transit: { generated, lines, stations, stops: [[lat, lon]], platforms: [[stop, line]], rides: [[from, to, metres]] }
export function packTransit({ generated, lines, stations, stops, platforms, rides }) {
  return {
    generated,
    lines,
    stations,
    stops: {
      lat: deltas(stops.map(([lat]) => Math.round(lat * 1e5))),
      lon: deltas(stops.map(([, lon]) => Math.round(lon * 1e5))),
    },
    platforms: { stop: deltas(platforms.map(([stop]) => stop)), line: deltas(platforms.map(([, line]) => line)) },
    rides: {
      from: deltas(rides.map(([from]) => from)),
      to: rides.map(([from, to]) => to - from), // a ride mostly goes to the next platform along
      metres: rides.map(([, , metres]) => metres),
    },
  };
}

// Returns { generated, lines, stations, stopLat, stopLon, platformStop, platformLine, rideFrom, rideTo, rideMetres }.
export function unpackTransit({ generated, lines, stations, stops, platforms, rides }) {
  const stopLat = sums(stops.lat, Float64Array);
  const stopLon = sums(stops.lon, Float64Array);
  for (let s = 0; s < stopLat.length; s++) {
    stopLat[s] /= 1e5;
    stopLon[s] /= 1e5;
  }
  const rideFrom = sums(rides.from, Int32Array);
  const rideTo = new Int32Array(rideFrom.length);
  for (let r = 0; r < rideTo.length; r++) rideTo[r] = rideFrom[r] + rides.to[r];
  return {
    generated,
    lines,
    stations,
    stopLat,
    stopLon,
    platformStop: sums(platforms.stop, Int32Array),
    platformLine: sums(platforms.line, Int32Array),
    rideFrom,
    rideTo,
    rideMetres: Int32Array.from(rides.metres),
  };
}

// ---------------------------------------------------------------- base.json

// A list of runs of [lon, lat] points (the rings of a polygon, or lines) as { n: points in each run,
// d: coordinate differences }, the differences carrying on from one run to the next.
export function packRuns(runs) {
  const n = [];
  const d = [];
  let px = 0;
  let py = 0;
  for (const run of runs) {
    n.push(run.length);
    for (const [lon, lat] of run) {
      const x = Math.round(lon * 1e5);
      const y = Math.round(lat * 1e5);
      d.push(x - px, y - py);
      px = x;
      py = y;
    }
  }
  return { n, d };
}

// Returns the point count of each run and all their points as interleaved lon, lat degrees.
export function unpackRuns({ n, d }) {
  const coords = new Float64Array(d.length);
  let x = 0;
  let y = 0;
  for (let i = 0; i < d.length; i += 2) {
    coords[i] = (x += d[i]) / 1e5;
    coords[i + 1] = (y += d[i + 1]) / 1e5;
  }
  return { counts: n, coords };
}

// Every ring and line of the base map as packed runs; names and the bounding box as they are.
export function packBase({ bbox, boroughs, thames, water, parks, roads }) {
  return {
    bbox,
    boroughs: boroughs.map(({ name, polygons }) => ({ name, polygons: polygons.map(packRuns) })),
    thames: { polygons: thames.polygons.map(packRuns), centreline: packRuns(thames.centreline) },
    water: water.map(packRuns),
    parks: parks.map(({ name, rings }) => ({ name, rings: packRuns(rings) })),
    roads: { motorway: packRuns(roads.motorway), trunk: packRuns(roads.trunk) },
  };
}
