import { describe, expect, it } from 'vitest';
import { firstVs, multiwayFirst, multiwayTable } from './multiway';

describe('multiway model', () => {
  it('fast path matches the reference implementation', () => {
    const table = multiwayTable();
    let seed = 9;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 2000; t++) {
      const h = Math.floor(rand() * 169);
      const b = [rand(), rand(), rand()];
      expect(firstVs(h, b[0], b[1])).toBeCloseTo(multiwayFirst(table, h, b.slice(0, 2)), 3);
      expect(firstVs(h, b[0], b[1], b[2])).toBeCloseTo(multiwayFirst(table, h, b), 3);
    }
  });

  it('gives 1/3 for a random hand against two random ranges and respects bounds', () => {
    // average hand vs random ranges: pairwise 0.5 each -> about 1/3 for three-way
    let s = 0;
    for (let h = 0; h < 169; h++) s += firstVs(h, 0.5, 0.5);
    expect(s / 169).toBeGreaterThan(0.3);
    expect(s / 169).toBeLessThan(0.37);
    expect(firstVs(0, 0.9, 0.2)).toBeLessThanOrEqual(0.2);
    expect(firstVs(0, 0.9, 0.95)).toBeGreaterThanOrEqual(0.85);
  });
});
