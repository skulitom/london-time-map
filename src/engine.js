// Unified routing engine: one Dijkstra search over the walking grid plus every transit platform.
//
// Graph nodes are indices into one array:
//   0 .. C-1      walking-grid cells (see walkgrid.js); moving between neighbours costs walking time
//   C .. C+P-1    platforms, one per (stop, line); boarding from the stop's cell costs the line's
//                 typical wait, rides follow the real stop sequences, alighting returns to the cell
// With "By foot" unticked, walking is limited to a short leg from the origin or from the last stop.

import { GROUP_OF_MODE, PLATFORM_ACCESS, PLATFORM_EXIT, WALK, CENTRE, walkStepMinutes, hopMinutes } from './model.js';

const KX = 111320 * Math.cos((51.5 * Math.PI) / 180);
const KY = 110574;
export const METRES_PER_DEG = { x: KX, y: KY };
export const toMetres = (lon, lat) => [(lon - CENTRE.lon) * KX, (lat - CENTRE.lat) * KY];

export const LEG = { WALK: 1, BOARD: 2, ALIGHT: 3, RIDE: 4 };
const OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Priority queue for a search in which every step takes at least a known minimum time (Dial's
// algorithm). Keys are grouped into buckets narrower than that minimum: nodes in one bucket cannot
// reach each other any sooner, so a bucket can be settled in any order and needs no heap. Buckets
// are lists of entries, taken first in, first out. A node can be queued more than once; the caller
// skips entries for nodes already settled.
export class BucketQueue {
  constructor(width, capacity) {
    if (!(width > 0)) throw new Error('bucket width must be positive');
    this.perKey = 1 / width;
    this.head = new Int32Array(4096).fill(-1);
    this.tail = new Int32Array(4096).fill(-1);
    this.node = new Int32Array(capacity);
    this.next = new Int32Array(capacity);
    this.last = -1;
    this.clear();
  }

  clear() {
    this.head.fill(-1, 0, this.last + 1);
    this.tail.fill(-1, 0, this.last + 1);
    this.size = 0;     // entries written
    this.last = -1;    // highest bucket in use
    this.current = -1; // bucket being taken from
    this.cursor = -1;  // next entry in it
  }

  // Keys pushed while a bucket is being taken from must fall in a later bucket.
  push(node, key) {
    const b = (key * this.perKey) | 0;
    if (b >= this.head.length) {
      this.head = grow(this.head, b + 1, -1);
      this.tail = grow(this.tail, b + 1, -1);
    }
    if (this.size === this.node.length) {
      this.node = grow(this.node, this.size + 1);
      this.next = grow(this.next, this.size + 1);
    }
    const e = this.size++;
    this.node[e] = node;
    this.next[e] = -1;
    if (this.tail[b] < 0) this.head[b] = e;
    else this.next[this.tail[b]] = e;
    this.tail[b] = e;
    if (b > this.last) this.last = b;
  }

  // The next node, or -1 once the queue is empty.
  pop() {
    let e = this.cursor;
    while (e < 0) {
      if (this.current >= this.last) return -1;
      e = this.head[++this.current];
    }
    this.cursor = this.next[e];
    return this.node[e];
  }
}

function grow(array, minLength, fill = 0) {
  const grown = new Int32Array(Math.max(2 * array.length, minLength));
  if (fill) grown.fill(fill);
  grown.set(array);
  return grown;
}

export class Engine {
  // transit: as returned by unpackTransit (see transit.js).
  constructor(transit, grid) {
    this.grid = grid;
    this.lines = transit.lines;
    const C = (this.C = grid.count);
    const { stopLat, stopLon, platformStop, platformLine, rideFrom, rideTo, rideMetres } = transit;

    const S = stopLat.length;
    this.stopLat = stopLat;
    this.stopLon = stopLon;
    this.stopCell = new Int32Array(S);
    const stopRc = new Float64Array(S);
    for (let s = 0; s < S; s++) {
      this.stopCell[s] = grid.nearestWalkable(grid.cellOf(stopLon[s], stopLat[s]));
      const [x, y] = toMetres(stopLon[s], stopLat[s]);
      stopRc[s] = Math.hypot(x, y);
    }

    const P = (this.P = platformStop.length);
    this.platformStop = platformStop;
    this.platformLine = platformLine;
    const perCell = new Int32Array(C + 1);
    for (let p = 0; p < P; p++) {
      const cell = this.stopCell[platformStop[p]];
      if (cell >= 0) perCell[cell + 1]++;
    }
    for (let c = 0; c < C; c++) perCell[c + 1] += perCell[c];
    this.cellPlatformStart = perCell;
    this.cellPlatforms = new Int32Array(P);
    const fill = perCell.slice(0, C);
    for (let p = 0; p < P; p++) {
      const cell = this.stopCell[this.platformStop[p]];
      if (cell >= 0) this.cellPlatforms[fill[cell]++] = p;
    }

    const R = rideFrom.length;
    const perPlatform = new Int32Array(P + 1);
    for (let r = 0; r < R; r++) perPlatform[rideFrom[r] + 1]++;
    for (let p = 0; p < P; p++) perPlatform[p + 1] += perPlatform[p];
    this.rideStart = perPlatform;
    this.rideTo = new Int32Array(R);
    this.rideT = new Float32Array(R);
    const rfill = perPlatform.slice(0, P);
    for (let r = 0; r < R; r++) {
      const from = rideFrom[r];
      const to = rideTo[r];
      const k = rfill[from]++;
      this.rideTo[k] = to;
      const mode = this.lines[platformLine[from]].mode;
      this.rideT[k] = hopMinutes(mode, rideMetres[r], (stopRc[platformStop[from]] + stopRc[platformStop[to]]) / 2);
    }

    // The walkable neighbours of every cell as a bitmask in OFFSETS order, with the bounds, the
    // water mask and the no-squeezing rule for diagonals already applied, so the search tests one bit
    // per neighbour.
    const { cols, rows, mask } = grid;
    const neighbours = (this.neighbours = new Uint8Array(C));
    for (let j = 0, u = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++, u++) {
        const east = i + 1 < cols && mask[u + 1];
        const west = i > 0 && mask[u - 1];
        const south = j + 1 < rows && mask[u + cols];
        const north = j > 0 && mask[u - cols];
        neighbours[u] = (east ? 1 : 0) | (west ? 2 : 0) | (south ? 4 : 0) | (north ? 8 : 0)
          | (east && south && mask[u + cols + 1] ? 16 : 0) | (east && north && mask[u - cols + 1] ? 32 : 0)
          | (west && south && mask[u + cols - 1] ? 64 : 0) | (west && north && mask[u - cols - 1] ? 128 : 0);
      }
    }
    this.neighbourStep = Int32Array.from(OFFSETS, ([di, dj]) => di + dj * cols);

    this.size = C + P;
    this.dist = new Float64Array(this.size);
    this.walked = new Float32Array(this.size);
    this.prev = new Int32Array(this.size);
    this.via = new Int8Array(this.size);
    this.viaLine = new Int16Array(this.size);
    this.settled = new Uint8Array(this.size);
    this.stepMinutes = walkStepMinutes(grid.cell);

    // The quickest step anywhere in the graph sets how narrow the queue's buckets must be.
    let quickest = Math.min(this.stepMinutes, PLATFORM_EXIT, ...this.lines.map((l) => l.wait + PLATFORM_ACCESS));
    for (let r = 0; r < R; r++) quickest = Math.min(quickest, this.rideT[r]);
    this.queue = new BucketQueue(0.75 * quickest, 1 << 18);
  }

  // Shortest times from a grid cell. Returns typed arrays owned by the engine (valid until the next call).
  //
  // Dijkstra's search, with a bucket queue in place of a heap: about twice as fast, and every time
  // comes out the same. Where two routes to a place are exactly as quick, which one is recorded
  // depends on the order places are settled in, so it can differ from a heap's choice.
  route(originCell, enabled) {
    const { grid, C, dist, walked, prev, via, viaLine, lines, queue, settled, neighbours, neighbourStep } = this;
    const { mask } = grid;
    const cap = enabled.foot ? Infinity : WALK.accessLimit;
    const groupOn = lines.map((l) => !!enabled[GROUP_OF_MODE[l.mode]]);
    const lineWait = lines.map((l) => l.wait + PLATFORM_ACCESS);
    dist.fill(Infinity);
    walked.fill(Infinity);
    prev.fill(-1);
    via.fill(0);
    viaLine.fill(-1);
    settled.fill(0);
    queue.clear();
    if (originCell < 0 || !mask[originCell]) return { dist, prev, via, viaLine, originCell, enabled };
    dist[originCell] = 0;
    walked[originCell] = 0;
    queue.push(originCell, 0);

    const step = this.stepMinutes;
    const diag = step * Math.SQRT2;
    const { cellPlatformStart, cellPlatforms, platformLine, platformStop, stopCell, rideStart, rideTo, rideT } = this;

    for (let u = queue.pop(); u >= 0; u = queue.pop()) {
      if (settled[u]) continue;
      settled[u] = 1;
      const t = dist[u];
      if (u < C) {
        const bits = neighbours[u];
        const w = walked[u];
        for (let k = 0; k < 8; k++) {
          if (!(bits & (1 << k))) continue;
          const v = u + neighbourStep[k];
          const s = k >= 4 ? diag : step;
          const nw = w + s;
          if (nw > cap) continue;
          const nt = t + s;
          if (nt < dist[v]) {
            dist[v] = nt;
            walked[v] = nw;
            prev[v] = u;
            via[v] = LEG.WALK;
            viaLine[v] = -1;
            queue.push(v, nt);
          }
        }
        for (let q = cellPlatformStart[u]; q < cellPlatformStart[u + 1]; q++) {
          const p = cellPlatforms[q];
          const line = platformLine[p];
          if (!groupOn[line]) continue;
          const v = C + p;
          const nt = t + lineWait[line];
          if (nt < dist[v]) {
            dist[v] = nt;
            walked[v] = 0;
            prev[v] = u;
            via[v] = LEG.BOARD;
            viaLine[v] = line;
            queue.push(v, nt);
          }
        }
      } else {
        const p = u - C;
        const line = platformLine[p];
        const cell = stopCell[platformStop[p]];
        const nt = t + PLATFORM_EXIT;
        if (cell >= 0 && nt < dist[cell]) {
          dist[cell] = nt;
          walked[cell] = 0;
          prev[cell] = u;
          via[cell] = LEG.ALIGHT;
          viaLine[cell] = line;
          queue.push(cell, nt);
        }
        for (let r = rideStart[p]; r < rideStart[p + 1]; r++) {
          const v = C + rideTo[r];
          const rt = t + rideT[r];
          if (rt < dist[v]) {
            dist[v] = rt;
            walked[v] = 0;
            prev[v] = u;
            via[v] = LEG.RIDE;
            viaLine[v] = line;
            queue.push(v, rt);
          }
        }
      }
    }
    return { dist, prev, via, viaLine, originCell, enabled };
  }

  // Journey to a grid cell as legs and drawable path segments (points as [lon, lat]).
  journey(result, cell) {
    const { dist, prev, via, viaLine, originCell } = result;
    if (cell < 0 || !Number.isFinite(dist[cell])) return null;
    const chain = [];
    let u = cell;
    let guard = 0;
    while (u !== originCell && u >= 0 && guard++ < 100000) {
      chain.push(u);
      u = prev[u];
    }
    chain.push(originCell);
    chain.reverse();

    const legs = [];
    const segments = [];
    const C = this.C;
    const cellPoint = (c) => this.grid.centre(c);
    const stopPoint = (p) => [this.stopLon[this.platformStop[p]], this.stopLat[this.platformStop[p]]];
    for (let k = 1; k < chain.length; k++) {
      const v = chain[k];
      const kind = via[v];
      const line = viaLine[v];
      const dt = dist[v] - dist[chain[k - 1]];
      const lastLeg = legs[legs.length - 1];
      const lastSeg = segments[segments.length - 1];
      if (kind === LEG.WALK) {
        if (lastLeg && lastLeg.kind === 'walk') lastLeg.minutes += dt;
        else legs.push({ kind: 'walk', minutes: dt });
        if (lastSeg && lastSeg.kind === 'walk') lastSeg.points.push(cellPoint(v));
        else segments.push({ kind: 'walk', points: [cellPoint(chain[k - 1]), cellPoint(v)] });
      } else if (kind === LEG.BOARD) {
        legs.push({ kind: 'ride', line, minutes: dt, stops: 0 });
        segments.push({ kind: 'ride', line, points: [stopPoint(v - C)] });
      } else if (kind === LEG.RIDE) {
        if (lastLeg) {
          lastLeg.minutes += dt;
          lastLeg.stops++;
        }
        if (lastSeg && lastSeg.kind === 'ride') lastSeg.points.push(stopPoint(v - C));
      } else if (kind === LEG.ALIGHT) {
        if (lastLeg) lastLeg.minutes += dt;
      }
    }
    return { legs, segments };
  }
}
