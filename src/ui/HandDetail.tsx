import { classLabel, COMBOS } from '../engine/cards';
import type { SolveResult } from '../engine/solver';
import type { LightDecision } from '../worker/protocol';
import { actionColor, pct, signed } from './format';
import { evOf, freqOf, label, raiseRank } from './spot';

interface Props {
  result: SolveResult;
  node: LightDecision;
  hand: number;
  reach: number;
  mode: 'icm' | 'chip';
}

export function HandDetail({ result, node, hand, reach, mode }: Props) {
  const rows = node.actions.map((a, i) => ({
    a,
    i,
    freq: freqOf(result, node, i, hand),
    icm: evOf(result.evIcm, result, node, i, hand),
    chip: evOf(result.evChip, result, node, i, hand),
  }));
  const key = mode === 'icm' ? 'icm' : 'chip';
  const best = rows.reduce((b, r) => (Number.isFinite(r[key]) && (b === null || r[key] > b[key]) ? r : b), null as (typeof rows)[number] | null);
  const nodeIcm = rows.reduce((s, r) => s + r.freq * r.icm, 0);
  const nodeChip = rows.reduce((s, r) => s + r.freq * r.chip, 0);

  return (
    <div className="detail">
      <div className="detail-head">
        <span className="detail-hand">{classLabel(hand)}</span>
        <span className="detail-meta">{COMBOS[hand]}콤보 · 레인지 비중 {pct(reach, 0)}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">액션</th>
            <th scope="col">빈도</th>
            <th scope="col" title="상금 풀 대비 지분 변화 (%p)">ICM EV</th>
            <th scope="col">Chip EV</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.i} className={best === r ? 'best' : ''}>
              <th scope="row">
                <span className="swatch" style={{ background: actionColor(r.a.type, raiseRank(node, r.i)) }} />
                {label(r.a, node)}
              </th>
              <td>{pct(r.freq)}</td>
              <td>{signed(r.icm, 3)}</td>
              <td>{signed(r.chip, 2)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">전략 평균</th>
            <td />
            <td>{signed(nodeIcm, 3)}</td>
            <td>{signed(nodeChip, 2)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="hint">ICM EV는 핸드 시작 시점 대비 상금 풀 지분 변화(%p), Chip EV는 칩 변화(bb)입니다. 블라인드와 앤티 투입분이 포함됩니다.</p>
    </div>
  );
}
