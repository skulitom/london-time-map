// Shared by the background worker and the fallback for browsers that cannot start one.
import { toMetres, METRES_PER_DEG } from './engine.js';
import { contourBands } from './contours.js';
import { MODES, BAND_THRESHOLDS, CENTRE, CAR, CAR_MINUTES_PER_METRE, carMinutes, carFloorMinutes } from './model.js';

export class Calculator {
  constructor(engine, nodes) {
    this.engine = engine;
    this.grid = engine.grid;
    this.nodes = nodes.map((node) => {
      const [x, y] = toMetres(node.lon, node.lat);
      return { x, y, cell: node.kind === 'station' ? engine.stopCell[node.stop] : this.grid.nearestWalkable(this.grid.cellOf(node.lon, node.lat)) };
    });
    this.bandValues = new Float64Array(this.grid.count);
  }

  compute(origin, enabled) {
    const { engine, grid, nodes } = this;
    const originCell = grid.nearestWalkable(grid.cellOf(origin.lon, origin.lat));
    if (!MODES.some((m) => enabled[m.id]) || originCell < 0) {
      return { result: null, times: null, nodeByCar: null, surface: null, contours: null, coverage: { londonCells: 0, within45: 0 }, timing: {} };
    }
    const t0 = performance.now();
    const result = engine.route(originCell, enabled);
    const t1 = performance.now();
    const { dist } = result;
    const [ox, oy] = toMetres(origin.lon, origin.lat);
    const surface = new Float32Array(grid.count);
    const { cols, rows, mask, london, lon0, lat0 } = grid;
    const [lon1, lat1] = grid.lonLatOfGrid(1, 1);
    const dLon = lon1 - lon0;
    const dLat = lat1 - lat0;
    const stepX = dLon * METRES_PER_DEG.x;
    let londonCells = 0;
    let within45 = 0;
    for (let j = 0, c = 0; j < rows; j++) {
      const my = (lat0 + (j + 0.5) * dLat - CENTRE.lat) * METRES_PER_DEG.y;
      let mx = (lon0 + 0.5 * dLon - CENTRE.lon) * METRES_PER_DEG.x;
      for (let i = 0; i < cols; i++, c++, mx += stepX) {
        let t = dist[c];
        if (enabled.car && t > CAR.overhead) {
          const dx = mx - ox;
          const dy = my - oy;
          if (t > CAR.overhead + Math.sqrt(dx * dx + dy * dy) * CAR_MINUTES_PER_METRE) t = Math.min(t, carMinutes(ox, oy, mx, my));
        }
        surface[c] = t;
        if (london[c] && mask[c]) {
          londonCells++;
          if (t <= 45) within45++;
        }
      }
    }
    const times = new Float64Array(nodes.length);
    const nodeByCar = new Uint8Array(nodes.length);
    nodes.forEach(({ x, y, cell }, i) => {
      let t = cell >= 0 ? dist[cell] : Infinity;
      if (enabled.car && t > carFloorMinutes(Math.hypot(x - ox, y - oy))) {
        const tc = carMinutes(ox, oy, x, y);
        if (tc < t) { t = tc; nodeByCar[i] = 1; }
      }
      times[i] = t;
    });
    const t2 = performance.now();
    for (let c = 0; c < grid.count; c++) this.bandValues[c] = Number.isFinite(surface[c]) ? surface[c] : 1e9;
    const contours = contourBands(this.bandValues, cols, rows, [...BAND_THRESHOLDS, 1e8]);
    return { result, times, nodeByCar, surface, contours, coverage: { londonCells, within45 }, timing: { routeMs: t1 - t0, surfaceMs: t2 - t1, bandsMs: performance.now() - t2 } };
  }
}
