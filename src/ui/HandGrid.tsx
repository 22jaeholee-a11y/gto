import { memo } from 'react';
import { classLabel, NUM_CLASSES } from '../engine/cards';
import type { SolveResult } from '../engine/solver';
import type { LightDecision } from '../worker/protocol';
import { actionColor, signed } from './format';
import { evOf, freqOf, raiseRank } from './spot';

export type GridView = 'strategy' | 'evIcm' | 'evChip';

interface Props {
  result: SolveResult;
  node: LightDecision;
  reach: Float64Array;
  view: GridView;
  selected: number | null;
  onHover: (h: number | null) => void;
  onSelect: (h: number) => void;
}

export const HandGrid = memo(function HandGrid({ result, node, reach, view, selected, onHover, onSelect }: Props) {
  const A = node.actions.length;
  const evArr = view === 'evChip' ? result.evChip : result.evIcm;

  // node value per hand = strategy-weighted EV; scale colors by the largest magnitude among reached hands
  const values = new Float64Array(NUM_CLASSES);
  let maxAbs = 0;
  if (view !== 'strategy') {
    for (let h = 0; h < NUM_CLASSES; h++) {
      let v = 0;
      for (let a = 0; a < A; a++) v += freqOf(result, node, a, h) * evOf(evArr, result, node, a, h);
      values[h] = v;
      if (reach[h] > 0.001 && Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
    }
  }
  const digits = view === 'evIcm' ? 2 : 1;

  return (
    <div className="grid" role="grid" aria-label="13×13 핸드 차트" onMouseLeave={() => onHover(null)}>
      {Array.from({ length: NUM_CLASSES }, (_, h) => {
        const w = reach[h];
        const dim = w < 0.001;
        let body;
        if (view === 'strategy') {
          body = (
            <span className="bars" style={{ height: `${Math.max(0, Math.min(1, w)) * 100}%` }}>
              {node.actions.map((act, a) => {
                const f = freqOf(result, node, a, h);
                return f > 0.0005 ? <span key={a} style={{ flexGrow: f, background: actionColor(act.type, raiseRank(node, a)) }} /> : null;
              })}
            </span>
          );
        } else {
          const v = values[h];
          const t = maxAbs > 0 && Number.isFinite(v) ? Math.min(1, Math.abs(v) / maxAbs) : 0;
          body = (
            <>
              <span className="ev-fill" style={{ background: v >= 0 ? 'var(--ev-pos)' : 'var(--ev-neg)', opacity: dim ? 0 : 0.15 + 0.85 * t }} />
              <span className="ev-num">{dim || !Number.isFinite(v) ? '' : signed(v, digits)}</span>
            </>
          );
        }
        return (
          <button
            type="button"
            role="gridcell"
            key={h}
            className={`cell${dim ? ' dim' : ''}${selected === h ? ' sel' : ''}`}
            onMouseEnter={() => onHover(h)}
            onFocus={() => onHover(h)}
            onClick={() => onSelect(h)}
            aria-label={classLabel(h)}
          >
            {body}
            <span className="cell-label">{classLabel(h)}</span>
          </button>
        );
      })}
    </div>
  );
});
