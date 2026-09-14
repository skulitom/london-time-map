// File format of data/transit.json, shared by the build script (Node) and the browser.
//
// Lines and stations are stored as they are. The three big tables are stored as columns of integers,
// each value written as its difference from the one before: stop coordinates (in units of 1e-5
// degrees, the precision the build rounds them to), platforms and rides. Neighbouring entries are
// mostly neighbours on the ground or on a route, so the differences are small and repetitive: the
// file downloads at about a third of the size (215 KB gzipped rather than 600 KB), and a handful of
// flat arrays of numbers parses in half the time of a hundred thousand little ones.

const deltas = (values) => values.map((v, i) => (i ? v - values[i - 1] : v));

function sums(list, Type) {
  const out = new Type(list.length);
  let v = 0;
  for (let i = 0; i < list.length; i++) out[i] = v += list[i];
  return out;
}

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
  const rideTo = Int32Array.from(rides.to, (d, i) => rideFrom[i] + d);
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
