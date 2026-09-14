import { useState } from 'react';
import { DEFAULT_CONFIG, seatNames, type SolverConfig } from '../engine/config';
import type { SolveState } from './useSolver';

const PAYOUT_PRESETS: Array<{ label: string; payouts: number[] }> = [
  { label: '파이널 테이블', payouts: [30, 20, 14, 10, 8, 7, 6, 5] },
  { label: '버블 (7명 지급)', payouts: [30, 20, 15, 12, 9, 7, 7] },
  { label: '승자 독식', payouts: [1] },
];

interface Props {
  config: SolverConfig;
  onChange: (c: SolverConfig) => void;
  solve: SolveState;
  onStart: () => void;
  onStop: () => void;
}

export function ConfigPanel({ config, onChange, solve, onStart, onStop }: Props) {
  const [advanced, setAdvanced] = useState(false);
  const [payoutText, setPayoutText] = useState(config.payouts.join(', '));
  const n = config.stacks.length;
  const names = seatNames(n);
  const running = solve.status === 'building' || solve.status === 'solving';
  const set = (patch: Partial<SolverConfig>) => onChange({ ...config, ...patch });
  const setSizing = (k: keyof SolverConfig['sizing'], v: number) => onChange({ ...config, sizing: { ...config.sizing, [k]: v } });

  const setPlayers = (count: number) => {
    const cur = config.stacks;
    const next = Array.from({ length: count }, (_, i) => cur[cur.length - count + i] ?? cur[0] ?? 25);
    set({ stacks: next });
  };

  const applyPayouts = (text: string) => {
    setPayoutText(text);
    const nums = text.split(/[,\s]+/).map(Number).filter((x) => Number.isFinite(x) && x >= 0);
    if (nums.length > 0 && nums.some((x) => x > 0)) set({ payouts: nums });
  };

  const payTotal = config.payouts.reduce((a, b) => a + b, 0);

  return (
    <aside className="config">
      <section className="cfg-block">
        <h2 className="eyebrow">테이블</h2>
        <div className="row-2">
          <label className="field">
            <span>인원</span>
            <select value={n} onChange={(e) => setPlayers(Number(e.target.value))} disabled={running}>
              {[2, 3, 4, 5, 6, 7, 8].map((k) => <option key={k} value={k}>{k}명</option>)}
            </select>
          </label>
          <label className="field">
            <span>BB 앤티</span>
            <input type="number" inputMode="decimal" step="0.1" min="0" value={config.ante} disabled={running}
              onChange={(e) => set({ ante: Math.max(0, Number(e.target.value)) })} />
          </label>
        </div>

        <div className="stack-head">
          <span>스택 (bb)</span>
          <button type="button" className="link" disabled={running}
            onClick={() => set({ stacks: config.stacks.map(() => config.stacks[0]) })}>
            첫 좌석 값으로 통일
          </button>
        </div>
        <div className="stacks">
          {config.stacks.map((s, i) => (
            <label key={names[i]} className="stack-input">
              <span>{names[i]}</span>
              <input type="number" inputMode="decimal" min="2" step="0.5" value={s} disabled={running}
                onChange={(e) => {
                  const next = config.stacks.slice();
                  next[i] = Math.max(2, Number(e.target.value));
                  set({ stacks: next });
                }} />
            </label>
          ))}
        </div>
      </section>

      <section className="cfg-block">
        <h2 className="eyebrow">상금 구조</h2>
        <div className="chips-row">
          {PAYOUT_PRESETS.map((p) => (
            <button key={p.label} type="button" className="pill" disabled={running}
              onClick={() => applyPayouts(p.payouts.join(', '))}>{p.label}</button>
          ))}
        </div>
        <label className="field">
          <span>등수별 상금 (쉼표로 구분, 1등부터)</span>
          <input type="text" value={payoutText} disabled={running} onChange={(e) => applyPayouts(e.target.value)} />
        </label>
        <p className="hint">
          {config.payouts.map((p, i) => `${i + 1}등 ${((p / payTotal) * 100).toFixed(1)}%`).join(' · ')}
        </p>
        <div className="seg" role="radiogroup" aria-label="계산 기준">
          <button type="button" role="radio" aria-checked={config.mode === 'icm'} className={config.mode === 'icm' ? 'on' : ''}
            disabled={running} onClick={() => set({ mode: 'icm' })}>ICM</button>
          <button type="button" role="radio" aria-checked={config.mode === 'chip'} className={config.mode === 'chip' ? 'on' : ''}
            disabled={running} onClick={() => set({ mode: 'chip' })}>Chip EV</button>
        </div>
      </section>

      <section className="cfg-block">
        <button type="button" className="disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
          <span className="eyebrow">액션 트리 · 솔버 옵션</span>
          <span aria-hidden>{advanced ? '−' : '+'}</span>
        </button>
        {advanced && (
          <div className="advanced">
            <div className="row-2">
              <NumField label="오픈 (bb)" value={config.sizing.open} step={0.1} disabled={running} onChange={(v) => setSizing('open', v)} />
              <NumField label="SB 오픈 (bb)" value={config.sizing.sbOpen} step={0.1} disabled={running} onChange={(v) => setSizing('sbOpen', v)} />
              <NumField label="림프 상대 레이즈" value={config.sizing.iso} step={0.1} disabled={running} onChange={(v) => setSizing('iso', v)} />
              <NumField label="4벳 배수" value={config.sizing.fourBet} step={0.1} disabled={running} onChange={(v) => setSizing('fourBet', v)} />
              <NumField label="3벳 배수 (IP)" value={config.sizing.threeBetIP} step={0.1} disabled={running} onChange={(v) => setSizing('threeBetIP', v)} />
              <NumField label="3벳 배수 (OOP)" value={config.sizing.threeBetOOP} step={0.1} disabled={running} onChange={(v) => setSizing('threeBetOOP', v)} />
              <NumField label="스퀴즈 콜러당 추가" value={config.sizing.squeezePerCaller} step={0.1} disabled={running} onChange={(v) => setSizing('squeezePerCaller', v)} />
              <NumField label="올인 전환 비율" value={config.sizing.allinThreshold} step={0.01} disabled={running} onChange={(v) => setSizing('allinThreshold', v)} />
            </div>
            <Check label="SB 림프 허용" checked={config.allowLimp} disabled={running} onChange={(v) => set({ allowLimp: v })} />
            <Check label="콜드콜 허용" checked={config.allowColdCall} disabled={running} onChange={(v) => set({ allowColdCall: v })} />
            <Check label="푸시/폴드만" checked={config.pushFoldOnly} disabled={running} onChange={(v) => set({ pushFoldOnly: v })} />
            <div className="row-2">
              <NumField label="반복 횟수" value={config.iterations} step={50} disabled={running} onChange={(v) => set({ iterations: Math.max(10, Math.round(v)) })} />
              <NumField label="포스트플랍 팟 성장" value={config.postflop.potGrowth} step={0.1} disabled={running}
                onChange={(v) => set({ postflop: { ...config.postflop, potGrowth: Math.max(0, v) } })} />
            </div>
            <button type="button" className="link" disabled={running}
              onClick={() => { onChange({ ...DEFAULT_CONFIG, stacks: config.stacks, payouts: config.payouts, ante: config.ante }); }}>
              옵션 기본값으로
            </button>
          </div>
        )}
      </section>

      <div className="solve-bar">
        {running ? (
          <button type="button" className="btn-solve stop" onClick={onStop}>중지</button>
        ) : (
          <button type="button" className="btn-solve" onClick={onStart}>솔브</button>
        )}
        <SolveMeter solve={solve} mode={config.mode} />
      </div>
    </aside>
  );
}

