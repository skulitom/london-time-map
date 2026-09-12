// Canvas renderer.
//
// Two things keep interaction cheap:
//   - A frame is only drawn when something it depends on has changed. Every input to the picture
//     (transform, data, toggles, hovered place, size) goes into one key; if the key matches the last
//     frame the canvas already holds the right pixels and draw() returns without touching it. So an
//     idle map costs nothing at all.
//   - Geometry is held as Path2D objects in base coordinates and re-used under the canvas transform,
//     rebuilt only when the geometry itself moves. Panning and zooming never rebuild a path, which
//     is what used to dominate each frame.

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

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.paths = null;
    this.pathKey = null;
    this.frameKey = null;
    this.nodeScreen = null;
    this.nodeBuckets = new Map();
    this.textWidths = new Map();
    this.tintCache = new Map();
    this.stats = { drawMs: 0, pathMs: 0, draws: 0, skipped: 0 };
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.round(this.w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.h * this.dpr));
    this.frameKey = null;
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

  // ---------------------------------------------------------------- geometry paths

  static addRing(path, coords, start, count, close) {
    path.moveTo(coords[2 * start], coords[2 * start + 1]);
    for (let i = start + 1; i < start + count; i++) path.lineTo(coords[2 * i], coords[2 * i + 1]);
    if (close) path.closePath();
  }

  static polysPath(coords, polys) {
    const path = new Path2D();
    for (const poly of polys) for (const [s, c] of poly.rings) Renderer.addRing(path, coords, s, c, true);
    return path;
  }

  static segsPath(coords, segs) {
    const path = new Path2D();
    for (const [s, c] of segs) Renderer.addRing(path, coords, s, c, false);
    return path;
  }

  ensurePaths(scene) {
    const key = `${scene.geomVersion}|${scene.bandsVersion}`;
    if (key === this.pathKey && this.paths) return;
    const t0 = performance.now();
    const W = scene.mesh.warped;
    const L = scene.layers;
    const paths = {
      boroughs: Renderer.polysPath(W, L.boroughs),
      ghost: Renderer.polysPath(scene.mesh.base, L.boroughs),
      parks: Renderer.polysPath(W, L.parks),
      thames: Renderer.polysPath(W, L.thames),
      water: Renderer.polysPath(W, L.water),
      thamesLine: Renderer.segsPath(W, L.thamesLine),
      trunk: Renderer.segsPath(W, L.roads.trunk),
      motorway: Renderer.segsPath(W, L.roads.motorway),
      rail: [],
      bus: null,
      bands: null,
    };
    for (const mode of MODE_ORDER) {
      const group = L.railByMode[mode];
      if (!group) continue;
      paths.rail.push([mode, group.map(([li, segs]) => [li, Renderer.segsPath(W, segs)])]);
    }
    const seg = scene.busSegments;
    if (seg && seg.length) {
      const path = new Path2D();
      for (let i = 0; i < seg.length; i += 4) {
        path.moveTo(seg[i], seg[i + 1]);
        path.lineTo(seg[i + 2], seg[i + 3]);
      }
      paths.bus = path;
    }
    if (scene.bands) {
      const coords = scene.bands.coords;
      paths.bands = scene.bands.list.map((band) => {
        const path = new Path2D();
        for (const polygon of band.polygons) for (const [s, c] of polygon) Renderer.addRing(path, coords, s, c, true);
        return path;
      });
    }
    this.paths = paths;
    this.pathKey = key;
    this.stats.pathMs = performance.now() - t0;
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
    this.stats.drawMs = performance.now() - t0;
    this.stats.draws++;
    return true;
  }

  render(scene) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const { transform: { x: tx, y: ty, k }, lines } = scene;
    const paths = this.paths;
    const px = (n) => n / k;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLOURS.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.fillStyle = COLOURS.land;
    ctx.fill(paths.boroughs, 'evenodd');

    // Travel-time bands, clipped to Greater London and painted lowest band first.
    if (paths.bands) {
      ctx.save();
      ctx.clip(paths.boroughs, 'evenodd');
      scene.bands.list.forEach((band, i) => {
        ctx.fillStyle = this.tint(band.colour);
        ctx.fill(paths.bands[i], 'evenodd');
      });
      ctx.restore();
    }

    ctx.strokeStyle = COLOURS.landBorder;
    ctx.lineWidth = px(1);
    ctx.stroke(paths.boroughs);

    ctx.globalAlpha = paths.bands ? 0.55 : 1;
    ctx.fillStyle = COLOURS.park;
    ctx.fill(paths.parks, 'evenodd');
    ctx.globalAlpha = 1;

    ctx.strokeStyle = COLOURS.water;
    ctx.lineWidth = 3.2;
    ctx.stroke(paths.thamesLine);
    for (const water of [paths.thames, paths.water]) {
      ctx.fillStyle = COLOURS.water;
      ctx.fill(water, 'evenodd');
      ctx.strokeStyle = COLOURS.waterEdge;
      ctx.lineWidth = px(0.8);
      ctx.stroke(water);
    }

    ctx.strokeStyle = COLOURS.trunk;
    ctx.lineWidth = px(1.1) + 0.15;
    ctx.stroke(paths.trunk);
    ctx.strokeStyle = COLOURS.motorway;
    ctx.lineWidth = px(1.6) + 0.25;
    ctx.stroke(paths.motorway);

    if (paths.bus && scene.showBus) {
      ctx.strokeStyle = COLOURS.busNet;
      ctx.lineWidth = px(1) + 0.08;
      ctx.stroke(paths.bus);
    }

    if (scene.ghost) {
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = 'rgba(255,209,102,0.35)';
      ctx.lineWidth = px(1);
      ctx.stroke(paths.ghost);
      ctx.globalAlpha = 1;
    }

    // Rail lines, dimmed when their tick box is off.
    for (const [mode, group] of paths.rail) {
      const on = !!scene.enabled[GROUP_OF_MODE[mode]];
      ctx.globalAlpha = on ? (mode === 'national-rail' ? 0.75 : 0.95) : 0.18;
      ctx.setLineDash(mode === 'national-rail' ? [px(6), px(4)] : []);
      ctx.lineWidth = px(MODE_WIDTH[mode]) + (on ? 0.12 : 0.05);
      for (const [lineIdx, path] of group) {
        ctx.strokeStyle = lines[lineIdx].colour;
        ctx.stroke(path);
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    if (scene.route) this.drawRoute(ctx, scene, px);

    // Screen space from here on.
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

    this.drawRings(ctx, scene, ox, oy, k);
    this.drawNodes(ctx, scene, S, k);
    this.drawOriginDot(ctx, ox, oy);
    this.drawLabels(ctx, scene, S, k, ox, oy);
  }

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

  drawRings(ctx, scene, ox, oy, k) {
    const scale = scene.ringScale * k;
    if (!(scale > 0)) return;
    const alpha = Math.max(0, Math.min(1, scene.morph)) ** 2;
    if (alpha <= 0.02) return;
    const maxR = Math.hypot(this.w, this.h);
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
      if (ly > 8 && ly < this.h && ox > 0 && ox < this.w) {
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

  // Stations and places, batched into one path per fill/stroke combination.
  drawNodes(ctx, scene, S, k) {
    const { nodes, times } = scene;
    const w = this.w;
    const h = this.h;
    const margin = 10;
    const buckets = this.nodeBuckets;
    buckets.clear();
    const add = (fill, stroke, r, x, y) => {
      const key = `${fill}|${stroke}|${r}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { fill, stroke, path: new Path2D() };
        buckets.set(key, bucket);
      }
      bucket.path.moveTo(x + r, y);
      bucket.path.arc(x, y, r, 0, TAU);
    };
    const stationR = k < 1.5 ? 1.7 : 2.2;
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
            unreachable ? 'rgba(200,208,220,0.35)' : 'rgba(232,236,241,0.9)', stationR + 1.2, x, y);
        } else {
          add(unreachable ? 'rgba(160,170,185,0.3)' : colour || 'rgba(190,200,215,0.85)', null, stationR, x, y);
        }
      } else {
        const r = n.tier === 1 ? 3.8 : n.tier === 2 ? 3.2 : 2.6;
        add(unreachable ? 'rgba(255,255,255,0.25)' : colour || '#ffffff',
          unreachable ? 'rgba(255,255,255,0.4)' : '#ffffff', r, x, y);
      }
    }
    for (const bucket of buckets.values()) {
      ctx.fillStyle = bucket.fill;
      ctx.fill(bucket.path);
      if (bucket.stroke) {
        ctx.strokeStyle = bucket.stroke;
        ctx.lineWidth = 1.2;
        ctx.stroke(bucket.path);
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

  drawLabels(ctx, scene, S, k, ox, oy) {
    const { nodes, times } = scene;
    const w = this.w;
    const h = this.h;
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

    const placed = [];
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
        const bx0 = x0 - 2;
        const bx1 = x0 + tw + 2;
        const by0 = opt.y - th / 2 - 1;
        const by1 = opt.y + th / 2 + 1;
        if (bx0 < 2 || by0 < 2 || bx1 > w - 2 || by1 > h - 2) continue;
        let clash = false;
        for (let p = 0; p < placed.length && !clash; p++) {
          const q = placed[p];
          clash = bx0 < q[2] && bx1 > q[0] && by0 < q[3] && by1 > q[1];
        }
        if (clash) continue;
        placed.push([bx0, by0, bx1, by1]);
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
