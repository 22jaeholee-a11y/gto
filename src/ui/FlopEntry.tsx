// 레인지 뷰에서 프리플랍 액션을 끝까지 따라가 헤즈업 플랍 지점에 닿았을 때,
// 그 자리에서 보드를 고르고 포스트플랍 솔브로 넘어가는 블록.
// 라인은 지금까지 밟아온 경로 그대로라서 따로 고를 필요가 없다.

import { useMemo, useState } from 'react';
import type { SolveResult } from '../engine/solver';
import type { LightTerminal, LightTree } from '../worker/protocol';
import { HandPicker } from './pickers';
import { PostflopView } from './PostflopView';
import { pathLabel } from './situations';
import type { TrailStep } from './spot';
import type { PostflopClient } from './training/clients';

interface Props {
  tree: LightTree;
  result: SolveResult;
  /** 참가자가 둘인 플랍 종료 노드 */
  terminal: LightTerminal;
  /** 루트에서 이 종료 노드까지 밟아온 경로 */
  trail: TrailStep[];
  hand: number;
  onHand: (h: number) => void;
  client: PostflopClient;
}

export function FlopEntry({ tree, result, terminal, trail, hand, onHand, client }: Props) {
  const [picked, setPicked] = useState<number | null>(null);
  /** 올리면 탐색기를 다시 마운트해 보드 선택부터 새로 시작한다 */
  const [reset, setReset] = useState(0);
  // 다른 플랍 지점으로 옮겨가면 이전에 고른 자리가 더 이상 참가자가 아닐 수 있다
  const hero = picked !== null && terminal.participants.includes(picked) ? picked : terminal.participants[0];

  // PostflopView가 이 객체로 탐색기를 만들므로 렌더마다 새로 만들면 안 된다
  const entry = useMemo(() => ({
    terminalId: terminal.id,
    label: `${pathLabel(tree, trail, hero)} · 플랍 (${terminal.participants.map((s) => tree.seatNames[s]).join(' vs ')})`,
  }), [tree, trail, terminal, hero]);

  return (
    <div className="flop-entry">
      <div className="flop-entry-head">
        <p className="eyebrow">내 자리</p>
        <div className="seg small" role="radiogroup" aria-label="내 자리 선택">
          {terminal.participants.map((s) => (
            <button type="button" role="radio" key={s} aria-checked={hero === s} className={hero === s ? 'on' : ''}
              onClick={() => setPicked(s)}>{tree.seatNames[s]}</button>
          ))}
        </div>
      </div>

      <HandPicker hand={hand} onHand={onHand} />

      <PostflopView key={`${terminal.id}:${hero}:${reset}`} tree={tree} result={result} entry={entry}
        hand={hand} hero={hero} client={client}
        closeLabel="보드 다시 고르기" onClose={() => setReset((n) => n + 1)} />
    </div>
  );
}
