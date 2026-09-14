import { cardRank, cardSuit, SUIT_SYMBOLS } from '../../engine/postflop/combos';

const SUIT_NAMES = ['클럽', '다이아몬드', '하트', '스페이드'];

export function PlayingCard({ card, size = 'md' }: { card: number | null; size?: 'sm' | 'md' | 'lg' }) {
  if (card === null) return <span className={`pcard back ${size}`} aria-label="뒷면 카드" />;
  const suit = cardSuit(card);
  const rank = cardRank(card);
  return (
    <span className={`pcard ${size} suit-${suit}`} aria-label={`${SUIT_NAMES[suit]} ${rank}`}>
      <span className="pcard-rank">{rank === 'T' ? '10' : rank}</span>
      <span className="pcard-suit">{SUIT_SYMBOLS[suit]}</span>
    </span>
  );
}

export function EmptySlot({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`pcard empty ${size}`} aria-hidden />;
}
