import { useEffect, useMemo, useRef, useState } from 'react';
import { classLabel } from '../engine/cards';
import { DEFAULT_CONFIG, type SolverConfig } from '../engine/config';
import { ConfigPanel } from './ConfigPanel';
import { HandDetail } from './HandDetail';
import { HandGrid, type GridView } from './HandGrid';
import { HandView } from './HandView';
import { PostflopView } from './PostflopView';
import { SeatRail } from './SeatRail';
import type { PostflopEntry } from './SituationList';
import { actionColor, pct } from './format';
import { PostflopClient } from './training/clients';
import { actionTotals, label, playerReach, raiseRank, rareSteps, walkPath } from './spot';
import { useSolver } from './useSolver';
import { TrainingView } from './training/TrainingView';

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

type Mode = 'solver' | 'training';
const MODE_KEY = 'icm-preflop-lab.mode';

function ModeTabs({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  return (
    <nav className="mode-tabs" aria-label="모드">
      <button type="button" className={mode === 'solver' ? 'on' : ''} aria-current={mode === 'solver'} onClick={() => onMode('solver')}>솔버</button>
      <button type="button" className={mode === 'training' ? 'on' : ''} aria-current={mode === 'training'} onClick={() => onMode('training')}>트레이닝</button>
    </nav>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden>♠</span>
      <span className="brand-name">ICM Preflop Lab</span>
    </div>
  );
}

export function App() {
  const [mode, setModeState] = useState<Mode>(() => {
    try { return (localStorage.getItem(MODE_KEY) as Mode) || 'solver'; } catch { return 'solver'; }
  });
  const [trainingMounted, setTrainingMounted] = useState(mode === 'training');
  const setMode = (m: Mode) => {
    setModeState(m);
    if (m === 'training') setTrainingMounted(true);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  };
  const tabs = <ModeTabs mode={mode} onMode={setMode} />;
  return (
    <>
      <div hidden={mode !== 'solver'}>
        <SolverApp tabs={tabs} />
      </div>
      {trainingMounted && (
        <div hidden={mode !== 'training'} className="app-training">
          <header className="topbar">
            <Brand />
            {tabs}
          </header>
          <TrainingView />
        </div>
      )}
    </>
  );
}

function SolverApp({ tabs }: { tabs: React.ReactNode }) {
  const [config, setConfig] = useState<SolverConfig>(loadConfig);
  const { state: solve, start, stop } = useSolver();
  const [path, setPath] = useState<number[]>([]);
  const [view, setView] = useState<GridView>('strategy');
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  /** which panel is visible on narrow screens */
  const [tab, setTab] = useState<'setup' | 'chart'>('setup');
  const [boardView, setBoardView] = useState<'range' | 'hand'>('range');
  const [handSeat, setHandSeat] = useState(0);
  const [handClass, setHandClass] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [postflop, setPostflop] = useState<PostflopEntry | null>(null);
  const pfClient = useRef<PostflopClient | null>(null);
  const getClient = () => (pfClient.current ??= new PostflopClient());
  useEffect(() => () => pfClient.current?.dispose(), []);

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
  const rare = useMemo(() => (result && spot ? rareSteps(result, spot.trail) : []), [result, spot]);
  const totals = useMemo(() => (result && decision && reach ? actionTotals(result, decision, reach) : null), [result, decision, reach]);

  const onStart = () => {
    setPath([]);
    setSelected(null);
    setTab('chart');
    setExpanded(null);
    setShowAll(false);
    setHandSeat((s) => Math.min(s, config.stacks.length - 1));
    setPostflop(null);
    start(config);
  };

  const focusHand = hover ?? selected;
  const go = (p: number[]) => { setPath(p); setHover(null); };

  return (
    <div className="app" data-tab={tab}>
      <header className="topbar">
        <Brand />
        {tabs}
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
        {tree && (
          <div className="seg board-view" role="radiogroup" aria-label="보기 전환">
            <button type="button" role="radio" aria-checked={boardView === 'range'} className={boardView === 'range' ? 'on' : ''} onClick={() => setBoardView('range')}>레인지</button>
            <button type="button" role="radio" aria-checked={boardView === 'hand'} className={boardView === 'hand' ? 'on' : ''} onClick={() => setBoardView('hand')}>핸드</button>
          </div>
        )}
        {tree && spot && boardView === 'range' && (
          <>
            <SeatRail tree={tree} path={path} node={spot.node} trail={spot.trail} onPath={go} />

            <div className="breadcrumbs" aria-label="액션 경로">
              <button type="button" className="crumb" onClick={() => go([])} disabled={path.length === 0}>처음</button>
              {spot.trail.map((st, i) => (
                <button type="button" key={i} className="crumb" onClick={() => go(path.slice(0, i + 1))}>
                  <b>{tree.seatNames[st.node.player]}</b> {label(st.node.actions[st.action], st.node)}
                </button>
              ))}
              {path.length > 0 && (
                <button type="button" className="crumb back" onClick={() => go(path.slice(0, -1))}>한 단계 뒤로</button>
              )}
            </div>

            {rare.length > 0 && (
              <p className="rare-warning" role="note">
                <b>희소 라인</b>
                {rare.map((r) => `${tree.seatNames[r.seat]} ${r.label} (${(r.freq * 100).toFixed(2)}%)`).join(', ')}
                {' '}— 균형 전략에서 거의 선택되지 않는 액션을 거친 지점입니다. 이후 전략과 EV는 수렴이 불안정하니 참고용으로만 보세요.
              </p>
            )}

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
                    <button type="button" key={i} className="action-btn" onClick={() => go([...path, i])}
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
                      <HandDetail result={result} node={decision} hand={focusHand} reach={reach[focusHand]} mode={tree.config.mode} onClose={() => { setSelected(null); setHover(null); }} />
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
        {tree && result && boardView === 'hand' && (
          <HandView
            tree={tree} result={result}
            hand={handClass} onHand={(h) => { setHandClass(h); setExpanded(null); setPostflop(null); }}
            seat={handSeat} onSeat={(s) => { setHandSeat(s); setExpanded(null); setPostflop(null); }}
            expanded={expanded} onExpand={setExpanded}
            onOpenPostflop={(e: PostflopEntry) => setPostflop(e)}
            showAll={showAll} onShowAll={setShowAll}
          />
        )}
        {tree && !result && boardView === 'hand' && (
          <p className="hint">솔브가 끝나면 상황 목록이 표시됩니다.</p>
        )}
        {tree && result && boardView === 'hand' && postflop && (
          <PostflopView tree={tree} result={result} entry={postflop} hand={handClass} hero={handSeat}
            client={getClient()} onClose={() => setPostflop(null)} />
        )}
        {focusHand !== null && <span className="sr-only" aria-live="polite">{classLabel(focusHand)}</span>}
      </main>

      <nav className="tabbar" aria-label="화면 전환">
        <button type="button" className={tab === 'setup' ? 'on' : ''} aria-current={tab === 'setup'} onClick={() => setTab('setup')}>설정</button>
        <button type="button" className={tab === 'chart' ? 'on' : ''} aria-current={tab === 'chart'} onClick={() => setTab('chart')}>
          차트
          {(solve.status === 'building' || solve.status === 'solving') && <small>{solve.total ? Math.round((solve.iteration / solve.total) * 100) : 0}%</small>}
        </button>
      </nav>
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
