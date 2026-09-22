// Canvas renderer.
//
// Almost all of what a frame costs is rasterisation, which the browser does after draw() returns
// (in Chrome, on the GPU process), so the renderer is built around rasterising as little as possible:
//   - A frame is only drawn when something it depends on has changed. Every input to the picture
//     (transform, data, toggles, hovered place, size) goes into one key; if the key matches the last
//     frame the layers already hold the right pixels and draw() returns without touching them.
//   - The map itself (land, colour bands, water, roads, the bus and rail networks) is rendered into
//     a padded canvas layer, with stations, places and labels cached in a second layer. Panning moves
//     both with CSS transforms: no full-window bitmap copies, marker redraws or label layout per
//     frame. A stable transparent canvas receives input and draws the changing route and hover ring.
//     Zooming scales both layers until the view settles and is rendered sharp. Everything above the
//     colour bands is also kept in an offscreen overlay, so new travel times repaint only the bands.
//   - Chrome rasterises a stroked path whose bounds span the screen far more slowly than the same
//     lines cut into pieces a hundred or so pixels across. So the bus network and the roads are drawn
//     in chunks sized to the zoom level, National Rail dashes are laid out here rather than by the
//     canvas (which dashes the whole of every line, off-screen parts included), and chunks out of view
//     are skipped.
//   - Geometry is held in base coordinates and drawn under the canvas transform. Chrome does the work
//     of a whole path for every draw, however little of it the clip lets through, so each part of the
//     layer draws only the rings and lines that reach into it, and re-uses a shape's whole Path2D when
//     all of them do.

import { GROUP_OF_MODE, RING_MINUTES, bandColour } from './model.js';

export const COLOURS = {
  bg: '#090c11',
  land: '#171e2a',
  landBorder: '#2a3446',
  park: '#182d23',
  water: '#122a45',
  waterEdge: '#214670',
  motorway: '#3a4864',
  trunk: '#2c3648',
  rail: '#7d8794',
  busNet: 'rgba(228, 87, 61, 0.22)',
  text: '#e8ecf1',
  muted: '#8a94a3',
  accent: '#ffd166',
  ring: 'rgba(255,255,255,0.22)',
  ringLabel: 'rgba(226,232,240,0.8)',
  bus: '#e4573d',
  walk: '#f1f5f9',
};

const BAND_OPACITY = 0.62; // how strongly the travel-time colour tints the land
const TAU = Math.PI * 2;

const MODE_ORDER = ['national-rail', 'tram', 'overground', 'elizabeth-line', 'dlr', 'tube'];
const MODE_WIDTH = { tube: 2.4, dlr: 2, 'elizabeth-line': 2.4, overground: 2, tram: 1.6, 'national-rail': 1.2 };

const CHUNK_PX = 128;           // target size of a chunk of lines, in device pixels
const NODE_CELL_PX = 128;       // station and place markers are batched per cell of this many pixels
const SETTLE_MS = 150;          // a scaled layer is rendered sharp once the zoom has been still this long
const VIEW_PAD = 32;            // CSS pixels of margin rendered with the window's part of a fresh layer
const SHAPE_PAD = 2;            // strokes reach this many base units plus as many CSS pixels past their geometry
const LAYER_WINDOWS = 2;        // the map layer (and its overlay) covers at most this many windows' worth of pixels...
const LAYER_MAX_PIXELS = 16e6;  // ...and never more than iOS Safari allows one canvas

// Label candidates only need to check nearby labels, rather than every label already placed.
export class LabelIndex {
  constructor(cellSize = 64) { this.cellSize = cellSize; this.cells = new Map(); }

  overlaps(box) {
    const [x0, y0, x1, y1] = box;
    const size = this.cellSize;
    for (let y = Math.floor(y0 / size); y <= Math.floor(y1 / size); y++) {
      for (let x = Math.floor(x0 / size); x <= Math.floor(x1 / size); x++) {
        const entries = this.cells.get(`${x},${y}`);
        if (entries?.some((q) => x0 < q[2] && x1 > q[0] && y0 < q[3] && y1 > q[1])) return true;
      }
    }
    return false;
  }

  insert(box) {
    const size = this.cellSize;
    for (let y = Math.floor(box[1] / size); y <= Math.floor(box[3] / size); y++) {
      for (let x = Math.floor(box[0] / size); x <= Math.floor(box[2] / size); x++) {
        const key = `${x},${y}`;
        let entries = this.cells.get(key);
        if (!entries) this.cells.set(key, (entries = []));
        entries.push(box);
      }
    }
  }
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Colour `top` laid over `bottom` with the given opacity, as an opaque CSS colour.
export function blend(top, bottom, opacity) {
  const a = hexToRgb(top);
  const b = hexToRgb(bottom);
  const mix = a.map((v, i) => Math.round(v * opacity + b[i] * (1 - opacity)));
  return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
}

// ---------------------------------------------------------------- chunks

const cellKey = (x, y, cell) => (Math.floor(x / cell) + 32768) * 65536 + (Math.floor(y / cell) + 32768);

// Chunk size in base units at a zoom level: the power of two nearest CHUNK_PX device pixels.
function chunkCell(k, dpr) {
  return Math.max(4, Math.min(512, 2 ** Math.round(Math.log2(CHUNK_PX / (k * dpr)))));
}

function chunkAt(chunks, key) {
  let chunk = chunks.get(key);
  if (!chunk) {
    chunk = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, path: new Path2D() };
    chunks.set(key, chunk);
  }
  return chunk;
}

function grow(chunk, x, y) {
  if (x < chunk.x0) chunk.x0 = x;
  if (x > chunk.x1) chunk.x1 = x;
  if (y < chunk.y0) chunk.y0 = y;
  if (y > chunk.y1) chunk.y1 = y;
}

// Segments given as x0, y0, x1, y1 quadruples, each added to the chunk holding its midpoint.
function segmentChunks(seg, cell) {
  const chunks = new Map();
  for (let i = 0; i < seg.length; i += 4) {
    const chunk = chunkAt(chunks, cellKey((seg[i] + seg[i + 2]) / 2, (seg[i + 1] + seg[i + 3]) / 2, cell));
    chunk.path.moveTo(seg[i], seg[i + 1]);
    chunk.path.lineTo(seg[i + 2], seg[i + 3]);
    grow(chunk, seg[i], seg[i + 1]);
    grow(chunk, seg[i + 2], seg[i + 3]);
  }
  return [...chunks.values()];
}

