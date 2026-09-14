import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config';
import { describeScenario, mulberry32, PAYOUT_PRESETS, randomScenario } from './scenario';

describe('describeScenario', () => {
  it('names every payout preset and the hero stack rank', () => {
    for (const preset of PAYOUT_PRESETS) {
      const config = { ...DEFAULT_CONFIG, stacks: [10, 30, 20, 25, 15, 40, 12, 18], payouts: preset.payouts(8) };
      const info = describeScenario(config, 2);
      expect(info.payout?.name).toBe(preset.name);
      expect(info.heroStack).toBe(20);
      expect(info.heroRank).toBe(4);
    }
    const bubble = describeScenario({ ...DEFAULT_CONFIG, payouts: PAYOUT_PRESETS[2].payouts(8) });
    expect(bubble.paidPlaces).toBe(7);
  });

  it('handles chip EV and unknown payout tables', () => {
    expect(describeScenario({ ...DEFAULT_CONFIG, mode: 'chip', payouts: [1] }).payout).toBeNull();
    const custom = describeScenario({ ...DEFAULT_CONFIG, payouts: [50, 30, 20] });
    expect(custom.payout?.name).toBe('버블');
    const sc = randomScenario(mulberry32(1));
    expect(sc.label).not.toContain('평탄');
  });
});
