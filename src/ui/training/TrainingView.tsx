import { useEffect, useRef, useState } from 'react';
import { DEFAULT_TRAINING, describeScenario, mulberry32, type TrainingSettings } from '../../engine/training/scenario';
import { ScenarioBar } from './ScenarioBar';
import { InfoTip } from './InfoTip';

const CHIP_OPTIONS = [
  { label: '상금', full: '상금 기준 (ICM)', value: 0 },
  { label: '섞기', full: '상금 기준과 칩 기준 섞기', value: 0.15 },
  { label: '칩', full: '칩 기준 (Chip EV)', value: 1 },
];

/** nearest toggle option for a stored share (older settings used free percentages) */
function chipOption(share: number): number {
  return CHIP_OPTIONS.reduce((best, o) => (Math.abs(o.value - share) < Math.abs(best - share) ? o.value : best), CHIP_OPTIONS[0].value);
}
import { TrainingHand, type HandView } from '../../engine/training/hand';
import type { HandSummary } from '../../engine/training/coach';
import { PostflopClient } from './clients';
import { EmptySlot, PlayingCard } from './PlayingCard';
import { ScenarioPool, type PoolStatus } from './pool';
import { ReviewCard } from './ReviewCard';
import './training.css';
import { accuracy, addReview, EMPTY_STATS, loadStats, saveStats, VERDICT_LABEL, type SessionStats } from './stats';

const SETTINGS_KEY = 'icm-preflop-lab.training-settings.v1';
const STREET_LABEL = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' } as const;
const MOBILE = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

function loadSettings(): TrainingSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_TRAINING, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_TRAINING;
}

function actionKind(label: string): string {
  const w = label.split(' ')[0].toLowerCase();
  if (w === 'all-in') return 'allin';
  if (w === 'limp' || w === 'check' || w === 'call') return 'call';
  if (w === 'bet' || w === 'raise') return 'raise';
  return 'fold';
}

