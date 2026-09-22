import { classLabel } from '../engine/cards';
import type { SolveResult } from '../engine/solver';
import { explainPreflop } from '../engine/training/coach';
import type { LightDecision, LightTree } from '../worker/protocol';
import { buildPreflopCoachInput } from './coachinput';
import { HandDetail } from './HandDetail';
import { actionColor, pct, signed } from './format';
import { actionTotals, label, playerReach, raiseRank, walkPath } from './spot';
import type { Situation } from './situations';

/** 포스트플랍 탐색기의 진입점이 되는 헤즈업 플랍 종료 노드 하나. */
export interface PostflopEntry {
  /** 종료 노드 id */
  terminalId: number;
  label: string;
  /** 상황 목록에서 열었을 때의 출처. 포스트플랍 뷰에서 바로 고른 라인에는 없다. */
  situation?: Situation;
}

/**
 * 상황에서 히어로가 고를 수 있는 각 액션 이후로 갈 수 있는 모든 경로를 따라가며,
 * 히어로가 참여하는 헤즈업 플랍 종료 노드를 전부 모은다. 한 상황이 여러 개의
 * 서로 다른 헤즈업 플랍(예: BB가 콜한 라인, SB가 콜하고 BB는 폴드한 라인)으로
 * 갈라질 수 있으므로 하나만 고르지 않고 전부 나열한다.
 */
export function postflopEntries(tree: LightTree, situation: Situation, hero: number): PostflopEntry[] {
  const out: PostflopEntry[] = [];
  // 트리는 순환이 없는 진짜 트리라 종료 노드가 두 번 방문될 수는 없다.
  // 그래도 혹시 모를 재방문을 막기 위한 안전장치로만 둔다.
  const seen = new Set<number>();

  const walk = (id: number, steps: string[], depth: number): void => {
    // 재귀 폭주를 막기 위한 안전장치일 뿐, 실제 프리플랍 트리는 이보다 훨씬 얕아서
    // 정상적인 라인을 이 한도가 잘라내는 일은 없어야 한다.
    if (depth > 32) return;
    const node = tree.nodes[id];
    if (node.kind === 'terminal') {
      if (node.tType !== 'flop') return;
      if (node.participants.length !== 2) return;
      if (!node.participants.includes(hero)) return;
      if (seen.has(node.id)) return;
      seen.add(node.id);
      const names = node.participants.map((s) => tree.seatNames[s]).join(' vs ');
      out.push({ situation, terminalId: node.id, label: `${steps.join(' → ')} · 플랍 (${names})` });
      return;
    }
    for (const a of node.actions) walk(a.child, [...steps, actionText(tree, node, a.child)], depth + 1);
  };

  for (const opt of situation.options) {
    const a = situation.node.actions[opt.index];
    walk(a.child, [`내 ${opt.label}`], 1);
  }
  return out;
}

function actionText(tree: LightTree, node: LightDecision, child: number): string {
  const a = node.actions.find((x) => x.child === child);
  return a ? `${tree.seatNames[node.player]} ${label(a, node)}` : tree.seatNames[node.player];
}

interface Props {
  tree: LightTree;
  result: SolveResult;
  hand: number;
  hero: number;
  situations: Situation[];
  expanded: number | null;
  onExpand: (i: number | null) => void;
  onOpenPostflop: (entry: PostflopEntry) => void;
}

