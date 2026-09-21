import { useState } from 'react';
import { cardText, SUIT_SYMBOLS } from '../engine/postflop/combos';

const RANKS = 'AKQJT98765432';

interface Props {
  /** 골라야 하는 장수 */
  need: number;
  /** 고를 수 없는 카드 */
  dead: number[];
  onPick: (cards: number[]) => void;
}

export function CardPicker({ need, dead, onPick }: Props) {
  const [picked, setPicked] = useState<number[]>([]);
  const blocked = new Set([...dead, ...picked]);

  const toggle = (c: number) => {
    if (picked.includes(c)) { setPicked(picked.filter((x) => x !== c)); return; }
    if (picked.length >= need) return;
    const next = [...picked, c];
    setPicked(next);
    if (next.length === need) { onPick(next); setPicked([]); }
  };

  return (
    <div className="card-picker">
      <p className="eyebrow">카드 {need}장 선택 ({picked.map(cardText).join(' ') || '없음'})</p>
      <div className="card-grid">
        {Array.from({ length: 4 }, (_, suit) => (
          <div className="card-row" key={suit}>
            {Array.from({ length: 13 }, (_, i) => {
              const rank = 12 - i; // A부터
              const c = rank * 4 + suit;
              const off = blocked.has(c) && !picked.includes(c);
              return (
                <button type="button" key={c} className={`pick s${suit}${picked.includes(c) ? ' on' : ''}`}
                  disabled={off} onClick={() => toggle(c)} aria-label={cardText(c)}>
                  {RANKS[i]}<span className="suit">{SUIT_SYMBOLS[suit]}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
