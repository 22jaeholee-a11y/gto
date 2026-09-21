import { useMemo } from 'react';
import { classLabel, NUM_CLASSES } from '../engine/cards';
import type { SolveResult } from '../engine/solver';
import type { LightTree } from '../worker/protocol';
import { SituationList, type PostflopEntry } from './SituationList';
import { MAX_ROWS, enumerateSituations } from './situations';

interface Props {
  tree: LightTree;
  result: SolveResult;
  hand: number;
  onHand: (h: number) => void;
  seat: number;
  onSeat: (s: number) => void;
  expanded: number | null;
  onExpand: (i: number | null) => void;
  onOpenPostflop: (entry: PostflopEntry) => void;
  showAll: boolean;
  onShowAll: (v: boolean) => void;
}

export function HandView({ tree, result, hand, onHand, seat, onSeat, expanded, onExpand, onOpenPostflop, showAll, onShowAll }: Props) {
  const all = useMemo(() => enumerateSituations(tree, result, seat, hand), [tree, result, seat, hand]);
  const shown = showAll ? all : all.slice(0, MAX_ROWS);

  return (
    <section className="hand-view">
      <div className="hand-picker">
        <p className="eyebrow">핸드</p>
        <div className="mini-grid" role="grid" aria-label="핸드 선택">
          {Array.from({ length: NUM_CLASSES }, (_, h) => (
            <button type="button" role="gridcell" key={h} className={`mini-cell${hand === h ? ' sel' : ''}`}
              onClick={() => onHand(h)} aria-label={classLabel(h)} aria-selected={hand === h}>
              {classLabel(h)}
            </button>
          ))}
        </div>
      </div>

      <div className="seat-picker" role="radiogroup" aria-label="포지션 선택">
        <p className="eyebrow">포지션</p>
        <div className="seg">
          {tree.seatNames.map((name, s) => (
            <button type="button" role="radio" key={s} aria-checked={seat === s} className={seat === s ? 'on' : ''} onClick={() => onSeat(s)}>{name}</button>
          ))}
        </div>
      </div>

      <div className="hand-head">
        <h1><b>{classLabel(hand)}</b> · {tree.seatNames[seat]}</h1>
        <p className="hint">
          {tree.config.mode === 'icm' ? 'ICM EV' : 'Chip EV'} 기준으로 가장 높은 액션에 ▸를 붙입니다.
          2등과의 차이가 솔버의 혼합 온도({tree.config.smoothing ?? 0}bb) 이내면 <b>혼합</b>으로 표시합니다.
        </p>
      </div>

      <SituationList tree={tree} result={result} hand={hand} hero={seat} situations={shown}
        expanded={expanded} onExpand={onExpand} onOpenPostflop={onOpenPostflop} />

      {all.length > MAX_ROWS && (
        <button type="button" className="crumb" onClick={() => onShowAll(!showAll)}>
          {showAll ? '접기' : `더 보기 (${all.length - MAX_ROWS}개)`}
        </button>
      )}
    </section>
  );
}
