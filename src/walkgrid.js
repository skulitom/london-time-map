// Walking cost grid shared by the build script (Node) and the browser.
//
// London is covered by a regular grid of square cells (150 m). Cells whose centre lies in water are
// impassable, except where a pedestrian bridge or foot tunnel crosses. Walking time between cells is
// computed with Dijkstra over the 8-neighbourhood, so a walk across the Thames has to find a bridge.

export const GRID_CELL = 150; // metres
const KX = 111320 * Math.cos((51.5 * Math.PI) / 180);
const KY = 110574;
const OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class Heap {
  constructor(capacity) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.size = 0;
  }
  grow() {
    const keys = new Float64Array(this.keys.length * 2);
    const vals = new Int32Array(this.vals.length * 2);
    keys.set(this.keys);
    vals.set(this.vals);
    this.keys = keys;
    this.vals = vals;
  }
  push(val, key) {
    if (this.size === this.keys.length) this.grow();
    const k = this.keys;
    const v = this.vals;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop() {
    const k = this.keys;
    const v = this.vals;
    const topVal = v[0];
    const topKey = k[0];
    const n = --this.size;
    if (n > 0) {
      const key = k[n];
      const val = v[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= key) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = key;
      v[i] = val;
    }
    this.lastKey = topKey;
    return topVal;
  }
}

export function encodeBits(bytes) {
  const packed = new Uint8Array(Math.ceil(bytes.length / 8));
  for (let i = 0; i < bytes.length; i++) if (bytes[i]) packed[i >> 3] |= 1 << (i & 7);
  if (typeof Buffer !== 'undefined') return Buffer.from(packed).toString('base64');
  let s = '';
  for (let i = 0; i < packed.length; i++) s += String.fromCharCode(packed[i]);
  return btoa(s);
}

export function decodeBits(base64, length) {
  let packed;
  if (typeof Buffer !== 'undefined') packed = Buffer.from(base64, 'base64');
  else {
    const s = atob(base64);
    packed = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) packed[i] = s.charCodeAt(i);
  }
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (packed[i >> 3] >> (i & 7)) & 1;
  return out;
}

export class WalkGrid {
  constructor({ cols, rows, cell, lon0, lat0, mask, london }) {
    this.cols = cols;
    this.rows = rows;
    this.cell = cell;
    this.lon0 = lon0;
    this.lat0 = lat0;
    this.mask = mask; // 1 = walkable
    this.london = london; // 1 = inside Greater London (for statistics)
    this.count = cols * rows;
  }

  static create(bbox, cell = GRID_CELL) {
    const cols = Math.ceil(((bbox.e - bbox.w) * KX) / cell);
    const rows = Math.ceil(((bbox.n - bbox.s) * KY) / cell);
    return new WalkGrid({
      cols, rows, cell, lon0: bbox.w, lat0: bbox.s,
      mask: new Uint8Array(cols * rows).fill(1),
      london: new Uint8Array(cols * rows),
    });
  }

  static fromJSON(json) {
    const count = json.cols * json.rows;
    return new WalkGrid({
      cols: json.cols, rows: json.rows, cell: json.cell, lon0: json.lon0, lat0: json.lat0,
      mask: decodeBits(json.mask, count),
      london: json.london ? decodeBits(json.london, count) : new Uint8Array(count),
    });
  }

  toJSON() {
    return {
      cols: this.cols, rows: this.rows, cell: this.cell, lon0: this.lon0, lat0: this.lat0,
      mask: encodeBits(this.mask), london: encodeBits(this.london),
    };
  }

  // Grid column/row of a longitude/latitude (may fall outside the grid).
  colRow(lon, lat) {
    return [Math.floor(((lon - this.lon0) * KX) / this.cell), Math.floor(((lat - this.lat0) * KY) / this.cell)];
  }

  cellOf(lon, lat) {
    const [i, j] = this.colRow(lon, lat);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -1;
    return j * this.cols + i;
  }

  // Longitude/latitude of a point in grid units (cell centres are at i + 0.5, j + 0.5).
  lonLatOfGrid(x, y) {
    return [this.lon0 + (x * this.cell) / KX, this.lat0 + (y * this.cell) / KY];
  }

  centre(index) {
    return this.lonLatOfGrid((index % this.cols) + 0.5, Math.floor(index / this.cols) + 0.5);
  }