export function SituationList({ tree, result, hand, hero, situations, expanded, onExpand, onOpenPostflop }: Props) {
  const primary = tree.config.mode;
  const unit = primary === 'icm' ? '%p' : 'bb';
  const digits = primary === 'icm' ? 3 : 2;

  if (situations.length === 0) {
    return <p className="hint">{classLabel(hand)}로 {tree.seatNames[hero]}에서 자주 마주치는 상황이 없습니다. 다른 핸드나 포지션을 골라보세요.</p>;
  }

  return (
    <ol className="situations">
      {situations.map((s, i) => {
        const bestOpt = s.options[s.best];
        const ev = primary === 'icm' ? bestOpt.evIcm : bestOpt.evChip;
        const entries = expanded === i ? postflopEntries(tree, s, hero) : [];
        return (
          <li key={i} className={expanded === i ? 'situation open' : 'situation'}>
            <button type="button" className="situation-row" onClick={() => onExpand(expanded === i ? null : i)}>
              <span className="situation-label">{s.label}</span>
              <span className="situation-reach">{pct(s.reach, 0)}</span>
              <span className="situation-best" style={{ ['--c' as string]: actionColor(s.node.actions[s.best].type, raiseRank(s.node, s.best)) }}>
                ▸ {bestOpt.label}
              </span>
              <span className="situation-freq">{pct(bestOpt.freq)}</span>
              <span className="situation-ev">{signed(ev, digits)}{unit}</span>
              {s.mixed && <span className="badge mixed">혼합</span>}
              {s.rare && <span className="badge rare" title="균형 전략이 거의 쓰지 않는 라인이라 EV가 불안정합니다">희소</span>}
            </button>
            {expanded === i && (
              <div className="situation-detail">
                <HandDetail result={result} node={s.node} hand={hand} reach={s.reach} mode={primary} onClose={() => onExpand(null)} />
                <RangeSummary tree={tree} result={result} situation={s} />
                <Coach tree={tree} result={result} situation={s} hand={hand} />
                {entries.length > 0 ? (
                  <div className="postflop-entries">
                    <p className="eyebrow">포스트플랍</p>
                    {entries.map((e) => (
                      <button type="button" key={e.terminalId} className="crumb" onClick={() => onOpenPostflop(e)}>{e.label}</button>
                    ))}
                  </div>
                ) : (
                  <p className="hint">이 상황에서 헤즈업으로 플랍에 가는 라인이 없습니다. 3인 이상 플랍은 솔버가 지원하지 않아 프리플랍 EV(EQR 근사)까지만 제공합니다.</p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 이 노드에서 히어로 레인지 전체가 각 액션을 얼마나 쓰는지. */
function RangeSummary({ tree, result, situation }: { tree: LightTree; result: SolveResult; situation: Situation }) {
  const { trail } = walkPath(tree, situation.path);
  const reach = playerReach(result, trail, situation.node.player);
  const totals = actionTotals(result, situation.node, reach);
  return (
    <div className="range-summary">
      <p className="eyebrow">레인지 요약 · {tree.seatNames[situation.node.player]}</p>
      {situation.node.actions.map((a, i) => (
        <div className="sum-row" key={i}>
          <span className="swatch" style={{ background: actionColor(a.type, raiseRank(situation.node, i)) }} />
          <span className="sum-label">{label(a, situation.node)}</span>
          <span className="sum-bar"><span style={{ width: pct(totals.freq[i]), background: actionColor(a.type, raiseRank(situation.node, i)) }} /></span>
          <span className="sum-val">{pct(totals.freq[i])}</span>
          <span className="sum-combos">{totals.combos[i].toFixed(1)}c</span>
        </div>
      ))}
    </div>
  );
}

/** "왜 이 판단인가" — 트레이닝 모드와 같은 규칙 엔진(explainPreflop)을 그대로 쓴다. */
function Coach({ tree, result, situation, hand }: { tree: LightTree; result: SolveResult; situation: Situation; hand: number }) {
  const { trail } = walkPath(tree, situation.path);
  const input = buildPreflopCoachInput(tree, result, trail, situation.node, hand, situation.best, situation.best);
  const ex = explainPreflop(input);
  return (
    <div className="coach">
      <p className="eyebrow">코치 해설</p>
      <p className="coach-headline">{ex.headline}</p>
      {ex.reasons.map((r, i) => <p key={i} className="coach-reason">{r}</p>)}
      {ex.tags.length > 0 && (
        <p className="coach-tags">{ex.tags.map((t) => <span className="badge" key={t}>{t}</span>)}</p>
      )}
    </div>
  );
}
