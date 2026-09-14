import { useEffect, useMemo, useState } from 'react';
import { classLabel } from '../engine/cards';
import { DEFAULT_CONFIG, type SolverConfig } from '../engine/config';
import { ConfigPanel } from './ConfigPanel';
import { HandDetail } from './HandDetail';
import { HandGrid, type GridView } from './HandGrid';
import { SeatRail } from './SeatRail';
import { actionColor, pct } from './format';
import { actionTotals, label, playerReach, raiseRank, walkPath } from './spot';
import { useSolver } from './useSolver';

const STORAGE_KEY = 'icm-preflop-lab.config.v1';

function loadConfig(): SolverConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const c = JSON.parse(raw) as Partial<SolverConfig>;
      return { ...DEFAULT_CONFIG, ...c, sizing: { ...DEFAULT_CONFIG.sizing, ...c.sizing }, postflop: { ...DEFAULT_CONFIG.postflop, ...c.postflop } };
    }
  } catch { /* ignore */ }
  return DEFAULT_CONFIG;
}

export function App() {
  const [config, setConfig] = useState<SolverConfig>(loadConfig);
  const { state: solve, start, stop } = useSolver();
  const [path, setPath] = useState<number[]>([]);
  const [view, setView] = useState<GridView>('strategy');
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* ignore */ }
  }, [config]);

  const tree = solve.tree;
  const result = solve.status === 'done' ? solve.result : null;
  const solvedConfig = tree?.config;

  const spot = useMemo(() => (tree ? walkPath(tree, path) : null), [tree, path]);
  const node = spot?.node;
  const decision = node?.kind === 'decision' ? node : null;
  const reach = useMemo(
    () => (result && spot && decision ? playerReach(result, spot.trail, decision.player) : null),
    [result, spot, decision],
  );
  const totals = useMemo(() => (result && decision && reach ? actionTotals(result, decision, reach) : null), [result, decision, reach]);

  const onStart = () => {
    setPath([]);
    setSelected(null);
    start(config);
  };

  const focusHand = hover ?? selected;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>♠</span>
          <span className="brand-name">ICM Preflop Lab</span>
        </div>
        {solvedConfig && (
          <p className="spot-summary">
            {solvedConfig.stacks.length}인 · 앤티 {solvedConfig.ante}bb · {solvedConfig.mode === 'icm' ? 'ICM' : 'Chip EV'}
            {' · '}평균 스택 {(solvedConfig.stacks.reduce((a, b) => a + b, 0) / solvedConfig.stacks.length).toFixed(1)}bb
          </p>
        )}
      </header>

      <ConfigPanel config={config} onChange={setConfig} solve={solve} onStart={onStart} onStop={stop} />

      <main className="board">
        {!tree && <EmptyBoard />}
        {tree && spot && (
          <>
            <SeatRail tree={tree} path={path} node={spot.node} trail={spot.trail} onPath={setPath} />

            <div className="breadcrumbs" aria-label="액션 경로">
              <button type="button" className="crumb" onClick={() => setPath([])} disabled={path.length === 0}>처음</button>
              {spot.trail.map((st, i) => (
                <button type="button" key={i} className="crumb" onClick={() => setPath(path.slice(0, i + 1))}>
                  <b>{tree.seatNames[st.node.player]}</b> {label(st.node.actions[st.action], st.node)}
                </button>
              ))}
              {path.length > 0 && (
                <button type="button" className="crumb back" onClick={() => setPath(path.slice(0, -1))}>한 단계 뒤로</button>
              )}
            </div>

            {decision && (
              <section className="decision">
                <div className="decision-head">
                  <h1>
                    <span className="seat-tag">{tree.seatNames[decision.player]}</span>
                    <span className="decision-meta">팟 {decision.pot.toFixed(1)}bb · 콜 금액 {Math.max(0, decision.bet - decision.contrib[decision.player]).toFixed(1)}bb · 남은 스택 {decision.behind[decision.player].toFixed(1)}bb</span>
                  </h1>
                  <div className="seg small" role="radiogroup" aria-label="차트 보기">
                    {(['strategy', 'evIcm', 'evChip'] as GridView[]).map((v) => (
                      <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
                        {v === 'strategy' ? '전략' : v === 'evIcm' ? 'ICM EV' : 'Chip EV'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="actions">
                  {decision.actions.map((a, i) => (
                    <button type="button" key={i} className="action-btn" onClick={() => setPath([...path, i])}
                      style={{ ['--c' as string]: actionColor(a.type, raiseRank(decision, i)) }}>
                      <span className="action-name">{label(a, decision)}</span>
                      <span className="action-freq">{totals ? pct(totals.freq[i]) : '…'}</span>
                    </button>
                  ))}
                </div>

                <div className="chart-area">
                  {result && reach ? (
                    <HandGrid result={result} node={decision} reach={reach} view={view} selected={selected}
                      onHover={setHover} onSelect={(h) => setSelected(h === selected ? null : h)} />
                  ) : (
                    <div className="grid-placeholder">
                      <p>{solve.status === 'solving' ? `솔브 중… ${solve.iteration}/${solve.total}` : '솔브가 끝나면 차트가 표시됩니다.'}</p>
                    </div>
                  )}
                  <div className="side">
                    {result && reach && focusHand !== null ? (
                      <HandDetail result={result} node={decision} hand={focusHand} reach={reach[focusHand]} mode={tree.config.mode} />
                    ) : (
                      <div className="detail empty">
                        <p className="eyebrow">핸드 상세</p>
                        <p>차트의 핸드에 마우스를 올리거나 클릭하면 액션별 빈도와 EV가 표시됩니다.</p>
                      </div>
                    )}
                    {result && totals && (
                      <div className="range-summary">
                        <p className="eyebrow">레인지 요약 · {tree.seatNames[decision.player]}</p>
                        {decision.actions.map((a, i) => (
                          <div className="sum-row" key={i}>
                            <span className="swatch" style={{ background: actionColor(a.type, raiseRank(decision, i)) }} />
                            <span className="sum-label">{label(a, decision)}</span>
                            <span className="sum-bar"><span style={{ width: pct(totals.freq[i]), background: actionColor(a.type, raiseRank(decision, i)) }} /></span>
                            <span className="sum-val">{pct(totals.freq[i])}</span>
                            <span className="sum-combos">{totals.combos[i].toFixed(1)}c</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}

            {node && node.kind === 'terminal' && (
              <section className="terminal">
                <p className="eyebrow">핸드 종료 지점</p>
                <h1>
                  {node.tType === 'fold' && `${tree.seatNames[node.participants[0]]} 팟 획득 (${node.pot.toFixed(1)}bb)`}
                  {node.tType === 'showdown' && `올인 쇼다운 · ${node.participants.map((s) => tree.seatNames[s]).join(' vs ')}`}
                  {node.tType === 'flop' && `플랍 진행 · ${node.participants.map((s) => tree.seatNames[s]).join(', ')}`}
                </h1>
                <p className="hint">
                  {node.tType === 'flop'
                    ? `팟 ${node.pot.toFixed(1)}bb. 플랍 이후 EV는 포지션·SPR 기반 에퀴티 실현(EQR) 근사로 계산했습니다.`
                    : node.tType === 'showdown'
                      ? `팟 ${node.pot.toFixed(1)}bb. ${node.participants.length === 2 ? '프리플랍 에퀴티 테이블로 정확히 계산했습니다.' : '3인 올인은 1:1 에퀴티 기반 근사로 계산했습니다.'}`
                      : '다른 플레이어가 모두 폴드했습니다.'}
                </p>
              </section>
            )}
          </>
        )}
        {focusHand !== null && <span className="sr-only" aria-live="polite">{classLabel(focusHand)}</span>}
      </main>
    </div>
  );
}

function EmptyBoard() {
  return (
    <section className="empty-board">
      <p className="eyebrow">시작하기</p>
      <h1>스팟을 설정하고 솔브하세요</h1>
      <ol>
        <li>왼쪽에서 인원, 좌석별 스택, 앤티를 입력합니다.</li>
        <li>상금 구조를 고르면 ICM으로 칩 가치를 상금 지분으로 환산합니다.</li>
        <li>솔브가 끝나면 좌석 레일에서 좌석을 눌러 원하는 스팟으로 이동합니다.</li>
      </ol>
    </section>
  );
}
