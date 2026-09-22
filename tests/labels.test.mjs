import test from 'node:test';
import assert from 'node:assert/strict';
import { LabelIndex } from '../src/render.js';

test('label collision index preserves strict overlap rules at cell boundaries', () => {
  const index = new LabelIndex();
  index.insert([-20, -20, 64, 64]);
  assert.equal(index.overlaps([64, 0, 100, 20]), false);
  assert.equal(index.overlaps([63, 0, 100, 20]), true);
  assert.equal(index.overlaps([-21, -21, -19, -19]), true);
  assert.equal(index.overlaps([200, 200, 220, 220]), false);
});

test('dense label placement agrees with the original full collision scan', () => {
  const index = new LabelIndex();
  const placed = [];
  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 5000; i++) {
    const x = random() * 1800 - 200;
    const y = random() * 1200 - 200;
    const box = [x, y, x + 15 + random() * 240, y + 12 + random() * 8];
    const expected = placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1]);
    assert.equal(index.overlaps(box), expected);
    if (!expected) { placed.push(box); index.insert(box); }
  }
});
