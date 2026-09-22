import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Engine } from '../src/engine.js';
import { WalkGrid } from '../src/walkgrid.js';
import { unpackTransit } from '../src/data.js';
import { Calculator } from '../src/calculate.js';
import { RoutingClient } from '../src/routing-client.js';

const json = async (file) => JSON.parse(await readFile(new URL(`../data/${file}.json`, import.meta.url), 'utf8'));
const [transitJSON, gridJSON, places] = await Promise.all(['transit', 'walkgrid', 'places'].map(json));
const transit = unpackTransit(transitJSON);
const grid = WalkGrid.fromJSON(gridJSON);
const engine = new Engine(transit, grid);
const nodes = transit.stations.map((s) => ({ kind: 'station', stop: s.stop, lat: transit.stopLat[s.stop], lon: transit.stopLon[s.stop] })).concat(places.map((p) => ({ ...p, kind: 'place' })));
const calculator = new Calculator(engine, nodes);
const origin = places.find((p) => p.name === 'Trafalgar Square');
const enabled = { foot: false, underground: true, trains: true, bus: true, car: true };

test('background calculation preserves the original travel times and surface', () => {
  const result = calculator.compute(origin, enabled);
  // Captured from the original application before moving its computation to a worker.
  assert.deepEqual([0, 100, 400, 800].map((i) => result.times[i]), [46.35792265415192, 50.83506235105371, 37.40513915538788, 23.024668955953555]);
  assert.deepEqual([10000, 40000, 80000, 120000].map((i) => result.surface[i]), [50.859004974365234, 64.8410873413086, 49.62413024902344, 54.62693786621094]);
  assert.ok(result.contours.coords.length > 0);
  assert.equal(result.contours.bands.length, 9);
  assert.ok(result.coverage.within45 > 0);
  assert.ok(engine.journey(result.result, engine.stopCell[transit.stations[400].stop]).legs.length > 0);
});

test('no modes and an origin outside the map clear all derived data', () => {
  for (const output of [calculator.compute(origin, {}), calculator.compute({ lat: 0, lon: 0 }, enabled)]) {
    for (const key of ['times', 'surface', 'contours', 'result', 'nodeByCar']) assert.equal(output[key], null);
    assert.equal(output.coverage.within45, 0);
  }
});

test('walking-only mode does not retain rides from the previous calculation', () => {
  const output = calculator.compute(origin, { foot: true });
  const journey = engine.journey(output.result, engine.stopCell[transit.stations[400].stop]);
  assert.ok(journey.legs.length);
  assert.ok(journey.legs.every((leg) => leg.kind === 'walk'));
  assert.ok(output.nodeByCar.every((value) => value === 0));
});

class WorkerStub {
  static latest;
  constructor() { WorkerStub.latest = this; this.messages = []; }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  result(id, output) { this.onmessage({ data: { id, output } }); }
}

test('rapid changes coalesce and only the latest calculation is displayed', (t) => {
  t.mock.method(globalThis, 'setTimeout', () => 1);
  const previous = globalThis.Worker;
  globalThis.Worker = WorkerStub;
  t.after(() => { globalThis.Worker = previous; });
  const results = [];
  const client = new RoutingClient({}, () => assert.fail('unexpected fallback'), (result) => results.push(result));
  const worker = WorkerStub.latest;
  const modes = { foot: true };
  client.request(origin, modes);
  modes.foot = false;
  client.request({ ...origin, name: 'Second' }, modes);
  client.request({ ...origin, name: 'Latest' }, modes);
  assert.equal(worker.messages.length, 2); // init plus the first request
  assert.equal(worker.messages[1].enabled.foot, true); // state is snapshotted
  worker.result(1, 'stale');
  assert.deepEqual(results, []);
  assert.equal(worker.messages[2].origin.name, 'Latest');
  worker.result(3, 'current');
  assert.deepEqual(results, ['current']);
});

test('a worker failure falls back to the newest request', async (t) => {
  const previous = globalThis.Worker;
  globalThis.Worker = WorkerStub;
  t.after(() => { globalThis.Worker = previous; });
  const results = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const client = new RoutingClient({}, (point) => point.name, (result) => { results.push(result); finish(); });
  const worker = WorkerStub.latest;
  client.request({ ...origin, name: 'Old' }, {});
  client.request({ ...origin, name: 'New' }, {});
  worker.onerror({ preventDefault() {} });
  await finished;
  assert.equal(worker.terminated, true);
  assert.deepEqual(results, ['New']);
});

test('browsers without workers still calculate the selected view', async (t) => {
  const previous = globalThis.Worker;
  globalThis.Worker = undefined;
  t.after(() => { globalThis.Worker = previous; });
  const result = await new Promise((resolve) => {
    const client = new RoutingClient({}, (point) => point.name, resolve);
    client.request({ ...origin, name: 'Offline-compatible fallback' }, {});
  });
  assert.equal(result, 'Offline-compatible fallback');
});