// Polylines ([start, count] runs of interleaved coordinates) cut into pieces no wider or taller than
// a cell, each added to the chunk where it starts. Neighbouring pieces share a vertex, so with round
// caps they join up exactly as the unbroken line would with round joins.
function polylineChunks(coords, runs, cell) {
  const chunks = new Map();
  const emit = (from, to) => {
    const chunk = chunkAt(chunks, cellKey(coords[2 * from], coords[2 * from + 1], cell));
    chunk.path.moveTo(coords[2 * from], coords[2 * from + 1]);
    grow(chunk, coords[2 * from], coords[2 * from + 1]);
    for (let i = from + 1; i <= to; i++) {
      chunk.path.lineTo(coords[2 * i], coords[2 * i + 1]);
      grow(chunk, coords[2 * i], coords[2 * i + 1]);
    }
  };
  for (const [start, count] of runs) {
    const end = start + count - 1;
    if (end <= start) continue;
    let from = start;
    let x0 = coords[2 * start];
    let y0 = coords[2 * start + 1];
    let x1 = x0;
    let y1 = y0;
    for (let i = start + 1; i <= end; i++) {
      const x = coords[2 * i];
      const y = coords[2 * i + 1];
      if (i - 1 > from && (Math.max(x1, x) - Math.min(x0, x) > cell || Math.max(y1, y) - Math.min(y0, y) > cell)) {
        emit(from, i - 1);
        from = i - 1;
        x0 = x1 = coords[2 * from];
        y0 = y1 = coords[2 * from + 1];
      }
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    emit(from, end);
  }
  return [...chunks.values()];
}

// The dashes a canvas draws along polylines with the pattern [on, off], which starts afresh at each
// run and carries on through its vertices. Only dashes on segments near the region are built, and
// each dash goes whole into the chunk where it starts.
function dashChunks(coords, runs, on, off, cell, region, pad) {
  const period = on + off;
  const rx0 = region.x0 - pad;
  const ry0 = region.y0 - pad;
  const rx1 = region.x1 + pad;
  const ry1 = region.y1 + pad;
  const paths = new Map();
  let path = null;
  for (const [start, count] of runs) {
    let d0 = 0;
    let open = false; // the previous segment ended part-way through a dash
    for (let i = start; i < start + count - 1; i++) {
      const ax = coords[2 * i];
      const ay = coords[2 * i + 1];
      const bx = coords[2 * i + 2];
      const by = coords[2 * i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len === 0) continue;
      const d1 = d0 + len;
      if (Math.max(ax, bx) < rx0 || Math.min(ax, bx) > rx1 || Math.max(ay, by) < ry0 || Math.min(ay, by) > ry1) {
        open = false;
        d0 = d1;
        continue;
      }
      const continuing = open;
      open = false;
      for (let n = Math.floor(d0 / period); n * period < d1; n++) {
        const a = n * period;
        const b = a + on;
        if (b <= d0) continue;
        if (a >= d0 || !continuing) {
          const t = (Math.max(a, d0) - d0) / len;
          const x = ax + (bx - ax) * t;
          const y = ay + (by - ay) * t;
          const key = cellKey(x, y, cell);
          path = paths.get(key);
          if (!path) paths.set(key, (path = new Path2D()));
          path.moveTo(x, y);
        }
        const t = (Math.min(b, d1) - d0) / len;
        path.lineTo(ax + (bx - ax) * t, ay + (by - ay) * t);
        open = b > d1;
      }
      d0 = d1;
    }
  }
  return [...paths.values()];
}

// Makes a layer canvas big enough for pw x ph pixels. It only grows, so that panning and zooming don't
// keep reallocating it (which also clears it), unless it would pass the pixel limit or has become
// far bigger than needed.
function fit(canvas, pw, ph) {
  if (pw <= canvas.width && ph <= canvas.height && 4 * pw * ph >= canvas.width * canvas.height) return;
  const width = Math.max(pw, canvas.width);
  const height = Math.max(ph, canvas.height);
  const exact = 4 * pw * ph < canvas.width * canvas.height || width * height > LAYER_MAX_PIXELS;
  canvas.width = exact ? pw : width;
  canvas.height = exact ? ph : height;
}

function strokeVisible(ctx, chunks, region, pad) {
  for (const c of chunks) {
    if (c.x1 >= region.x0 - pad && c.x0 <= region.x1 + pad && c.y1 >= region.y0 - pad && c.y0 <= region.y1 + pad) ctx.stroke(c.path);
  }
}

// A set of rings or lines ([start, count] pairs into interleaved coordinates) with the bounding box of
// each run, so that a path of just the runs reaching into part of the layer can be made without
// looking at their points. The path of the whole set is made the first time it is needed.
function shape(coords, runs, close) {
  const n = runs.length / 2;
  const boxes = new Float64Array(4 * n);
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (let r = 0; r < n; r++) {
    const start = runs[2 * r];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = start; i < start + runs[2 * r + 1]; i++) {
      const x = coords[2 * i];
      const y = coords[2 * i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    boxes[4 * r] = x0;
    boxes[4 * r + 1] = y0;
    boxes[4 * r + 2] = x1;
    boxes[4 * r + 3] = y1;
    if (x0 < bbox[0]) bbox[0] = x0;
    if (y0 < bbox[1]) bbox[1] = y0;
    if (x1 > bbox[2]) bbox[2] = x1;
    if (y1 > bbox[3]) bbox[3] = y1;
  }
  return { coords, runs, boxes, bbox, close, path: null };
}

// The path of a shape's runs that reach into a region grown by pad, or the whole path when they all
// do. Runs that stay outside can't change a pixel inside, whatever the fill rule.
function within(s, region, pad) {
  const { coords, runs, boxes, bbox, close } = s;
  const n = runs.length / 2;
  const x0 = region.x0 - pad;
  const y0 = region.y0 - pad;
  const x1 = region.x1 + pad;
  const y1 = region.y1 + pad;
  const reaches = (r) => boxes[4 * r + 2] >= x0 && boxes[4 * r] <= x1 && boxes[4 * r + 3] >= y0 && boxes[4 * r + 1] <= y1;
  let reached = 0;
  if (bbox[0] >= x0 && bbox[1] >= y0 && bbox[2] <= x1 && bbox[3] <= y1) reached = n;
  else while (reached < n && reaches(reached)) reached++;
  if (reached === n) {
    if (!s.path) {
      s.path = new Path2D();
      for (let r = 0; r < n; r++) Renderer.addRing(s.path, coords, runs[2 * r], runs[2 * r + 1], close);
    }
    return s.path;
  }
  const path = new Path2D();
  for (let r = 0; r < n; r++) {
    if (reaches(r)) Renderer.addRing(path, coords, runs[2 * r], runs[2 * r + 1], close);
  }
  return path;
}

function boundsOf(coords, bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }) {
  for (let i = 0; i < coords.length; i += 2) {
    const x = coords[i];
    const y = coords[i + 1];
    if (x < bounds.x0) bounds.x0 = x;
    if (x > bounds.x1) bounds.x1 = x;
    if (y < bounds.y0) bounds.y0 = y;
    if (y > bounds.y1) bounds.y1 = y;
  }
  return bounds;
}

// ---------------------------------------------------------------- renderer

export class Renderer {
  // onSettle is called when a frame should be drawn again although nothing in the scene changed: the
  // zoom has come to rest and the scaled map layer can now be rendered sharp, or part of the layer's
  // margin is still to render.
  constructor(canvas, { onSettle = () => {} } = {}) {
    this.canvas = canvas;
    // The stable input canvas holds only the changing route/hover overlay. The map and labels
    // move as compositor layers, so a pan does not copy millions of pixels through this canvas.
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.layer.width = 1;
    this.layer.height = 1;
    this.layerCtx = this.layer.getContext('2d', { alpha: false });
    this.layer.className = 'map-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    canvas.before(this.layer);
    this.features = document.createElement('canvas');
    this.features.width = this.features.height = 1;
    this.featuresCtx = this.features.getContext('2d');
    this.features.className = 'map-layer';
    this.features.setAttribute('aria-hidden', 'true');
    canvas.after(this.features);
    this.featureKey = null;
    this.overlayPainted = false;
    this.overlay = document.createElement('canvas');
    this.overlay.width = 1;
    this.overlay.height = 1;
    this.overlayCtx = this.overlay.getContext('2d');
    this.held = null; // what the layer holds, and for which transform
    this.onSettle = onSettle;
    this.settleTimer = 0;
    this.last = null;
    this.zoomedAt = -Infinity;
    this.movedAt = -Infinity;
    this.reshapedAt = -Infinity;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.shapes = null;
    this.pathKey = null;
    this.bandShapes = null;
    this.bandKey = null;
    this.bounds = null;
    this.ghost = null;
    this.chunks = new Map();
    this.frameKey = null;
    this.nodeScreen = null;
    this.nodeStyles = new Map();
    this.textWidths = new Map();
    this.tintCache = new Map();
    this.stats = { drawMs: 0, pathMs: 0, layerMs: 0, bandsMs: 0, scrollMs: 0, featureMs: 0, featureDraws: 0, draws: 0, layerDraws: 0, scrolls: 0, parts: 0, skipped: 0 };
  }

  // Setting a canvas's size clears it, even to the same size, so that only happens on a real change.
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const width = Math.max(1, Math.round(w * dpr));
    const height = Math.max(1, Math.round(h * dpr));
    if (dpr === this.dpr && w === this.w && h === this.h && width === this.canvas.width && height === this.canvas.height) return false;
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    this.canvas.width = width;
    this.canvas.height = height;
    this.frameKey = null;
    return true;
  }

  tint(colour) {
    let value = this.tintCache.get(colour);
    if (value === undefined) {
      value = blend(colour, COLOURS.land, BAND_OPACITY);
      this.tintCache.set(colour, value);
    }
    return value;
  }

  measure(ctx, text) {
    const key = `${ctx.font} ${text}`;
    let width = this.textWidths.get(key);
    if (width === undefined) {
      width = ctx.measureText(text).width;
      this.textWidths.set(key, width);
    }
    return width;
  }

  // Text widths depend on the font, so they are measured again once web fonts have loaded.
  fontsChanged() {
    this.textWidths.clear();
    this.featureKey = null;
    this.frameKey = null;
  }

  // ---------------------------------------------------------------- geometry paths

  // A ring is closed by returning to its first point rather than with closePath(), which in Chrome
  // costs time in proportion to the whole path so far: building every path of the map took 5 ms
  // with it and 2 ms without. Every stroke here has round caps and joins, so the outline is the same.
  static addRing(path, coords, start, count, close) {
    const x0 = coords[2 * start];
    const y0 = coords[2 * start + 1];
    path.moveTo(x0, y0);
    for (let i = start + 1; i < start + count; i++) path.lineTo(coords[2 * i], coords[2 * i + 1]);
    const last = start + count - 1;
    if (close && (coords[2 * last] !== x0 || coords[2 * last + 1] !== y0)) path.lineTo(x0, y0);
  }

  static polysPath(coords, polys) {
    const path = new Path2D();
    for (const poly of polys) for (const [s, c] of poly.rings) Renderer.addRing(path, coords, s, c, true);
    return path;
  }

  // Map geometry is rebuilt only when it moves (the time-stretch option), colour bands whenever they
  // are recalculated. The bus network, the ghost outline and line chunks never move, so they are built
  // once, the chunks lazily for each zoom level that needs them.
  ensurePaths(scene) {
    const t0 = performance.now();
    let built = false;
    if (scene.geomVersion !== this.pathKey || !this.shapes) {
      const W = scene.mesh.warped;
      const L = scene.layers;
      const rings = (polys) => Int32Array.from(polys.flatMap((poly) => poly.rings.flat()));
      const lines = (runs) => Int32Array.from(runs.flat());
      this.shapes = {
        boroughs: shape(W, rings(L.boroughs), true),
        parks: shape(W, rings(L.parks), true),
        thames: shape(W, rings(L.thames), true),
        water: shape(W, rings(L.water), true),
        thamesLine: shape(W, lines(L.thamesLine), false),
        rail: MODE_ORDER.filter((mode) => L.railByMode[mode])
          .map((mode) => [mode, L.railByMode[mode].map(([li, segs]) => [li, segs, shape(W, lines(segs), false)])]),
      };
      this.meshBounds = boundsOf(W, boundsOf(scene.busSegments));
      this.pathKey = scene.geomVersion;
      built = true;
    }
    const bandKey = `${scene.bandsVersion}|${scene.geomVersion}`;
    if (bandKey !== this.bandKey) {
      const bands = scene.bands;
      this.bandShapes = null;
      this.bounds = this.meshBounds;
      if (bands) {
        // Bands are only filled, which closes every ring implicitly.
        this.bandShapes = bands.list.map((band) => shape(bands.coords, band.rings, false));
        this.bounds = boundsOf(bands.coords, { ...this.meshBounds });
      }
      this.bandKey = bandKey;
      built = true;
    }
    if (built) this.stats.pathMs = performance.now() - t0;
  }

  chunked(name, cell, build) {
    const key = `${name}|${cell}`;
    let chunks = this.chunks.get(key);
    if (!chunks) {
      chunks = build();
      this.chunks.set(key, chunks);
    }
    return chunks;
  }

  // ---------------------------------------------------------------- frame

  // Returns true when the canvas was actually repainted.
  draw(scene) {
    const key = [
      scene.geomVersion, scene.bandsVersion, scene.dataVersion, scene.styleVersion,
      this.w, this.h, this.dpr,
      scene.transform.k, scene.transform.x, scene.transform.y,
      scene.hover, scene.origin.x, scene.origin.y, scene.origin.name,
    ].join('|');
    if (key === this.frameKey) {
      this.stats.skipped++;
      return false;
    }
    const t0 = performance.now();
    this.ensurePaths(scene);
    this.render(scene);
    this.frameKey = key;
    // Part of the map layer's margin is still to render: carry on next frame, or, while the map is
    // being stretched and each frame lays out a new layer anyway, once it stops.
    if (this.held && this.held.pending.length) {
      this.frameKey = null;
      if (performance.now() - this.reshapedAt < SETTLE_MS) this.settleSoon();
      else this.onSettle();
    }
    this.stats.drawMs = performance.now() - t0;
    this.stats.draws++;
    return true;
  }

  render(scene) {
    const { ctx, dpr } = this;
    const now = performance.now();
    const t = scene.transform;
    if (!this.last || this.last.k !== t.k) this.zoomedAt = now;
    if (!this.last || this.last.k !== t.k || this.last.x !== t.x || this.last.y !== t.y) this.movedAt = now;
    if (!this.last || this.last.geomVersion !== scene.geomVersion) this.reshapedAt = now;
    this.last = { k: t.k, x: t.x, y: t.y, geomVersion: scene.geomVersion };

    // Everything on top of the map layer uses the transform the layer was placed with, which can
    // differ from the frame's by under half a device pixel.
    const place = this.placeLayer(scene, now);
    const { k, x: tx, y: ty } = place;
    this.placeFeatures(scene, place);

    if (this.overlayPainted) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.overlayPainted = !!scene.route || scene.hover >= 0;

    if (scene.route) {
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      this.drawRoute(ctx, scene, (n) => n / k);
    }

    if (scene.hover >= 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(scene.nodeX[scene.hover] * k + tx, scene.nodeY[scene.hover] * k + ty, 7, 0, TAU);
      ctx.strokeStyle = COLOURS.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // Cache all the stationary detail over the same padded extent as the map. In particular, label
  // collision detection and text rasterisation must not run for each pointer movement.
  placeFeatures(scene, place) {
    const held = this.held;
    const key = [scene.geomVersion, scene.dataVersion, scene.showStations, scene.origin.x,
      scene.origin.y, scene.origin.name, scene.origin.node, scene.ringScale, scene.morph,
      held.k, held.x - held.left, held.y - held.top, held.pw, held.ph, this.dpr].join('|');
    if (key !== this.featureKey) {
      this.renderFeatures(scene);
      this.featureKey = key;
    }
    this.positionLayer(this.features, held, place);
  }

  renderFeatures(scene) {
    const start = performance.now();
    const { held, dpr, featuresCtx: ctx } = this;
    const { k } = held;
    const tx = held.x - held.left;
    const ty = held.y - held.top;
    fit(this.features, held.pw, held.ph);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.features.width, this.features.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const N = scene.nodes.length;
    if (!this.nodeScreen || this.nodeScreen.length !== 2 * N) this.nodeScreen = new Float32Array(2 * N);
    const S = this.nodeScreen;
    for (let i = 0; i < N; i++) {
      S[2 * i] = scene.nodeX[i] * k + tx;
      S[2 * i + 1] = scene.nodeY[i] * k + ty;
    }
    const ox = scene.origin.x * k + tx;
    const oy = scene.origin.y * k + ty;

    const cached = { ...scene, hover: -1 };
    this.drawRings(ctx, cached, ox, oy, k, held.width, held.height);
    this.drawNodes(ctx, cached, S, k, held.width, held.height);
    this.drawOriginDot(ctx, ox, oy);
    this.drawLabels(ctx, cached, S, k, ox, oy, held.width, held.height);
    this.stats.featureMs = performance.now() - start;
    this.stats.featureDraws++;
  }

  positionLayer(canvas, held, place) {
    const { dpr } = this;
    // Allocations may be larger than the current extent; clip off their unused pixels.
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
    canvas.style.clipPath = `inset(0 ${(canvas.width - held.pw) / dpr}px ${(canvas.height - held.ph) / dpr}px 0)`;
    canvas.style.transform = `translate3d(${place.left}px, ${place.top}px, 0) scale(${place.scale})`;
  }

  // ---------------------------------------------------------------- map layer

  // What the two parts of the map layer depend on, apart from the transform. The land and the colour
  // bands change whenever the times do. The rest of the map, drawn over them, changes only with the
  // geometry, the options that style it and the rail modes that dim lines, so it is kept in a
  // transparent overlay of its own and new times repaint just the bands beneath it: in software
  // rendering that is a fifth of the work of the whole layer. Stations and places are drawn on top
  // of the layer, so showing or hiding them leaves it alone.
  bandsKey(scene) {
    return [scene.geomVersion, scene.bandsVersion, scene.warped, this.dpr].join('|');
  }

  overlayKey(scene) {
    return [
      scene.geomVersion, scene.warped, scene.showBus, scene.ghost, !!scene.bands,
      !!scene.enabled.underground, !!scene.enabled.trains, this.dpr,
    ].join('|');
  }

  // Positions the map's compositor layer, rendering it first if the held pixels cannot cover the
  // view, and returns the transform shared by the labels and interaction overlay.
  placeLayer(scene, now) {
    const { k, x, y } = scene.transform;
    const bandsKey = this.bandsKey(scene);
    const overlayKey = this.overlayKey(scene);
    let held = this.held && this.held.overlayKey === overlayKey ? this.held : null;
    let place = held && this.reuse(held, scene, now);
    // Panned past the layer, or resting near its edge: keep what is there and render only the rest.
    if (!place && held && held.k === k && held.bandsKey === bandsKey && this.scroll(scene)) {
      held = this.held;
      place = this.reuse(held, scene, now);
    }
    if (!place) {
      this.renderLayer(scene, bandsKey, overlayKey);
      held = this.held;
      place = { scale: 1, left: held.left, top: held.top, k, x, y };
    } else if (held.bandsKey !== bandsKey) {
      this.paintBands(scene, bandsKey);
    } else if (held.pending.length && now - this.reshapedAt >= SETTLE_MS) {
      this.renderPending(scene);
    }

    this.positionLayer(this.layer, held, place);
    return place;
  }

  // Where to put the layer held for this frame, or null if it has to be rendered again.
  reuse(held, scene, now) {
    const { dpr } = this;
    const { k, x, y } = scene.transform;
    if (held.k === k) {
      // Same scale: move the layer, by whole device pixels.
      const left = Math.round((held.left + x - held.x) * dpr) / dpr;
      const top = Math.round((held.top + y - held.y) * dpr) / dpr;
      const place = { scale: 1, left, top, k, x: left - held.left + held.x, y: top - held.top + held.y };
      if (!this.showable(held, place, scene)) return null;
      // A view that has drifted near the layer's edge gets a fresh layer once it is still.
      if (!this.covers(held, place, held.margin / 2, true)) {
        if (now - this.movedAt >= SETTLE_MS) return null;
        this.settleSoon();
      }
      return place;
    }
    if (now - this.zoomedAt >= SETTLE_MS) return null;
    // Zooming: scale the layer for now, and render it sharp once the zoom rests.
    const scale = k / held.k;
    const place = { scale, left: (held.left - held.x) * scale + x, top: (held.top - held.y) * scale + y, k, x, y };
    if (scale < 0.5 || scale > 2 || !this.showable(held, place, scene)) return null;
    this.settleSoon();
    return place;
  }

  // Whether the layer, placed as given, can be shown: when the view reaches into margin not rendered
  // yet, as much of it is rendered as the view needs.
  showable(held, place, scene) {
    if (this.covers(held, place, 0, false)) return true;
    if (!this.covers(held, place, 0, true)) return false;
    while (held.pending.length && !this.covers(held, place, 0, false)) this.renderPending(scene);
    return this.covers(held, place, 0, false);
  }

  // Whether the layer, placed as given, covers every part of the window (grown by `extra` pixels on
  // each side) where the map has anything to show: with its rendered part, or with all of it.
  covers(held, place, extra, whole) {
    const { k, x, y, scale } = place;
    const { dpr } = this;
    const b = this.bounds;
    const pad = held.pad * scale;
    const x0 = Math.max(-extra, b.x0 * k + x - pad);
    const y0 = Math.max(-extra, b.y0 * k + y - pad);
    const x1 = Math.min(this.w + extra, b.x1 * k + x + pad);
    const y1 = Math.min(this.h + extra, b.y1 * k + y + pad);
    if (x1 <= x0 || y1 <= y0) return true;
    const [vx0, vy0, vx1, vy1] = whole ? [0, 0, held.pw, held.ph] : held.valid;
    const eps = 1e-6;
    return x0 >= place.left + (vx0 / dpr) * scale - eps && y0 >= place.top + (vy0 / dpr) * scale - eps
      && x1 <= place.left + (vx1 / dpr) * scale + eps && y1 <= place.top + (vy1 / dpr) * scale + eps;
  }

  settleSoon() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = 0;
      this.frameKey = null;
      this.onSettle();
    }, SETTLE_MS + 30);
  }

  // The layer's extent for a transform: the window plus a margin that keeps it within its pixel
  // budget, cut down to the map, and starting on whole device pixels.
  layout(k, x, y) {
    const { dpr, w, h } = this;
    const area = Math.min(LAYER_WINDOWS * w * h, LAYER_MAX_PIXELS / (dpr * dpr));
    const margin = Math.max(0, (Math.sqrt((w + h) ** 2 + 4 * (area - w * h)) - (w + h)) / 4);
    const pad = 4 + 1.7 * k; // how far strokes can reach past the geometry, in CSS pixels
    const b = this.bounds;
    const left = Math.floor(Math.max(-margin, b.x0 * k + x - pad) * dpr) / dpr;
    const top = Math.floor(Math.max(-margin, b.y0 * k + y - pad) * dpr) / dpr;
    const pw = Math.max(1, Math.ceil((Math.min(w + margin, b.x1 * k + x + pad) - left) * dpr));
    const ph = Math.max(1, Math.ceil((Math.min(h + margin, b.y1 * k + y + pad) - top) * dpr));
    return { k, x, y, left, top, width: pw / dpr, height: ph / dpr, pw, ph, pad, margin };
  }

  // Renders the map for the current transform over the window plus a margin, cut down to the map.
  // Only the part in the window is rendered straight away; the margin around it follows a strip a
  // frame, so zooming in or out doesn't pay for the margin in the frame it lands.
  renderLayer(scene, bandsKey, overlayKey) {
    const t0 = performance.now();
    const { dpr } = this;
    const { k, x, y } = scene.transform;
    const held = (this.held = { ...this.layout(k, x, y), bandsKey, overlayKey });
    fit(this.layer, held.pw, held.ph);
    fit(this.overlay, held.pw, held.ph);
    for (const [ctx, opaque] of [[this.layerCtx, true], [this.overlayCtx, false]]) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = COLOURS.bg;
      if (opaque) ctx.fillRect(0, 0, held.pw, held.ph);
      else ctx.clearRect(0, 0, held.pw, held.ph);
    }
    const pad = VIEW_PAD * dpr;
    let x0 = Math.max(0, Math.floor(-held.left * dpr - pad));
    let y0 = Math.max(0, Math.floor(-held.top * dpr - pad));
    let x1 = Math.min(held.pw, Math.ceil((this.w - held.left) * dpr + pad));
    let y1 = Math.min(held.ph, Math.ceil((this.h - held.top) * dpr + pad));
    if (x1 <= x0 || y1 <= y0) [x0, y0, x1, y1] = [0, 0, held.pw, held.ph];
    this.startParts(held, x0, y0, x1, y1);
    this.renderPart(scene, x0, y0, x1, y1);
    this.stats.layerMs = performance.now() - t0;
    this.stats.layerDraws++;
  }

  // Records that a rectangle of the layer is rendered (or about to be), and queues the four strips
  // around it. Left and right come before top and bottom, so what is rendered stays a rectangle.
  startParts(held, x0, y0, x1, y1) {
    held.valid = [x0, y0, x1, y1];
    held.pending = [[0, y0, x0, y1], [x1, y0, held.pw, y1], [0, 0, held.pw, y0], [0, y1, held.pw, held.ph]]
      .filter(([a, b, c, d]) => c > a && d > b);
  }

  // Renders the next strip of the layer's margin.
  renderPending(scene) {
    const held = this.held;
    const [x0, y0, x1, y1] = held.pending.shift();
    this.renderPart(scene, x0, y0, x1, y1);
    const v = held.valid;
    held.valid = [Math.min(v[0], x0), Math.min(v[1], y0), Math.max(v[2], x1), Math.max(v[3], y1)];
    this.stats.parts++;
  }

  // Lays the layer out afresh for the current view at the same scale, moving the pixels it already
  // has so that they stay put on screen, and renders only the strips around them. A pan past the
  // margin then costs a strip the width of the overshoot rather than the whole layer. Returns false
  // if nothing can be kept, or the layer would pass its pixel limit.
  scroll(scene) {
    const t0 = performance.now();
    const { dpr } = this;
    const old = this.held;
    const { k, x, y } = scene.transform;
    // Where the old layer is placed on screen, in whole device pixels, and the transform that puts it there.
    const dx = Math.round((old.left + x - old.x) * dpr);
    const dy = Math.round((old.top + y - old.y) * dpr);
    const held = { ...this.layout(k, dx / dpr - old.left + old.x, dy / dpr - old.top + old.y), bandsKey: old.bandsKey, overlayKey: old.overlayKey };
    // Pixel (i, j) of the old layer becomes pixel (i + sx, j + sy) of the new one. Only the part it
    // has rendered is worth keeping.
    const sx = dx - Math.round(held.left * dpr);
    const sy = dy - Math.round(held.top * dpr);
    const x0 = Math.max(0, old.valid[0] + sx);
    const y0 = Math.max(0, old.valid[1] + sy);
    const x1 = Math.min(held.pw, old.valid[2] + sx);
    const y1 = Math.min(held.ph, old.valid[3] + sy);
    if (x1 <= x0 || y1 <= y0) return false;
    // Moving within the canvases copies each onto itself. Resizing a canvas clears it, so when the new
    // layout needs more room the pixels are copied into larger canvases instead. The copy replaces the
    // pixels it lands on rather than being drawn over them: over them, the transparent overlay would
    // keep a ghost of the water, parks and lines it held before, to show once new bands go beneath.
    const larger = held.pw > this.layer.width || held.ph > this.layer.height;
    const width = Math.max(held.pw, this.layer.width);
    const height = Math.max(held.ph, this.layer.height);
    if (larger && width * height > LAYER_MAX_PIXELS) return false;
    for (const [name, options] of [['layer', { alpha: false }], ['overlay', {}]]) {
      const from = this[name];
      if (larger) {
        this[name] = document.createElement('canvas');
        this[name].width = width;
        this[name].height = height;
        this[`${name}Ctx`] = this[name].getContext('2d', options);
        if (name === 'layer') {
          this[name].className = 'map-layer';
          this[name].setAttribute('aria-hidden', 'true');
          from.replaceWith(this[name]);
        }
      }
      const ctx = this[`${name}Ctx`];
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.save();
      // Copying clears whatever it doesn't draw on, so it is clipped to where the pixels go.
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(from, x0 - sx, y0 - sy, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
    }
    this.held = held;
    // The strips around what was kept are rendered as the view needs them, and the rest a frame at a
    // time. Until then they hold only the background.
    this.startParts(held, x0, y0, x1, y1);
    for (const [a, b, c, d] of held.pending) {
      this.layerCtx.fillStyle = COLOURS.bg;
      this.layerCtx.fillRect(a, b, c - a, d - b);
      this.overlayCtx.clearRect(a, b, c - a, d - b);
    }
    this.stats.scrollMs = performance.now() - t0;
    this.stats.scrolls++;
    return true;
  }

  // Renders a rectangle of the layer, given in its canvas pixels: the overlay, then the land and bands
  // with the overlay laid over them.
  renderPart(scene, x0, y0, x1, y1) {
    const o = this.overlayCtx;
    this.clipTo(o, x0, y0, x1, y1, false);
    this.drawOverlay(o, scene, this.held.k, this.regionOf(x0, y0, x1, y1));
    o.restore();
    this.paintPart(scene, x0, y0, x1, y1);
  }

  // A rectangle of the layer, in its canvas pixels, as a region of the map in base coordinates.
  regionOf(x0, y0, x1, y1) {
    const { dpr, held } = this;
    return {
      x0: (held.left + x0 / dpr - held.x) / held.k,
      y0: (held.top + y0 / dpr - held.y) / held.k,
      x1: (held.left + x1 / dpr - held.x) / held.k,
      y1: (held.top + y1 / dpr - held.y) / held.k,
    };
  }

  // Paints the land and colour bands into the rendered part of the layer, at the transform it holds.
  // Strips still to come are rendered with the new bands anyway.
  paintBands(scene, bandsKey) {
    const t0 = performance.now();
    const [x0, y0, x1, y1] = this.held.valid;
    this.paintPart(scene, x0, y0, x1, y1);
    this.held.bandsKey = bandsKey;
    this.stats.bandsMs = performance.now() - t0;
  }

  // Paints the land and colour bands into a rectangle of the layer, then lays the overlay over them.
  paintPart(scene, x0, y0, x1, y1) {
    const c = this.layerCtx;
    const region = this.regionOf(x0, y0, x1, y1);
    const pad = SHAPE_PAD + SHAPE_PAD / this.held.k;
    this.clipTo(c, x0, y0, x1, y1, true);
    const london = within(this.shapes.boroughs, region, pad);
    c.fillStyle = COLOURS.land;
    c.fill(london, 'evenodd');
    // Travel-time bands, clipped to Greater London and painted lowest band first.
    if (this.bandShapes) {
      c.clip(london, 'evenodd');
      scene.bands.list.forEach((band, i) => {
        c.fillStyle = this.tint(band.colour);
        c.fill(within(this.bandShapes[i], region, pad), 'evenodd');
      });
    }
    c.restore();
    c.drawImage(this.overlay, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  }

  // Readies a layer context to draw into a rectangle of its canvas: clears it (or fills it with the
  // background), clips to it and sets the transform the layer is rendered with. Balance with restore().
  clipTo(ctx, x0, y0, x1, y1, opaque) {
    const { dpr } = this;
    const { k, x, y, left, top } = this.held;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (opaque) {
      ctx.fillStyle = COLOURS.bg;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    } else ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (x - left), dpr * (y - top));
  }

  // Everything of the map drawn over the colour bands.
  drawOverlay(ctx, scene, k, region) {
    const { shapes, dpr } = this;
    const px = (n) => n / k;
    const cell = chunkCell(k, dpr);
    const base = scene.mesh.base;
    const coords = scene.mesh.warped; // the same as base unless the map is stretched
    const part = (s) => within(s, region, SHAPE_PAD + SHAPE_PAD / k);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.strokeStyle = COLOURS.landBorder;
    ctx.lineWidth = px(1);
    ctx.stroke(part(shapes.boroughs));

    ctx.globalAlpha = this.bandShapes ? 0.55 : 1;
    ctx.fillStyle = COLOURS.park;
    ctx.fill(part(shapes.parks), 'evenodd');
    ctx.globalAlpha = 1;

    ctx.strokeStyle = COLOURS.water;
    ctx.lineWidth = 3.2;
    ctx.stroke(part(shapes.thamesLine));
    for (const water of [part(shapes.thames), part(shapes.water)]) {
      ctx.fillStyle = COLOURS.water;
      ctx.fill(water, 'evenodd');
      ctx.strokeStyle = COLOURS.waterEdge;
      ctx.lineWidth = px(0.8);
      ctx.stroke(water);
    }

    // Road chunks of the unstretched map are kept for each zoom level; stretched roads move with
    // every change, so their chunks are cut afresh.
    for (const [road, colour, width] of [['trunk', COLOURS.trunk, px(1.1) + 0.15], ['motorway', COLOURS.motorway, px(1.6) + 0.25]]) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      const runs = scene.layers.roads[road];
      const chunks = scene.warped ? polylineChunks(coords, runs, cell) : this.chunked(road, cell, () => polylineChunks(base, runs, cell));
      strokeVisible(ctx, chunks, region, width);
    }

    if (scene.showBus && scene.busSegments.length) {
      ctx.strokeStyle = COLOURS.busNet;
      ctx.lineWidth = px(1) + 0.08;
      strokeVisible(ctx, this.chunked('bus', cell, () => segmentChunks(scene.busSegments, cell)), region, ctx.lineWidth);
    }

    if (scene.ghost) {
      if (!this.ghost) this.ghost = Renderer.polysPath(base, scene.layers.boroughs);
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = 'rgba(255,209,102,0.35)';
      ctx.lineWidth = px(1);
      ctx.stroke(this.ghost);
      ctx.globalAlpha = 1;
    }

    // Rail lines, dimmed when their tick box is off. National Rail is dashed.
    for (const [mode, group] of shapes.rail) {
      const on = !!scene.enabled[GROUP_OF_MODE[mode]];
      const dashed = mode === 'national-rail';
      ctx.globalAlpha = on ? (dashed ? 0.75 : 0.95) : 0.18;
      ctx.lineWidth = px(MODE_WIDTH[mode]) + (on ? 0.12 : 0.05);
      for (const [lineIdx, segs, line] of group) {
        ctx.strokeStyle = scene.lines[lineIdx].colour;
        if (!dashed) ctx.stroke(part(line));
        else for (const dashes of dashChunks(coords, segs, px(6), px(4), cell, region, ctx.lineWidth)) ctx.stroke(dashes);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- on top of the map

  drawRoute(ctx, scene, px) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const halo of [true, false]) {
      for (const seg of scene.route.segments) {
        const c = seg.coords;
        if (c.length < 4) continue;
        ctx.beginPath();
        ctx.moveTo(c[0], c[1]);
        for (let i = 2; i < c.length; i += 2) ctx.lineTo(c[i], c[i + 1]);
        if (halo) {
          ctx.strokeStyle = 'rgba(9,12,17,0.85)';
          ctx.lineWidth = px(7);
          ctx.setLineDash([]);
        } else if (seg.kind === 'walk') {
          ctx.strokeStyle = COLOURS.walk;
          ctx.lineWidth = px(2.2);
          ctx.setLineDash([px(2), px(5)]);
        } else if (seg.kind === 'car') {
          ctx.strokeStyle = COLOURS.accent;
          ctx.lineWidth = px(3);
          ctx.setLineDash([px(10), px(6)]);
        } else {
          ctx.strokeStyle = scene.lines[seg.line].colour;
          ctx.lineWidth = px(4);
          ctx.setLineDash([]);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawRings(ctx, scene, ox, oy, k, w = this.w, h = this.h) {
    const scale = scene.ringScale * k;
    if (!(scale > 0)) return;
    const alpha = Math.max(0, Math.min(1, scene.morph)) ** 2;
    if (alpha <= 0.02) return;
    const maxR = Math.hypot(w, h);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '500 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const t of RING_MINUTES) {
      const r = scale * t;
      if (r < 24 || r > maxR * 1.2) continue;
      ctx.beginPath();
      ctx.arc(ox, oy, r, 0, TAU);
      ctx.strokeStyle = COLOURS.ring;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      const ly = oy - r - 3;
      if (ly > 8 && ly < h && ox > 0 && ox < w) {
        const label = `${t} min`;
        const tw = this.measure(ctx, label);
        ctx.fillStyle = COLOURS.bg;
        ctx.globalAlpha = alpha * 0.85;
        ctx.fillRect(ox - tw / 2 - 4, ly - 13, tw + 8, 14);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = COLOURS.ringLabel;
        ctx.fillText(label, ox, ly);
      }
    }
    ctx.restore();
  }

  // Stations and places: one path per fill/stroke combination and screen cell, so that each path
  // stays small enough to rasterise quickly. Styles are painted in the order they first appear.
  drawNodes(ctx, scene, S, k, w = this.w, h = this.h) {
    const { nodes, times } = scene;
    const margin = 10;
    const styles = this.nodeStyles;
    styles.clear();
    const add = (fill, stroke, r, x, y) => {
      const key = `${fill}|${stroke}|${r}`;
      let style = styles.get(key);
      if (!style) {
        style = { fill, stroke, cells: new Map() };
        styles.set(key, style);
      }
      const cell = cellKey(x, y, NODE_CELL_PX);
      let path = style.cells.get(cell);
      if (!path) style.cells.set(cell, (path = new Path2D()));
      path.moveTo(x + r, y);
      path.arc(x, y, r, 0, TAU);
    };
    // At a city-wide phone view, full-sized stops obscure the colour bands underneath.
    const densityScale = Math.max(0.6, Math.min(1, k / 0.8));
    const stationR = (k < 1.5 ? 1.7 : 2.2) * densityScale;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const x = S[2 * i];
      const y = S[2 * i + 1];
      if (x < -margin || y < -margin || x > w + margin || y > h + margin) continue;
      const unreachable = times ? !Number.isFinite(times[i]) : false;
      const colour = times ? bandColour(times[i]) : null;
      if (n.kind === 'station') {
        if (!scene.showStations) continue;
        if (n.lineIds.size >= 2) {
          add(unreachable ? 'rgba(20,26,36,0.9)' : colour || COLOURS.bg,
            unreachable ? 'rgba(200,208,220,0.35)' : 'rgba(232,236,241,0.9)', stationR + 1.2 * densityScale, x, y);
        } else {
          add(unreachable ? 'rgba(160,170,185,0.3)' : colour || 'rgba(190,200,215,0.85)', null, stationR, x, y);
        }
      } else {
        const r = (n.tier === 1 ? 3.8 : n.tier === 2 ? 3.2 : 2.6) * densityScale;
        add(unreachable ? 'rgba(255,255,255,0.25)' : colour || '#ffffff',
          unreachable ? 'rgba(255,255,255,0.4)' : '#ffffff', r, x, y);
      }
    }
    for (const style of styles.values()) {
      ctx.fillStyle = style.fill;
      for (const path of style.cells.values()) ctx.fill(path);
      if (style.stroke) {
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = 1.2;
        for (const path of style.cells.values()) ctx.stroke(path);
      }
    }
    if (scene.hover >= 0) {
      ctx.beginPath();
      ctx.arc(S[2 * scene.hover], S[2 * scene.hover + 1], 7, 0, TAU);
      ctx.strokeStyle = COLOURS.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  drawOriginDot(ctx, ox, oy) {
    for (const [r, style] of [[13, 'rgba(255,209,102,0.22)'], [9, 'rgba(255,209,102,0.45)']]) {
      ctx.beginPath();
      ctx.arc(ox, oy, r, 0, TAU);
      ctx.strokeStyle = style;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(ox, oy, 5.5, 0, TAU);
    ctx.fillStyle = COLOURS.accent;
    ctx.fill();
    ctx.strokeStyle = COLOURS.bg;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  drawLabels(ctx, scene, S, k, ox, oy, w = this.w, h = this.h) {
    const { nodes, times } = scene;
    const candidates = [];
    candidates.push({ x: ox, y: oy, text: scene.origin.name, priority: -1, size: 13, weight: 700, colour: COLOURS.accent, offset: 9 });
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const x = S[2 * i];
      const y = S[2 * i + 1];
      if (x < -40 || y < -20 || x > w + 40 || y > h + 20) continue;
      if (i === scene.origin.node) continue; // the origin already carries its own label
      if (n.kind === 'place') {
        const priority = n.tier + (k < 1.2 && n.tier === 3 ? 10 : 0);
        candidates.push({ x, y, text: n.name, priority, size: n.tier === 1 ? 12.5 : 11.5, weight: n.tier === 1 ? 600 : 500, colour: COLOURS.text, offset: 6, index: i });
      } else if (scene.showStations) {
        const interchange = n.lineIds.size >= 2;
        if (k >= 4.5 || (k >= 2.2 && interchange)) {
          candidates.push({ x, y, text: n.name, priority: interchange ? 5 : 6, size: 10.5, weight: 500, colour: COLOURS.muted, offset: 5, index: i });
        }
      }
    }
    if (scene.hover >= 0 && !candidates.some((c) => c.index === scene.hover)) {
      const n = nodes[scene.hover];
      candidates.push({ x: S[2 * scene.hover], y: S[2 * scene.hover + 1], text: n.name, priority: -0.5, size: 12, weight: 600, colour: COLOURS.text, offset: 8, index: scene.hover });
    }
    candidates.sort((a, b) => a.priority - b.priority);

    const placed = new LabelIndex();
    const labelGap = k < 0.6 ? 5 : 2;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const c of candidates) {
      ctx.font = `${c.weight} ${c.size}px Inter, system-ui, sans-serif`;
      const tw = this.measure(ctx, c.text);
      const th = c.size + 2;
      const o = c.offset;
      const options = [
        { x: c.x + o, y: c.y, align: 'left' },
        { x: c.x - o, y: c.y, align: 'right' },
        { x: c.x, y: c.y - o - th / 2, align: 'center' },
        { x: c.x, y: c.y + o + th / 2, align: 'center' },
      ];
      for (const opt of options) {
        const x0 = opt.align === 'left' ? opt.x : opt.align === 'right' ? opt.x - tw : opt.x - tw / 2;
        const bx0 = x0 - labelGap;
        const bx1 = x0 + tw + labelGap;
        const by0 = opt.y - th / 2 - labelGap / 2;
        const by1 = opt.y + th / 2 + labelGap / 2;
        if (bx0 < 2 || by0 < 2 || bx1 > w - 2 || by1 > h - 2) continue;
        const box = [bx0, by0, bx1, by1];
        if (placed.overlaps(box)) continue;
        placed.insert(box);
        ctx.textAlign = opt.align;
        const dim = c.index !== undefined && times && !Number.isFinite(times[c.index]);
        ctx.globalAlpha = dim ? 0.45 : 1;
        ctx.strokeStyle = 'rgba(9,12,17,0.9)';
        ctx.lineWidth = 3.5;
        ctx.strokeText(c.text, opt.x, opt.y);
        ctx.fillStyle = c.colour;
        ctx.fillText(c.text, opt.x, opt.y);
        ctx.globalAlpha = 1;
        break;
      }
    }
  }
}