  // Nearest walkable cell to a cell index, searching outwards in rings.
  nearestWalkable(index, maxRadius = 8) {
    if (index < 0) return -1;
    if (this.mask[index]) return index;
    const i0 = index % this.cols;
    const j0 = Math.floor(index / this.cols);
    for (let r = 1; r <= maxRadius; r++) {
      let best = -1;
      let bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = i0 + di;
          const j = j0 + dj;
          if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) continue;
          const c = j * this.cols + i;
          if (!this.mask[c]) continue;
          const d = di * di + dj * dj;
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  // Multi-source Dijkstra. seeds: [[cell, startMinutes], ...]. stepMinutes: cost of one orthogonal
  // step. cap: maximum minutes of walking from any seed (Infinity for unlimited). limit: stop
  // expanding beyond this arrival time. Returns Float32Array of arrival minutes (Infinity = unreached).
  dijkstra(seeds, { stepMinutes, cap = Infinity, limit = Infinity }) {
    const { cols, rows, mask, count } = this;
    // Times must be stored at the heap's precision, otherwise rounding makes valid entries look stale.
    const time = new Float64Array(count).fill(Infinity);
    const walked = cap < Infinity ? new Float32Array(count).fill(Infinity) : null;
    const heap = new Heap(Math.max(1024, count >> 2));
    for (const [c, t0] of seeds) {
      if (c < 0 || !mask[c] || !(t0 < time[c])) continue;
      time[c] = t0;
      if (walked) walked[c] = 0;
      heap.push(c, t0);
    }
    const diag = stepMinutes * Math.SQRT2;
    while (heap.size) {
      const c = heap.pop();
      const t = heap.lastKey;
      if (t > time[c] || t > limit) continue;
      const i = c % cols;
      const j = (c - i) / cols;
      const w = walked ? walked[c] : 0;
      for (let k = 0; k < 8; k++) {
        const di = OFFSETS[k][0];
        const dj = OFFSETS[k][1];
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const nc = nj * cols + ni;
        if (!mask[nc]) continue;
        const diagonal = k >= 4;
        // A diagonal step may not squeeze between two blocked cells.
        if (diagonal && (!mask[c + di] || !mask[c + dj * cols])) continue;
        const step = diagonal ? diag : stepMinutes;
        const nw = w + step;
        if (walked && nw > cap) continue;
        const nt = t + step;
        if (nt < time[nc]) {
          time[nc] = nt;
          if (walked) walked[nc] = nw;
          heap.push(nc, nt);
        }
      }
    }
    return time;
  }
}

// ---------------------------------------------------------------- rasterisation (build time)

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Marks cells whose centre lies inside a polygon (rings of [lon, lat]; first ring outer, rest holes).
export function rasterisePolygon(grid, rings, target, value) {
  const outer = rings[0];
  let minI = Infinity;
  let maxI = -Infinity;
  let minJ = Infinity;
  let maxJ = -Infinity;
  for (const [lon, lat] of outer) {
    const [i, j] = grid.colRow(lon, lat);
    if (i < minI) minI = i;
    if (i > maxI) maxI = i;
    if (j < minJ) minJ = j;
    if (j > maxJ) maxJ = j;
  }
  minI = Math.max(0, minI);
  minJ = Math.max(0, minJ);
  maxI = Math.min(grid.cols - 1, maxI);
  maxJ = Math.min(grid.rows - 1, maxJ);
  for (let j = minJ; j <= maxJ; j++) {
    for (let i = minI; i <= maxI; i++) {
      const [lon, lat] = grid.lonLatOfGrid(i + 0.5, j + 0.5);
      if (!pointInRing(lon, lat, outer)) continue;
      let inHole = false;
      for (let h = 1; h < rings.length && !inHole; h++) inHole = pointInRing(lon, lat, rings[h]);
      if (!inHole) target[j * grid.cols + i] = value;
    }
  }
}

// Marks every cell touched by a polyline of [lon, lat] points.
export function rasteriseLine(grid, coords, target, value) {
  for (let s = 0; s + 1 < coords.length; s++) {
    const [lon1, lat1] = coords[s];
    const [lon2, lat2] = coords[s + 1];
    const dx = (lon2 - lon1) * KX;
    const dy = (lat2 - lat1) * KY;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (grid.cell / 3)));
    for (let k = 0; k <= steps; k++) {
      const c = grid.cellOf(lon1 + ((lon2 - lon1) * k) / steps, lat1 + ((lat2 - lat1) * k) / steps);
      if (c >= 0) target[c] = value;
    }
  }
}
