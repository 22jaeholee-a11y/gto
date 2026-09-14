import { useEffect, useState } from 'react';
import { classLabel, NUM_CLASSES } from '../../engine/cards';
import type { RangeReview } from '../../engine/training/hand';

const N = NUM_CLASSES;

export type RangeTab = 'strategy' | number;

function kindColor(label: string, index: number, labels: string[]): string {
  const w = label.split(' ')[0].toLowerCase();
  if (w === 'fold') return 'var(--act-fold)';
  if (w === 'check' || w === 'call' || w === 'limp') return 'var(--act-call)';
  if (w === 'all-in') return 'var(--act-allin)';
  // sized bets/raises: smallest brightest
  const sized = labels.map((l, i) => ({ l, i })).filter(({ l }) => /^(Bet|Raise)/.test(l));
  const rank = sized.findIndex(({ i }) => i === index);
  return rank <= 0 ? 'var(--act-raise)' : 'var(--act-raise-2)';
}

function signed(x: number | null, digits: number): string {
  if (x === null || !Number.isFinite(x)) return '—';
  const s = x.toFixed(digits);
  return `${x > 0 && Number(s) !== 0 ? '+' : ''}${s}`;
}

interface Props {
  range: RangeReview;
  primary: 'icm' | 'chip';
  chosen: number;
  tab: RangeTab;
  onTab: (t: RangeTab) => void;
}

export function RangePanel({ range, primary, chosen, tab, onTab }: Props) {
  const [focus, setFocus] = useState<number>(range.heroClass);
  useEffect(() => setFocus(range.heroClass), [range]);
  const A = range.actions.length;
  const ev = primary === 'icm' ? range.evIcm : range.evChip;
  const digits = primary === 'icm' ? 3 : 2;
  const cellDigits = primary === 'icm' ? 2 : 1;
  const unit = primary === 'icm' ? '%p' : 'bb';

  // colour scale for EV view: relative to the largest magnitude among classes in range
  let maxAbs = 0;
  if (tab !== 'strategy') {
    for (let c = 0; c < N; c++) {
      const v = ev[c * A + tab];
      if (range.weight[c] > 0.001 && Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
    }
  }

  const f = focus;
  return (
    <section className="range-panel">
      <div className="range-head">
        <p className="eyebrow">히어로 레인지 · {range.combos.toFixed(1)}콤보</p>
        <p className="range-value">
          GTO 레인지 EV <b>{signed(primary === 'icm' ? range.valueIcm : range.valueChip, digits)}{unit}</b>
        </p>
      </div>

      <div className="review-table-wrap">
        <table className="review-table range-summary-table">
          <thead>
            <tr>
              <th scope="col">액션</th>
              <th scope="col">레인지 빈도</th>
              <th scope="col">평균 EV ({unit})</th>
              {primary === 'icm' && <th scope="col">Chip EV</th>}
            </tr>
          </thead>
          <tbody>
            {range.actions.map((label, a) => (
              <tr key={a} className={`${a === chosen ? 'chosen' : ''}${tab === a ? ' viewing' : ''}`}>
                <th scope="row">
                  <button type="button" className="range-action" onClick={() => onTab(a)} aria-pressed={tab === a}>
                    <span className="swatch" style={{ background: kindColor(label, a, range.actions) }} />
                    {label}
                  </button>
                </th>
                <td>{(range.summary[a].freq * 100).toFixed(1)}%</td>
                <td>{signed(primary === 'icm' ? range.summary[a].evIcm : range.summary[a].evChip, digits)}</td>
                {primary === 'icm' && <td>{signed(range.summary[a].evChip, 2)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="seg small range-tabs" role="tablist" aria-label="레인지 차트 보기">
        <button type="button" role="tab" aria-selected={tab === 'strategy'} className={tab === 'strategy' ? 'on' : ''} onClick={() => onTab('strategy')}>전략</button>
        {range.actions.map((label, a) => (
          <button key={a} type="button" role="tab" aria-selected={tab === a} className={tab === a ? 'on' : ''} onClick={() => onTab(a)}>
            {label.split(' (')[0]} EV
          </button>
        ))}
      </div>

      <div className="grid range-grid" role="grid" aria-label="레인지 차트">
        {Array.from({ length: N }, (_, c) => {
          const w = range.weight[c];
          const dim = w < 0.001 && c !== range.heroClass;
          let body;
          if (tab === 'strategy') {
            body = (
              <span className="bars" style={{ height: `${Math.min(1, w) * 100}%` }}>
                {range.actions.map((label, a) => {
                  const fr = range.freq[c * A + a];
                  return fr > 0.002 ? <span key={a} style={{ flexGrow: fr, background: kindColor(label, a, range.actions) }} /> : null;
                })}
              </span>
            );
          } else {
            const v = ev[c * A + tab];
            const t = maxAbs > 0 && Number.isFinite(v) ? Math.min(1, Math.abs(v) / maxAbs) : 0;
            body = (
              <>
                <span className="ev-fill" style={{ background: v >= 0 ? 'var(--ev-pos)' : 'var(--ev-neg)', opacity: dim || !Number.isFinite(v) ? 0 : 0.15 + 0.85 * t }} />
                <span className="ev-num">{dim || !Number.isFinite(v) ? '' : signed(v, cellDigits)}</span>
              </>
            );
          }
          return (
            <button
              key={c}
              type="button"
              role="gridcell"
              className={`cell${dim ? ' dim' : ''}${c === range.heroClass ? ' hero-cell' : ''}${c === f ? ' sel' : ''}`}
              aria-label={classLabel(c)}
              onClick={() => setFocus(c)}
            >
              {body}
              <span className="cell-label">{classLabel(c)}</span>
            </button>
          );
        })}
      </div>

      <div className="range-focus">
        <b>{classLabel(f)}</b>
        {f === range.heroClass && range.weight[f] < 0.001 && <span className="muted">히어로 핸드 · GTO 레인지 밖</span>}
        {range.weight[f] <= 0 ? (
          <span className="muted"> 레인지에 없음</span>
        ) : (
          range.actions.map((label, a) => (
            <span key={a} className="focus-item">
              <span className="swatch" style={{ background: kindColor(label, a, range.actions) }} />
              {label.split(' (')[0]} {(range.freq[f * A + a] * 100).toFixed(0)}% <em>{signed(ev[f * A + a], digits)}</em>
            </span>
          ))
        )}
      </div>
      <p className="hint">셀 EV는 이 결정 지점에 도달한 해당 핸드의 기대값({unit}, 핸드 시작 대비)입니다. 흐린 셀은 레인지에 없는 핸드입니다.</p>
    </section>
  );
}
