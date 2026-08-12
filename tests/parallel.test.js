import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapPool } from '../src/lib/parallel.js';

describe('mapPool', () => {
  it('preserves order of results', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapPool(items, 2, async (n) => {
      await new Promise((r) => setTimeout(r, (6 - n) * 5));
      return n * 10;
    });
    assert.deepEqual(results, [10, 20, 30, 40, 50]);
  });

  it('limits concurrency', async () => {
    let live = 0;
    let maxLive = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapPool(items, 3, async () => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      await new Promise((r) => setTimeout(r, 20));
      live -= 1;
    });
    assert.ok(maxLive <= 3, `expected maxLive <= 3, got ${maxLive}`);
    assert.ok(maxLive >= 2, `expected some parallelism, got ${maxLive}`);
  });

  it('treats invalid concurrency as 1', async () => {
    const results = await mapPool([1, 2], 0, async (n) => n + 1);
    assert.deepEqual(results, [2, 3]);
  });
});
