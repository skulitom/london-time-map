// Filled contour bands of a grid of values: the rings d3.contours traces, found more cheaply.
//
// It is the same marching squares with the same interpolation along cell edges, so every vertex
// lands where d3 puts it. Two things d3 does are left out because the map has no use for them: the
// renderer fills each band's rings with the even-odd rule, so rings are not grouped into polygons
// with holes (which costs d3 a point-in-polygon test per hole), and rings are traced by following a
// table of successors instead of stitching fragments of arrays together.

// Segments crossing a square of four cells for each pattern of cells at or above the threshold, as in
// d3-contour. The pattern is bottom-left | bottom-right << 1 | top-right << 2 | top-left << 3, and a
// segment is [x0, y0, x1, y1] in half cells from the top-left corner of the top-left cell.
const CASES = [
  [],
  [2, 3, 1, 2],
  [3, 2, 2, 3],
  [3, 2, 1, 2],
  [2, 1, 3, 2],
  [2, 3, 1, 2, 2, 1, 3, 2],
  [2, 1, 2, 3],
  [2, 1, 1, 2],
  [1, 2, 2, 1],
  [2, 3, 2, 1],
  [1, 2, 2, 1, 3, 2, 2, 3],
  [3, 2, 2, 1],
  [1, 2, 3, 2],
  [2, 3, 3, 2],
  [1, 2, 2, 3],
  [],
];

let scratch = null;

// values: dx * dy grid, row by row. thresholds: ascending. Returns grid coordinates of all ring
// vertices (x, y pairs in the units d3.contours uses) and, for each threshold, its rings as
// (first vertex, vertex count) pairs.
export function contourBands(values, dx, dy, thresholds) {
  const W = dx + 2;
  const S = 2 * dx + 2; // the point x, y half cells from the grid's top-left corner has the id x + y * S
  const pointCount = (2 * dy + 1) * S;
  const blockCount = (dx + 1) * (dy + 1);
  if (!scratch || scratch.dx !== dx || scratch.dy !== dy) {
    scratch = {
      dx, dy,
      band: new Uint8Array(W * (dy + 2)),
      next: new Int32Array(pointCount),
      seen: new Uint32Array(pointCount),
      starts: new Int32Array(2 * blockCount),
      stamp: 0,
    };
  }
  const { band, next, seen, starts } = scratch;

  // How many thresholds each cell reaches, with a border of cells that reach none.
  const T = thresholds.length;
  for (let y = 0; y < dy; y++) {
    for (let x = 0, c = y * dx, p = (y + 1) * W + 1; x < dx; x++, c++, p++) {
      const v = values[c];
      let b = 0;
      while (b < T && v >= thresholds[b]) b++;
      band[p] = b;
    }
  }

  let coords = new Float64Array(1 << 16);
  let at = 0; // vertices written
  const bands = [];
  for (let k = 0; k < T; k++) {
    const value = thresholds[k];
    let segments = 0;
    for (let by = 0; by <= dy; by++) {
      const top = by * W;
      const bottom = top + W;
      let tl = band[top] > k;
      let bl = band[bottom] > k;
      for (let bx = 0; bx <= dx; bx++) {
        const tr = band[top + bx + 1] > k;
        const br = band[bottom + bx + 1] > k;
        const code = (bl ? 1 : 0) | (br ? 2 : 0) | (tr ? 4 : 0) | (tl ? 8 : 0);
        tl = tr;
        bl = br;
        if (code === 0 || code === 15) continue;
        const list = CASES[code];
        const ox = 2 * bx - 2;
        const oy = (2 * by - 2) * S;
        for (let i = 0; i < list.length; i += 4) {
          const from = ox + list[i] + oy + list[i + 1] * S;
          next[from] = ox + list[i + 2] + oy + list[i + 3] * S;
          starts[segments++] = from;
        }
      }
    }

    if (coords.length < 2 * (at + segments)) {
      const grown = new Float64Array(Math.max(2 * coords.length, 2 * (at + segments)));
      grown.set(coords.subarray(0, 2 * at));
      coords = grown;
    }
    const stamp = ++scratch.stamp;
    const rings = [];
    for (let s = 0; s < segments; s++) {
      const first = starts[s];
      if (seen[first] === stamp) continue;
      const ringStart = at;
      let id = first;
      do {
        seen[id] = stamp;
        const X = id % S;
        const Y = (id - X) / S;
        let gx = X / 2;
        let gy = Y / 2;
        if (X & 1) {
          // On an edge between a cell and the one below it.
          if (Y > 0 && Y < 2 * dy) {
            const c = (Y / 2) * dx + (X - 1) / 2;
            const v0 = values[c - dx];
            gy = gy + (value - v0) / (values[c] - v0) - 0.5;
          }
        } else if (X > 0 && X < 2 * dx) {
          // On an edge between a cell and the one to its right.
          const c = ((Y - 1) / 2) * dx + X / 2;
          const v0 = values[c - 1];
          gx = gx + (value - v0) / (values[c] - v0) - 0.5;
        }
        coords[2 * at] = gx;
        coords[2 * at + 1] = gy;
        at++;
        id = next[id];
      } while (seen[id] !== stamp); // back at the first point
      rings.push(ringStart, at - ringStart);
    }
    bands.push(Int32Array.from(rings));
  }
  return { coords: coords.slice(0, 2 * at), bands };
}
