import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { classLabel, NUM_CLASSES } from '../engine/cards';
import { CLASS_COMBOS, COMBO_C1, COMBO_C2, COMBO_CLASS, NC, cardText, comboText } from '../engine/postflop/combos';
import { PostflopExplorer } from '../engine/postflop/explore';
import { preflopExit } from '../engine/postflop/spot';
import { postflopActionLabel, type PDecision } from '../engine/postflop/tree';
import type { SolveResult } from '../engine/solver';
import { buildRangeReview } from '../engine/training/hand';
import type { LightTree } from '../worker/protocol';
import { CardPicker } from './CardPicker';
import type { PostflopClient } from './training/clients';
import { RangePanel, type RangeTab } from './training/RangePanel';
import { pct, signed } from './format';
import { playerReach, walkPath } from './spot';
import type { PostflopEntry } from './SituationList';

interface Props {
  tree: LightTree;
  result: SolveResult;
  entry: PostflopEntry;
  hand: number;
  hero: number;
  client: PostflopClient;
  onClose: () => void;
}

export function PostflopView({ tree, result, entry, hand, hero, client, onClose }: Props) {
  const explorer = useMemo(() => {
    const terminal = tree.nodes[entry.terminalId];
    if (terminal.kind !== 'terminal') throw new Error('플랍 종료 노드가 아닙니다');
    const reachBySeat: Float64Array[] = tree.config.stacks.map(() => new Float64Array(NUM_CLASSES));
    for (const seat of terminal.participants) {
      // 종료 노드까지의 경로를 되짚어 좌석별 reach를 구한다
      reachBySeat[seat] = reachTo(tree, result, entry.terminalId, seat);
    }
    const exit = preflopExit({
      config: tree.config,
      participants: terminal.participants,
      pot: terminal.pot,
      contrib: terminal.contrib,
      reachBySeat,
    });
    return new PostflopExplorer(exit, hero, client);
  }, [tree, result, entry, hero, client]);

  const state = useSyncExternalStore(
    (fn) => explorer.subscribe(fn),
    () => explorer.state,
  );

  const combos = useMemo(() => CLASS_COMBOS[hand], [hand]);
  const [combo, setCombo] = useState(combos[0]);
  useEffect(() => { setCombo(combos[0]); }, [combos]);
  useEffect(() => { void explorer.setHeroCombo(combo); }, [explorer, combo]);

  const primary = tree.config.mode;
  const unit = primary === 'icm' ? '%p' : 'bb';
  const digits = primary === 'icm' ? 3 : 2;

  const node = state.tree && state.status === 'ready' ? state.tree.nodes[state.node] : null;
  const decision = node && node.kind === 'decision' ? (node as PDecision) : null;
  const idx = decision && state.result ? state.result.nodeIds.indexOf(decision.id) : -1;

  const rows = decision && idx >= 0 && state.result
    ? decision.actions.map((a, i) => ({
        i,
        label: postflopActionLabel(a, decision),
        freq: state.result!.strategy[idx][i * NC + combo],
        ev: (primary === 'icm' ? state.result!.evIcm : state.result!.evChip)[idx][i * NC + combo],
      }))
    : [];
  const best = rows.reduce((b, r) => (Number.isFinite(r.ev) && (b === null || r.ev > b.ev) ? r : b), null as (typeof rows)[number] | null);

  const heroIsActor = decision ? decision.player === explorer.heroPlayer : false;

  // 행동하는 플레이어의 레인지 전체를 13×13으로 집계한다 (트레이닝 리뷰와 같은 집계 함수)
  const [rangeTab, setRangeTab] = useState<RangeTab>('strategy');
  const rangeReview = useMemo(() => {
    if (!decision || idx < 0 || !state.result) return null;
    const res = state.result;
    const actorRange = state.ranges[decision.player];
    const dead = new Uint8Array(52);
    for (const c of state.board) dead[c] = 1;
    const live = (k: number) => !dead[COMBO_C1[k]] && !dead[COMBO_C2[k]];
    const capacity = new Float64Array(NUM_CLASSES);
    for (let k = 0; k < NC; k++) if (live(k)) capacity[COMBO_CLASS[k]] += 1;
    return buildRangeReview(
      decision.actions.map((a) => postflopActionLabel(a, decision)),
      COMBO_CLASS[combo], NC, (k) => COMBO_CLASS[k], () => 1,
      (k) => (live(k) ? actorRange[k] : 0),
      (k, a) => res.strategy[idx][a * NC + k],
      (k, a) => res.evIcm[idx][a * NC + k],
      (k, a) => res.evChip[idx][a * NC + k],
      (c) => capacity[c],
    );
  }, [decision, idx, state.result, state.ranges, state.board, combo]);

  return (
    <section className="postflop-view">
      <div className="decision-head">
        <h1>
          <span className="seat-tag">{classLabel(hand)}</span>
          <span className="decision-meta">
            {entry.label} · 보드 {state.board.map(cardText).join(' ') || '—'} · 팟 {state.pot.toFixed(1)}bb
          </span>
        </h1>
        <div className="postflop-tools">
          <label>
            수트{' '}
            <select value={combo} onChange={(e) => setCombo(Number(e.target.value))}>
              {combos.map((k) => (
                <option key={k} value={k} disabled={state.board.includes(COMBO_C1[k]) || state.board.includes(COMBO_C2[k])}>
                  {comboText(k)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="crumb" onClick={() => void explorer.undo()} disabled={!explorer.canUndo()}>한 단계 뒤로</button>
          <button type="button" className="crumb" onClick={onClose}>닫기</button>
        </div>
      </div>

      {state.error && <p className="rare-warning" role="alert">{state.error}</p>}

      {state.status === 'need-cards' && (
        <CardPicker need={state.needed} dead={explorer.deadCards()} onPick={(cards) => void explorer.setCards(cards)} />
      )}

      {state.status === 'solving' && (
        <p className="hint">솔브 중… {Math.round(state.progress * 100)}% (플랍 약 2~3초, 턴 약 4초)</p>
      )}

      {state.street === 'flop' && state.status === 'ready' && (
        <p className="hint">플랍 솔브는 턴·리버를 체크다운으로 가정한 근사입니다.</p>
      )}

      {decision && (
        <>
          <p className="eyebrow">
            {heroIsActor ? '내 차례' : '상대 차례'} · {decision.player === 0 ? 'OOP' : 'IP'} ·
            {' '}팟 {decision.pot.toFixed(1)}bb · 남은 스택 {decision.behind[decision.player].toFixed(1)}bb
          </p>
          <div className="actions">
            {rows.map((r) => (
              <button type="button" key={r.i} className={`action-btn${best === r ? ' best' : ''}`} onClick={() => void explorer.act(r.i)}>
                <span className="action-name">{r.label}</span>
                <span className="action-freq">{pct(r.freq)}</span>
                <span className="action-ev">{signed(r.ev, digits)}{unit}</span>
              </button>
            ))}
          </div>
          {!heroIsActor && <p className="hint">상대 차례입니다. 액션을 고르면 그 액션으로 상대 레인지가 좁혀집니다. 표의 빈도와 EV는 여전히 내 핸드({comboText(combo)}) 기준입니다.</p>}
          {rangeReview && (
            <RangePanel range={rangeReview} primary={primary} chosen={best ? best.i : -1} tab={rangeTab} onTab={setRangeTab} />
          )}
        </>
      )}

      {state.status === 'done' && state.ending && (
        <p className="eyebrow">
          {state.ending.kind === 'fold'
            ? `${tree.seatNames[explorer.seatOf(state.ending.winner)]} 팟 획득 (${state.pot.toFixed(1)}bb)`
            : state.ending.runout
              ? `양쪽 올인 · 남은 보드는 런아웃입니다 · 팟 ${state.pot.toFixed(1)}bb`
              : `리버 쇼다운 · 팟 ${state.pot.toFixed(1)}bb`}
        </p>
      )}
    </section>
  );
}

/** 루트에서 종료 노드까지의 유일한 경로를 되짚어 좌석의 클래스별 reach를 구한다. */
function reachTo(tree: LightTree, result: SolveResult, terminalId: number, seat: number): Float64Array {
  const path: number[] = [];
  let id = terminalId;
  while (id !== 0) {
    const nd = tree.nodes[id];
    path.unshift(nd.parentAction);
    id = nd.parent;
  }
  const { trail } = walkPath(tree, path);
  return playerReach(result, trail, seat);
}