function SolveMeter({ solve, mode }: { solve: SolveState; mode: 'icm' | 'chip' }) {
  if (solve.status === 'idle') return <p className="meter-text">설정을 확인하고 솔브를 누르세요.</p>;
  if (solve.status === 'error') return <p className="meter-text error">{solve.error}</p>;
  if (solve.status === 'building') return <p className="meter-text">게임 트리 생성 중…</p>;
  const frac = solve.total ? solve.iteration / solve.total : 0;
  const unit = mode === 'icm' ? '%p' : 'bb';
  return (
    <div className="meter">
      <div className="meter-track"><div className="meter-fill" style={{ width: `${frac * 100}%` }} /></div>
      <p className="meter-text">
        {solve.status === 'done' ? '완료' : '계산 중'} · {solve.iteration}/{solve.total}회 · {(solve.elapsedMs / 1000).toFixed(1)}초{solve.threads > 1 && ` · ${solve.threads}스레드`}
        {solve.exploitability !== undefined && ` · 착취 가능도 ${solve.exploitability.toFixed(3)}${unit}`}
        {solve.tree && ` · 결정 노드 ${solve.tree.numDecisions.toLocaleString()}`}
      </p>
    </div>
  );
}

function NumField({ label, value, step, disabled, onChange }: { label: string; value: number; step: number; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" inputMode="decimal" value={value} step={step} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Check({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
