// 핸드 뷰와 포스트플랍 뷰가 함께 쓰는 "내 핸드 / 내 포지션" 선택기.

import { classLabel, NUM_CLASSES } from '../engine/cards';

export function HandPicker({ hand, onHand }: { hand: number; onHand: (h: number) => void }) {
  return (
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
  );
}

export function SeatPicker({ names, seat, onSeat }: { names: string[]; seat: number; onSeat: (s: number) => void }) {
  return (
    <div className="seat-picker" role="radiogroup" aria-label="포지션 선택">
      <p className="eyebrow">포지션</p>
      <div className="seg">
        {names.map((name, s) => (
          <button type="button" role="radio" key={s} aria-checked={seat === s} className={seat === s ? 'on' : ''} onClick={() => onSeat(s)}>{name}</button>
        ))}
      </div>
    </div>
  );
}
