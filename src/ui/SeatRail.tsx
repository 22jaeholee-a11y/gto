import type { LightNode, LightTree } from '../worker/protocol';
import { actionColor, bb } from './format';
import { foldThrough, label, raiseRank, type TrailStep } from './spot';

interface Props {
  tree: LightTree;
  path: number[];
  node: LightNode;
  trail: TrailStep[];
  onPath: (p: number[]) => void;
}

export function SeatRail({ tree, path, node, trail, onPath }: Props) {
  const acting = node.kind === 'decision' ? node.player : -1;
  return (
    <ol className="rail" aria-label="좌석">
      {tree.seatNames.map((name, seat) => {
        const steps = trail.filter((s) => s.node.player === seat);
        const last = steps[steps.length - 1];
        const target = seat === acting ? null : foldThrough(tree, path, seat);
        const folded = node.folded[seat];
        const allin = node.allin[seat];
        const cls = ['seat', seat === acting && 'acting', folded && 'folded', allin && 'allin', target && 'reachable'].filter(Boolean).join(' ');
        const content = (
          <>
            <span className="seat-name">{name}</span>
            <span className="seat-stack">{bb(tree.config.stacks[seat])}<small>bb</small></span>
            <span className="seat-bet">{node.contrib[seat] > 0 ? `${bb(node.contrib[seat])} 투입` : ' '}</span>
            <span className="seat-act" style={last ? { color: actionColor(last.node.actions[last.action].type, raiseRank(last.node, last.action)) } : undefined}>
              {seat === acting ? '액션 차례' : last ? label(last.node.actions[last.action], last.node) : folded ? 'Fold' : ' '}
            </span>
          </>
        );
        return (
          <li key={name} className={cls}>
            {target ? (
              <button type="button" onClick={() => onPath(target)} title={`${name}까지 폴드로 이동`}>{content}</button>
            ) : (
              <div>{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
