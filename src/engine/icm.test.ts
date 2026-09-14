import { describe, expect, it } from 'vitest';
import { icmEquity } from './icm';

describe('icmEquity', () => {
  it('matches hand-computed 3-player example', () => {
    // stacks 50/30/20, payouts 50/30/20
    const eq = icmEquity([50, 30, 20], [0.5, 0.3, 0.2]);
    // P1 first = 0.5; P1 second = 0.3*50/70 + 0.2*50/80 = 0.33929; third = rest
    const p1First = 0.5;
    const p1Second = 0.3 * (50 / 70) + 0.2 * (50 / 80);
    const p1Third = 1 - p1First - p1Second;
    expect(eq[0]).toBeCloseTo(0.5 * p1First + 0.3 * p1Second + 0.2 * p1Third, 10);
    expect(eq[0] + eq[1] + eq[2]).toBeCloseTo(1, 10);
  });

  it('equal stacks split equally', () => {
    const eq = icmEquity([10, 10, 10, 10], [0.5, 0.3, 0.2]);
    for (const e of eq) expect(e).toBeCloseTo(0.25, 10);
  });

  it('winner-take-all equals chip share', () => {
    const eq = icmEquity([10, 30, 60], [1]);
    expect(eq[0]).toBeCloseTo(0.1, 10);
    expect(eq[2]).toBeCloseTo(0.6, 10);
  });

  it('busted players take bottom places by starting stack', () => {
    const eq = icmEquity([100, 0, 0], [0.5, 0.3, 0.2], [40, 30, 30.0001]);
    expect(eq[0]).toBeCloseTo(0.5, 10);
    expect(eq[2]).toBeCloseTo(0.3, 10);
    expect(eq[1]).toBeCloseTo(0.2, 10);
    const tie = icmEquity([100, 0, 0], [0.5, 0.3, 0.2], [40, 30, 30]);
    expect(tie[1]).toBeCloseTo(0.25, 10);
    expect(tie[2]).toBeCloseTo(0.25, 10);
  });
});
