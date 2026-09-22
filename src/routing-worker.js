import { Engine } from './engine.js';
import { WalkGrid } from './walkgrid.js';
import { unpackTransit } from './data.js';
import { Calculator } from './calculate.js';

let calculator;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      calculator = new Calculator(new Engine(unpackTransit(data.transit), WalkGrid.fromJSON(data.grid)), data.nodes);
      return;
    }
    const output = calculator.compute(data.origin, data.enabled);
    // The engine reuses its search buffers. Transfer copies so the next search retains its storage.
    if (output.result) {
      output.result = { ...output.result };
      for (const key of ['dist', 'prev', 'via', 'viaLine']) output.result[key] = output.result[key].slice();
    }
    const transfers = [];
    for (const value of [output.times, output.nodeByCar, output.surface, output.contours?.coords, ...Object.values(output.result || {})]) {
      if (ArrayBuffer.isView(value)) transfers.push(value.buffer);
    }
    self.postMessage({ id: data.id, output }, transfers);
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
