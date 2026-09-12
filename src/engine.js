// Unified routing engine: one Dijkstra search over the walking grid plus every transit platform.
//
// Graph nodes are indices into one array:
//   0 .. C-1      walking-grid cells (see walkgrid.js); moving between neighbours costs walking time
//   C .. C+P-1    platforms, one per (stop, line); boarding from the stop's cell costs the line's
//                 typical wait, rides follow the real stop sequences, alighting returns to the cell
// With "By foot" unticked, walking is limited to a short leg from the origin or from the last stop.

import { Heap } from './walkgrid.js';
import { GROUP_OF_MODE, PLATFORM_ACCESS, PLATFORM_EXIT, WALK, CENTRE, walkStepMinutes, hopMinutes } from './model.js';

const KX = 111320 * Math.cos((51.5 * Math.PI) / 180);
const KY = 110574;
export const METRES_PER_DEG = { x: KX, y: KY };
export const toMetres = (lon, lat) => [(lon - CENTRE.lon) * KX, (lat - CENTRE.lat) * KY];

export const LEG = { WALK: 1, BOARD: 2, ALIGHT: 3, RIDE: 4 };
const OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class Engine {
  constructor(transit, grid) {
    this.grid = grid;
    this.lines = transit.lines;
    const C = (this.C = grid.count);

    const S = transit.stops.length;
    this.stopLat = new Float64Array(S);
    this.stopLon = new Float64Array(S);
    this.stopCell = new Int32Array(S);
    const stopRc = new Float64Array(S);
    for (let s = 0; s < S; s++) {
      const [lat, lon] = transit.stops[s];
      this.stopLat[s] = lat;
      this.stopLon[s] = lon;
      this.stopCell[s] = grid.nearestWalkable(grid.cellOf(lon, lat));
      const [x, y] = toMetres(lon, lat);
      stopRc[s] = Math.hypot(x, y);
    }

    const P = (this.P = transit.platforms.length);
    this.platformStop = new Int32Array(P);
    this.platformLine = new Int16Array(P);
    const perCell = new Int32Array(C + 1);
    for (let p = 0; p < P; p++) {
      const [stop, line] = transit.platforms[p];
      this.platformStop[p] = stop;
      this.platformLine[p] = line;
      const cell = this.stopCell[stop];
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

    const R = transit.rides.length;
    const perPlatform = new Int32Array(P + 1);
    for (const [from] of transit.rides) perPlatform[from + 1]++;
    for (let p = 0; p < P; p++) perPlatform[p + 1] += perPlatform[p];
    this.rideStart = perPlatform;
    this.rideTo = new Int32Array(R);
    this.rideT = new Float32Array(R);
    const rfill = perPlatform.slice(0, P);
    for (const [from, to, metres] of transit.rides) {
      const k = rfill[from]++;
      this.rideTo[k] = to;
      const mode = this.lines[this.platformLine[from]].mode;
      this.rideT[k] = hopMinutes(mode, metres, (stopRc[this.platformStop[from]] + stopRc[this.platformStop[to]]) / 2);
    }

    this.size = C + P;
    this.dist = new Float64Array(this.size);
    this.walked = new Float32Array(this.size);
    this.prev = new Int32Array(this.size);
    this.via = new Int8Array(this.size);
    this.viaLine = new Int16Array(this.size);
    this.stepMinutes = walkStepMinutes(grid.cell);
  }

  // Shortest times from a grid cell. Returns typed arrays owned by the engine (valid until the next call).
  route(originCell, enabled) {
    const { grid, C, dist, walked, prev, via, viaLine, lines } = this;
    const { cols, rows, mask } = grid;
    const cap = enabled.foot ? Infinity : WALK.accessLimit;
    const groupOn = lines.map((l) => !!enabled[GROUP_OF_MODE[l.mode]]);
    const lineWait = lines.map((l) => l.wait + PLATFORM_ACCESS);
    dist.fill(Infinity);
    walked.fill(Infinity);
    prev.fill(-1);
    via.fill(0);
    viaLine.fill(-1);
    const heap = new Heap(Math.max(4096, C >> 2));
    if (originCell < 0 || !mask[originCell]) return { dist, prev, via, viaLine, originCell, enabled };
    dist[originCell] = 0;
    walked[originCell] = 0;
    heap.push(originCell, 0);

    const step = this.stepMinutes;
    const diag = step * Math.SQRT2;
    const { cellPlatformStart, cellPlatforms, platformLine, platformStop, stopCell, rideStart, rideTo, rideT } = this;

    while (heap.size) {
      const u = heap.pop();
      const t = heap.lastKey;
      if (t > dist[u]) continue;
      if (u < C) {
        const i = u % cols;
        const j = (u - i) / cols;
        const w = walked[u];
        for (let k = 0; k < 8; k++) {
          const di = OFFSETS[k][0];
          const dj = OFFSETS[k][1];
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const v = nj * cols + ni;
          if (!mask[v]) continue;
          const diagonal = k >= 4;
          if (diagonal && (!mask[u + di] || !mask[u + dj * cols])) continue;
          const s = diagonal ? diag : step;
          const nw = w + s;
          if (nw > cap) continue;
          const nt = t + s;
          if (nt < dist[v]) {
            dist[v] = nt;
            walked[v] = nw;
            prev[v] = u;
            via[v] = LEG.WALK;
            viaLine[v] = -1;
            heap.push(v, nt);
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
            heap.push(v, nt);
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
          heap.push(cell, nt);
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
            heap.push(v, rt);
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
