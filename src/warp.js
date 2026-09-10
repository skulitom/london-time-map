// Mesh warp: a Delaunay triangulation over the control points (stations, places and a ring of
// anchors around the map). Every map vertex is bound once to the triangle that contains it in
// geographic space and stored as barycentric weights. Moving the control points then moves every
// vertex with the same weights, which is cheap enough to do every animation frame.

export class Warp {
  constructor(xs, ys) {
    this.n = xs.length;
    const points = new Float64Array(this.n * 2);
    for (let i = 0; i < this.n; i++) {
      points[2 * i] = xs[i];
      points[2 * i + 1] = ys[i];
    }
    this.points = points;
    this.delaunay = new d3.Delaunay(points);
    this.tri = this.delaunay.triangles;
    this.half = this.delaunay.halfedges;
    this.triCount = this.tri.length / 3;
    this.pointTri = new Int32Array(this.n).fill(-1);
    for (let e = 0; e < this.tri.length; e++) {
      const p = this.tri[e];
      if (this.pointTri[p] < 0) this.pointTri[p] = (e / 3) | 0;
    }
  }

  // Barycentric weights of (x, y) in triangle t, using the given coordinate arrays.
  bary(t, x, y, px, py, out) {
    const a = this.tri[3 * t];
    const b = this.tri[3 * t + 1];
    const c = this.tri[3 * t + 2];
    const ax = px[a];
    const ay = py[a];
    const v0x = px[b] - ax;
    const v0y = py[b] - ay;
    const v1x = px[c] - ax;
    const v1y = py[c] - ay;
    const v2x = x - ax;
    const v2y = y - ay;
    const den = v0x * v1y - v1x * v0y;
    if (Math.abs(den) < 1e-12) {
      out[0] = 1;
      out[1] = 0;
      out[2] = 0;
      return false;
    }
    const l1 = (v2x * v1y - v1x * v2y) / den;
    const l2 = (v0x * v2y - v2x * v0y) / den;
    out[0] = 1 - l1 - l2;
    out[1] = l1;
    out[2] = l2;
    return true;
  }

  baseX(i) { return this.points[2 * i]; }
  baseY(i) { return this.points[2 * i + 1]; }

  // Finds the triangle containing (x, y) in geographic space by walking from the nearest point.
  locate(x, y, out) {
    const xs = this.xs || (this.xs = Float64Array.from({ length: this.n }, (_, i) => this.points[2 * i]));
    const ys = this.ys || (this.ys = Float64Array.from({ length: this.n }, (_, i) => this.points[2 * i + 1]));
    let t = this.pointTri[this.delaunay.find(x, y)];
    if (t < 0) t = 0;
    for (let iter = 0; iter < 200; iter++) {
      this.bary(t, x, y, xs, ys, out);
      let worst = 0;
      if (out[1] < out[worst]) worst = 1;
      if (out[2] < out[worst]) worst = 2;
      if (out[worst] >= -1e-9) return t;
      // Cross the edge opposite the most negative vertex.
      const edge = 3 * t + ((worst + 1) % 3);
      const opposite = this.half[edge];
      if (opposite < 0) return t; // hull reached: extrapolate from this triangle
      t = (opposite / 3) | 0;
    }
    return t;
  }

  // Binds interleaved vertex coordinates to the mesh: three control-point indices and weights each.
  bind(coords) {
    const V = coords.length / 2;
    const idx = new Int32Array(V * 3);
    const w = new Float32Array(V * 3);
    const b = [0, 0, 0];
    for (let v = 0; v < V; v++) {
      const t = this.locate(coords[2 * v], coords[2 * v + 1], b);
      idx[3 * v] = this.tri[3 * t];
      idx[3 * v + 1] = this.tri[3 * t + 1];
      idx[3 * v + 2] = this.tri[3 * t + 2];
      w[3 * v] = b[0];
      w[3 * v + 1] = b[1];
      w[3 * v + 2] = b[2];
    }
    return { idx, w, V };
  }

  // Writes warped interleaved coordinates for a binding given target control-point positions.
  apply(binding, tx, ty, out) {
    const { idx, w, V } = binding;
    for (let v = 0; v < V; v++) {
      const i0 = idx[3 * v];
      const i1 = idx[3 * v + 1];
      const i2 = idx[3 * v + 2];
      const w0 = w[3 * v];
      const w1 = w[3 * v + 1];
      const w2 = w[3 * v + 2];
      out[2 * v] = w0 * tx[i0] + w1 * tx[i1] + w2 * tx[i2];
      out[2 * v + 1] = w0 * ty[i0] + w1 * ty[i1] + w2 * ty[i2];
    }
  }

  // Inverse: given a point in warped space (control points at tx, ty), returns the geographic
  // base-space point, or null when it falls outside every warped triangle.
  invert(x, y, tx, ty) {
    const b = [0, 0, 0];
    let bestT = -1;
    let bestScore = -Infinity;
    for (let t = 0; t < this.triCount; t++) {
      if (!this.bary(t, x, y, tx, ty, b)) continue;
      const score = Math.min(b[0], b[1], b[2]);
      if (score > bestScore) {
        bestScore = score;
        bestT = t;
      }
      if (score >= 0) break;
    }
    if (bestT < 0 || bestScore < -0.05) return null;
    this.bary(bestT, x, y, tx, ty, b);
    const a = this.tri[3 * bestT];
    const c1 = this.tri[3 * bestT + 1];
    const c2 = this.tri[3 * bestT + 2];
    return [
      b[0] * this.baseX(a) + b[1] * this.baseX(c1) + b[2] * this.baseX(c2),
      b[0] * this.baseY(a) + b[1] * this.baseY(c1) + b[2] * this.baseY(c2),
    ];
  }
}
