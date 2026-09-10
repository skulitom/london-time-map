// Canvas renderer. Map geometry is drawn in "base" space under the zoom transform; markers and
// labels are drawn in screen space on top.

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
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.nodeScreen = null;
    this.tintCache = new Map();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  tint(colour) {
    if (!this.tintCache.has(colour)) this.tintCache.set(colour, blend(colour, COLOURS.land, BAND_OPACITY));
    return this.tintCache.get(colour);
  }

  trace(coords, start, count, close) {
    const ctx = this.ctx;
    ctx.moveTo(coords[2 * start], coords[2 * start + 1]);
    for (let i = start + 1; i < start + count; i++) ctx.lineTo(coords[2 * i], coords[2 * i + 1]);
    if (close) ctx.closePath();
  }

  drawPolygons(coords, polys, fill, stroke, width) {
    const ctx = this.ctx;
    for (const poly of polys) {
      ctx.beginPath();
      for (const [s, c] of poly.rings) this.trace(coords, s, c, true);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill('evenodd');
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = width;
        ctx.stroke();
      }
    }
  }

  drawLines(coords, segs, stroke, width, dash) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (const [s, c] of segs) this.trace(coords, s, c, false);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  draw(scene) {
    const { ctx, dpr, w, h } = this;
    const { transform: { x: tx, y: ty, k }, layers, mesh, lines } = scene;
    const W = mesh.warped;
    const px = (n) => n / k;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLOURS.bg;
    ctx.fillRect(0, 0, w, h);

    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    this.drawPolygons(W, layers.boroughs, COLOURS.land, null, 0);

    // Travel-time bands, clipped to Greater London.
    if (scene.bands) {
      ctx.save();
      ctx.beginPath();
      for (const b of layers.boroughs) for (const [s, c] of b.rings) this.trace(W, s, c, true);
      ctx.clip('nonzero');
      const coords = scene.bands.coords;
      for (const band of scene.bands.list) {
        ctx.fillStyle = this.tint(band.colour);
        for (const polygon of band.polygons) {
          ctx.beginPath();
          for (const [s, c] of polygon) this.trace(coords, s, c, true);
          ctx.fill('evenodd');
        }
      }
      ctx.restore();
    }

    this.drawPolygons(W, layers.boroughs, null, COLOURS.landBorder, px(1));
    ctx.globalAlpha = scene.bands ? 0.55 : 1;
    this.drawPolygons(W, layers.parks, COLOURS.park, null, 0);
    ctx.globalAlpha = 1;
    this.drawLines(W, layers.thamesLine, COLOURS.water, 3.2);
    this.drawPolygons(W, layers.thames, COLOURS.water, COLOURS.waterEdge, px(0.8));
    this.drawPolygons(W, layers.water, COLOURS.water, COLOURS.waterEdge, px(0.6));
    this.drawLines(W, layers.roads.trunk, COLOURS.trunk, px(1.1) + 0.15);
    this.drawLines(W, layers.roads.motorway, COLOURS.motorway, px(1.6) + 0.25);

    if (scene.busSegments && scene.showBus) {
      const seg = scene.busSegments;
      ctx.beginPath();
      for (let i = 0; i < seg.length; i += 4) {
        ctx.moveTo(seg[i], seg[i + 1]);
        ctx.lineTo(seg[i + 2], seg[i + 3]);
      }
      ctx.strokeStyle = COLOURS.busNet;
      ctx.lineWidth = px(1) + 0.08;
      ctx.stroke();
    }

    if (scene.ghost) {
      ctx.globalAlpha = 0.5;
      this.drawPolygons(mesh.base, layers.boroughs, null, 'rgba(255,209,102,0.35)', px(1));
      ctx.globalAlpha = 1;
    }

    // Rail lines, dimmed when their tick box is off.
    for (const mode of MODE_ORDER) {
      const group = layers.railByMode[mode];
      if (!group) continue;
      const on = !!scene.enabled[GROUP_OF_MODE[mode]];
      ctx.globalAlpha = on ? (mode === 'national-rail' ? 0.75 : 0.95) : 0.18;
      const dash = mode === 'national-rail' ? [px(6), px(4)] : null;
      for (const [lineIdx, segs] of group) {
        this.drawLines(W, segs, lines[lineIdx].colour, px(MODE_WIDTH[mode]) + (on ? 0.12 : 0.05), dash);
      }
    }
    ctx.globalAlpha = 1;

    if (scene.route) this.drawRoute(scene, px);

    // Everything below is in screen space.
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

    this.drawRings(scene, ox, oy, k);
    this.drawNodes(scene, S, k);
    this.drawOrigin(scene, ox, oy);
    this.drawLabels(scene, S, k, ox, oy);
  }

  drawRoute(scene, px) {
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const passes = [
      { halo: true },
      { halo: false },
    ];
    for (const pass of passes) {
      for (const seg of scene.route.segments) {
        const c = seg.coords;
        if (c.length < 4) continue;
        ctx.beginPath();
        ctx.moveTo(c[0], c[1]);
        for (let i = 2; i < c.length; i += 2) ctx.lineTo(c[i], c[i + 1]);
        if (pass.halo) {
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

  drawRings(scene, ox, oy, k) {
    const { ctx, w, h } = this;
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
      ctx.arc(ox, oy, r, 0, Math.PI * 2);
      ctx.strokeStyle = COLOURS.ring;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      const lx = ox;
      const ly = oy - r - 3;
      if (ly > 8 && ly < h && lx > 0 && lx < w) {
        const label = `${t} min`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = COLOURS.bg;
        ctx.globalAlpha = alpha * 0.85;
        ctx.fillRect(lx - tw / 2 - 4, ly - 13, tw + 8, 14);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = COLOURS.ringLabel;
        ctx.fillText(label, lx, ly);
      }
    }
    ctx.restore();
  }

  drawNodes(scene, S, k) {
    const { ctx, w, h } = this;
    const { nodes, times } = scene;
    const margin = 10;
    const colourOf = (i) => (times ? bandColour(times[i]) : null);
    if (scene.showStations) {
      const r0 = k < 1.5 ? 1.7 : 2.2;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.kind !== 'station') continue;
        const x = S[2 * i];
        const y = S[2 * i + 1];
        if (x < -margin || y < -margin || x > w + margin || y > h + margin) continue;
        const interchange = n.lineIds.size >= 2;
        const unreachable = times && !Number.isFinite(times[i]);
        const colour = colourOf(i);
        ctx.beginPath();
        ctx.arc(x, y, interchange ? r0 + 1.2 : r0, 0, Math.PI * 2);
        if (interchange) {
          ctx.fillStyle = unreachable ? 'rgba(20,26,36,0.9)' : colour || COLOURS.bg;
          ctx.fill();
          ctx.strokeStyle = unreachable ? 'rgba(200,208,220,0.35)' : 'rgba(232,236,241,0.9)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        } else {
          ctx.fillStyle = unreachable ? 'rgba(160,170,185,0.3)' : colour || 'rgba(190,200,215,0.85)';
          ctx.fill();
        }
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.kind !== 'place') continue;
      const x = S[2 * i];
      const y = S[2 * i + 1];
      if (x < -margin || y < -margin || x > w + margin || y > h + margin) continue;
      const unreachable = times && !Number.isFinite(times[i]);
      const r = n.tier === 1 ? 3.8 : n.tier === 2 ? 3.2 : 2.6;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = unreachable ? 'rgba(255,255,255,0.25)' : colourOf(i) || '#ffffff';
      ctx.fill();
      ctx.strokeStyle = unreachable ? 'rgba(255,255,255,0.4)' : '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    if (scene.hover >= 0) {
      const x = S[2 * scene.hover];
      const y = S[2 * scene.hover + 1];
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = COLOURS.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  drawOrigin(scene, ox, oy) {
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 500);
    ctx.beginPath();
    ctx.arc(ox, oy, 11 + pulse * 3, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,209,102,${0.35 + 0.25 * (1 - pulse)})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ox, oy, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = COLOURS.accent;
    ctx.fill();
    ctx.strokeStyle = COLOURS.bg;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  drawLabels(scene, S, k, ox, oy) {
    const { ctx, w, h } = this;
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
      candidates.push({ x: S[2 * n.index], y: S[2 * n.index + 1], text: n.name, priority: -0.5, size: 12, weight: 600, colour: COLOURS.text, offset: 8, index: n.index });
    }
    candidates.sort((a, b) => a.priority - b.priority);

    const placed = [];
    const overlaps = (b) => placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const c of candidates) {
      ctx.font = `${c.weight} ${c.size}px Inter, system-ui, sans-serif`;
      const tw = ctx.measureText(c.text).width;
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
        const box = { x0: x0 - 2, x1: x0 + tw + 2, y0: opt.y - th / 2 - 1, y1: opt.y + th / 2 + 1 };
        if (box.x0 < 2 || box.y0 < 2 || box.x1 > w - 2 || box.y1 > h - 2) continue;
        if (overlaps(box)) continue;
        placed.push(box);
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