export function TrainingView() {
  const [settings, setSettings] = useState<TrainingSettings>(loadSettings);
  const target = MOBILE ? 3 : 6;
  const pool = useRef<ScenarioPool | null>(null);
  const client = useRef<PostflopClient | null>(null);
  const rand = useRef(mulberry32((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0));
  const [poolStatus, setPoolStatus] = useState<PoolStatus>({ ready: 0, target, solving: null, error: null });
  const [hand, setHand] = useState<TrainingHand | null>(null);
  const [view, setView] = useState<HandView | null>(null);
  const [stats, setStats] = useState<SessionStats>(loadStats);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const counted = useRef({ reviews: 0, done: false });
  // keyboard cursor: arrow keys move it across the action buttons, Enter fires the focused one
  const [cursorAt, setCursorAt] = useState<{ key: string | null; index: number }>({ key: null, index: 0 });
  const actionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const nextHandRef = useRef<HTMLButtonElement | null>(null);

  if (!pool.current) pool.current = new ScenarioPool(settings, target);
  if (!client.current) client.current = new PostflopClient();

  useEffect(() => {
    const p = pool.current!;
    p.isBusy = () => (client.current?.active ?? 0) > 0;
    const unsub = p.subscribe(() => setPoolStatus(p.status));
    void p.load().then(() => p.fill());
    return () => { unsub(); p.stop(); client.current?.dispose(); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }, [settings]);

  useEffect(() => saveStats(stats), [stats]);

  // fold new hero reviews and finished hands into the session stats
  useEffect(() => {
    if (!view) return;
    const reviews = view.log.filter((e) => e.review);
    if (reviews.length > counted.current.reviews) {
      const fresh = reviews.slice(counted.current.reviews);
      counted.current.reviews = reviews.length;
      setStats((s) => fresh.reduce((acc, e) => addReview(acc, e.review!), s));
    }
    if (view.status === 'done' && view.result && !counted.current.done) {
      counted.current.done = true;
      const r = view.result;
      setStats((s) => ({ ...s, hands: s.hands + 1, chipResult: s.chipResult + r.chip, icmResult: s.icmResult + r.icm }));
    }
  }, [view]);

  const run = (p: Promise<void>) => p.catch((e) => setError(e instanceof Error ? e.message : String(e)));

  const newHand = async () => {
    setError(null);
    const sc = await pool.current!.take();
    if (!sc) return;
    const h = new TrainingHand(sc, rand.current, client.current!);
    counted.current = { reviews: 0, done: false };
    setSelected(null);
    setHand(h);
    setView(h.view);
    h.subscribe(() => setView(h.view));
    void run(h.begin());
    void pool.current!.fill();
  };

  const act = (i: number) => {
    if (!hand) return;
    setSelected(null);
    void run(hand.act(i));
  };

  const applySettings = (next: TrainingSettings) => {
    setSettings(next);
    void pool.current!.updateSettings(next, target).then(() => pool.current!.fill());
  };

  // when a hand ends, open the costliest decision in the review panel
  const doneRef = useRef<HandView | null>(null);
  useEffect(() => {
    if (view?.status === 'done' && view.result?.summary && doneRef.current !== view) {
      doneRef.current = view;
      if (view.result.summary.worstIndex !== null) setSelected(view.result.summary.worstIndex);
    }
  }, [view]);

  // ---- keyboard control: arrows move the cursor across the actions, Enter confirms,
  // and once the hand is over Enter deals the next one from the "다음 핸드" button.
  const heroOptions = view?.status === 'hero' && view.pending ? view.pending.options : null;
  const pendingKey = view && heroOptions ? `${view.log.length}:${heroOptions.length}` : null;
  // the cursor is scoped to one decision, so a new decision starts back at the first action
  const cursor = cursorAt.key === pendingKey ? Math.min(cursorAt.index, (heroOptions?.length ?? 1) - 1) : 0;
  const moveCursor = (step: number) => {
    const n = heroOptions?.length ?? 0;
    if (n > 0) setCursorAt({ key: pendingKey, index: (cursor + step + n) % n });
  };
  const canDeal = !!view && poolStatus.ready > 0 && (view.status === 'done' || view.status === 'hero');

  useEffect(() => {
    if (heroOptions) actionRefs.current[cursor]?.focus({ preventScroll: true });
  }, [pendingKey, cursor, heroOptions]);

  useEffect(() => {
    if (view?.status === 'done' && canDeal) nextHandRef.current?.focus({ preventScroll: true });
  }, [view?.status, canDeal]);

  useEffect(() => {
    if (!view) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      // if the user tabbed or clicked onto some other control, Enter belongs to that control
      const elsewhere = !!t && (t.tagName === 'BUTTON' || t.tagName === 'A')
        && t !== actionRefs.current[cursor] && t !== nextHandRef.current;
      if (heroOptions) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
        else if (e.key === 'Enter' && !elsewhere) { e.preventDefault(); act(cursor); }
        return;
      }
      if (view.status === 'done' && canDeal && e.key === 'Enter' && !elsewhere) { e.preventDefault(); void newHand(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const reviewRef = useRef<HTMLElement | null>(null);
  const selectDecision = (logIndex: number) => {
    setSelected(logIndex);
    if (MOBILE_LAYOUT()) reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const shownReview = selected !== null && view?.log[selected]?.review ? view.log[selected].review! : view?.lastReview ?? null;
  const shownIndex = selected !== null && view?.log[selected]?.review ? selected : view ? view.log.findIndex((e) => e.review === view.lastReview && !!e.review) : null;
  const acc = accuracy(stats);

  return (
    <div className="train">
      <aside className="train-side">
        <section className="cfg-block">
          <h2 className="eyebrow">세션</h2>
          <dl className="stat-grid">
            <div><dt>핸드</dt><dd>{stats.hands}</dd></div>
            <div><dt>결정</dt><dd>{stats.decisions}</dd></div>
            <div><dt>정확도</dt><dd>{acc === null ? '—' : `${Math.round(acc * 100)}%`}</dd></div>
            <div><dt>EV 손실</dt><dd>{stats.lossBB.toFixed(1)}<small>bb</small></dd></div>
            <div><dt>결정당 손실</dt><dd>{stats.decisions ? (stats.lossBB / stats.decisions).toFixed(2) : '—'}<small>bb</small></dd></div>
            <div><dt>칩 결과</dt><dd>{stats.chipResult >= 0 ? '+' : ''}{stats.chipResult.toFixed(1)}<small>bb</small></dd></div>
          </dl>
          <div className="verdict-row">
            {(['best', 'good', 'inaccuracy', 'mistake', 'blunder'] as const).map((v) => (
              <span key={v} className={`verdict-chip verdict-${v}`}>{VERDICT_LABEL[v]} {stats.verdicts[v]}</span>
            ))}
          </div>
          <button type="button" className="link" onClick={() => setStats(EMPTY_STATS)}>통계 초기화</button>
        </section>

        <section className="cfg-block">
          <h2 className="eyebrow">시나리오 풀</h2>
          <p className="pool-line">
            준비된 테이블 <b>{poolStatus.ready}</b> / {poolStatus.target}
          </p>
          {poolStatus.solving && (
            <div className="meter">
              <div className="meter-track"><div className="meter-fill" style={{ width: `${poolStatus.solving.progress * 100}%` }} /></div>
              <p className="meter-text">{poolStatus.solving.kind === 'download' ? '불러오는 중' : '솔브 중'} · {poolStatus.solving.label}</p>
            </div>
          )}
          {poolStatus.error && <p className="meter-text error">{poolStatus.error}</p>}
        </section>

        <section className="cfg-block">
          <h2 className="eyebrow">출제 범위</h2>
          <div className="row-2">
            <label className="field">
              <span>최소 스택 (bb)</span>
              <input type="number" inputMode="decimal" min={5} max={settings.maxStack} value={settings.minStack}
                onChange={(e) => applySettings({ ...settings, minStack: Math.max(5, Number(e.target.value)) })} />
            </label>
            <label className="field">
              <span>최대 스택 (bb)</span>
              <input type="number" inputMode="decimal" min={settings.minStack} max={200} value={settings.maxStack}
                onChange={(e) => applySettings({ ...settings, maxStack: Math.min(200, Math.max(settings.minStack, Number(e.target.value))) })} />
            </label>
            <label className="field">
              <span>인원</span>
              <select value={settings.players} onChange={(e) => applySettings({ ...settings, players: Number(e.target.value) })}>
                {[6, 7, 8].map((k) => <option key={k} value={k}>{k}명</option>)}
              </select>
            </label>
          </div>
          <div className="field">
            <span className="field-label">
              판단 기준
              <InfoTip label="판단 기준">
                <b>상금 (ICM)</b>: 상금 구조를 반영해 판단합니다. 탈락 위험 때문에 올인 콜 범위가 좁아집니다. 버블·파이널 테이블 연습용.
                <br />
                <b>칩 (Chip EV)</b>: 상금 없이 칩 기댓값만 봅니다. 필요 에퀴티가 순수 팟 오즈라 콜 범위가 넓습니다. 토너먼트 초반·캐시 게임 감각.
                <br />
                <b>섞기</b>: 대부분 상금 기준이고 가끔(약 15%) 칩 기준 테이블이 나와 두 기준을 비교할 수 있습니다.
              </InfoTip>
            </span>
            <div className="seg basis-toggle" role="radiogroup" aria-label="판단 기준">
              {CHIP_OPTIONS.map((o) => (
                <button key={o.label} type="button" role="radio" aria-checked={chipOption(settings.chipEvShare) === o.value}
                  className={chipOption(settings.chipEvShare) === o.value ? 'on' : ''} aria-label={o.full} title={o.full}
                  onClick={() => applySettings({ ...settings, chipEvShare: o.value })}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </section>
      </aside>

      <main className="train-main">
        {!view ? (
          <section className="train-empty">
            <p className="eyebrow">트레이닝</p>
            <h1>무작위 토너먼트 핸드를 플레이하고 결정마다 리뷰를 받습니다</h1>
            <ol>
              <li>스택, 상금 구조(ICM), 포지션, 핸드가 무작위로 정해집니다.</li>
              <li>상대는 솔버 전략대로 행동하고, 헤즈업 팟은 스트리트마다 포스트플랍 솔브가 돌아갑니다.</li>
              <li>액션을 고르면 GTO 빈도, 액션별 EV, 손실이 바로 나옵니다.</li>
            </ol>
            <button type="button" className="btn-solve" disabled={poolStatus.ready === 0} onClick={() => void newHand()}>
              {poolStatus.ready === 0 ? '첫 테이블 준비 중…' : '핸드 시작'}
            </button>
          </section>
        ) : (
          <>
            <div className="train-bar">
              <ScenarioBar info={describeScenario(view.scenario.config, view.heroSeat)} />
              <button type="button" ref={nextHandRef} className={`pill${view.status === 'done' && canDeal ? ' cursor' : ''}`}
                onClick={() => void newHand()} disabled={poolStatus.ready === 0 || (view.status !== 'done' && view.status !== 'hero')}>
                {view.status === 'done' ? '다음 핸드' : '새 핸드'}
              </button>
            </div>

            <Table view={view} />

            <div className="train-actions">
              {view.status === 'hero' && view.pending && (
                <>
                  <p className="action-prompt">
                    <b>{STREET_LABEL[view.pending.street]}</b> · {view.seatNames[view.heroSeat]} 차례
                    {view.pending.toCall > 0 && ` · 콜 ${view.pending.toCall.toFixed(1)}bb`}
                  </p>
                  <div className="actions">
                    {view.pending.options.map((label, i) => (
                      <button key={i} type="button" ref={(el) => { actionRefs.current[i] = el; }}
                        className={`action-btn kind-${actionKind(label)}${i === cursor ? ' cursor' : ''}`} onClick={() => act(i)}>
                        <span className="action-name">{label}</span>
                      </button>
                    ))}
                  </div>
                  <p className="key-hint">← → 방향키로 고르고 Enter로 선택</p>
                </>
              )}
              {view.status === 'solving' && (
                <div className="meter solving">
                  <p className="action-prompt"><b>{view.solvingStreet ? STREET_LABEL[view.solvingStreet] : ''}</b> 솔브 중 · 헤즈업 포스트플랍</p>
                  <div className="meter-track"><div className="meter-fill" style={{ width: `${view.solveProgress * 100}%` }} /></div>
                </div>
              )}
              {view.status === 'running' && <p className="action-prompt">상대가 생각 중…</p>}
              {view.status === 'done' && view.result && (
                <div className="result-line">
                  <b>{view.result.text}</b>
                  <span className={view.result.chip >= 0 ? 'pos' : 'neg'}>
                    {view.result.chip >= 0 ? '+' : ''}{view.result.chip.toFixed(1)}bb
                    {view.mode === 'icm' && ` · ICM ${view.result.icm >= 0 ? '+' : ''}${view.result.icm.toFixed(3)}%p`}
                  </span>
                </div>
              )}
              {view.status === 'done' && canDeal && <p className="key-hint">Enter를 누르면 다음 핸드</p>}
              {view.status === 'done' && view.result?.summary && (
                <HandSummaryCard summary={view.result.summary} selected={shownIndex} onSelect={selectDecision} />
              )}
              {error && <p className="meter-text error">{error}</p>}
            </div>
          </>
        )}
      </main>

      <aside className="train-review" ref={reviewRef}>
        <ReviewCard review={shownReview} />
      </aside>
    </div>
  );
}

const SUMMARY_TONE: Record<HandSummary['tone'], string> = { perfect: 'best', good: 'good', close: 'inaccuracy', review: 'blunder', none: 'info' };

function HandSummaryCard({ summary, selected, onSelect }: { summary: HandSummary; selected: number | null; onSelect: (logIndex: number) => void }) {
  return (
    <section className={`hand-summary verdict-${SUMMARY_TONE[summary.tone]}`}>
      <div className="hand-summary-head">
        <p className="eyebrow">핸드 리뷰</p>
        <span className="verdict-badge">{summary.grade}</span>
      </div>
      {summary.decisions > 0 && (
        <>
          <p className="hand-summary-line">
            결정 {summary.decisions}개 · 총 EV 손실 <b>{summary.lossBB.toFixed(2)}bb</b>
          </p>
          <ol className="summary-items">
            {summary.items.map((it) => (
              <li key={it.logIndex}>
                <button type="button" className={selected === it.logIndex ? 'active' : ''} onClick={() => onSelect(it.logIndex)}>
                  <span className={`verdict-dot verdict-${it.verdict}`} aria-hidden />
                  <span className="summary-street">{STREET_LABEL[it.street as keyof typeof STREET_LABEL]}</span>
                  <span className="summary-text">{it.text}</span>
                  {it.logIndex === summary.worstIndex && <span className="summary-flag">가장 큰 손실</span>}
                  <span className={`summary-loss${it.lossBB > 0.05 ? ' neg' : ''}`}>{it.lossBB > 0.05 ? `-${it.lossBB.toFixed(2)}bb` : '✓'}</span>
                </button>
              </li>
            ))}
          </ol>
          <p className="hint">결정을 누르면 결정 리뷰 카드에서 그 판단의 이유를 볼 수 있어요.</p>
        </>
      )}
      {summary.lessons.length > 0 && (
        <>
          <p className="eyebrow">다음 핸드에서 기억할 것</p>
          <ul className="coach-reasons">
            {summary.lessons.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}

function MOBILE_LAYOUT() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches;
}

function Table({ view }: { view: HandView }) {
  const shown = new Map(view.result?.shown.map((s) => [s.seat, s]) ?? []);
  const streetBets = view.bets.reduce((a, b) => a + b, 0);
  return (
    <section className="table">
      <ol className="rail train-rail">
        {view.seatNames.map((name, seat) => {
          const hero = seat === view.heroSeat;
          const reveal = shown.get(seat);
          const cards: Array<number | null> | null = hero ? view.heroCards : reveal ? reveal.cards : view.folded[seat] ? null : [null, null];
          const cls = ['seat', hero && 'hero', view.folded[seat] && 'folded', view.allin[seat] && 'allin', view.pending && hero && 'acting'].filter(Boolean).join(' ');
          return (
            <li key={seat} className={cls}>
              <div>
                <span className="seat-name">
                  {name}{seat === view.button && <span className="dealer" aria-label="딜러 버튼">D</span>}
                  {hero && <span className="hero-tag">나</span>}
                </span>
                <span className="seat-stack">{view.stacks[seat].toFixed(1)}<small>bb</small></span>
                <span className="seat-cards">
                  {cards ? cards.map((c, i) => <PlayingCard key={i} card={c} size="sm" />) : <span className="seat-folded">폴드</span>}
                </span>
                <span className="seat-bet">
                  {view.bets[seat] > 0 ? (
                    <span className={`bet-chip${view.allin[seat] ? ' allin' : ''}`} aria-label={`${view.allin[seat] ? '올인 ' : ''}베팅 ${view.bets[seat].toFixed(1)}bb`}>
                      <i className="chip-coin" aria-hidden />
                      {view.allin[seat] && <em>올인</em>}
                      {view.bets[seat].toFixed(1)}
                    </span>
                  ) : view.allin[seat] ? (
                    <span className="bet-chip allin bare"><em>올인</em></span>
                  ) : view.checked[seat] ? (
                    <span className="bet-chip check bare" aria-label="체크"><em>체크</em></span>
                  ) : null}
                  {reveal && <span className="seat-reveal">{reveal.hand}</span>}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="felt">
        <div className="board">
          {Array.from({ length: 5 }, (_, i) => (view.board[i] !== undefined ? <PlayingCard key={i} card={view.board[i]} size="lg" /> : <EmptySlot key={i} size="lg" />))}
        </div>
        <div className="pot" aria-label={`팟 ${view.pot.toFixed(1)}bb`}>
          <span className="pot-stack" aria-hidden><i /><i /><i /></span>
          <span className="pot-label">팟</span>
          <b className="pot-amount">{view.pot.toFixed(1)}<small>bb</small></b>
        </div>
        <p className="pot-sub">
          {STREET_LABEL[view.street]}
          {streetBets > 0.001 && <> · 이번 스트리트 베팅 <b>{streetBets.toFixed(1)}bb</b> 포함</>}
        </p>
        <div className="hero-hand">
          <PlayingCard card={view.heroCards[0]} size="lg" />
          <PlayingCard card={view.heroCards[1]} size="lg" />
          <span className="hero-seat">{view.seatNames[view.heroSeat]}</span>
        </div>
      </div>
    </section>
  );
}
