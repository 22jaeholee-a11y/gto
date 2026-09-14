import type { ScenarioInfo } from '../../engine/training/scenario';

export function ScenarioBar({ info }: { info: ScenarioInfo }) {
  return (
    <div className="scenario">
      <ul className="scenario-chips">
        <li>
          <span className="chip-key">테이블</span>
          <b>{info.players}인</b>
        </li>
        <li>
          <span className="chip-key">평균 스택</span>
          <b>{info.avgStack.toFixed(0)}bb</b>
        </li>
        {info.heroStack !== null && (
          <li className="chip-hero">
            <span className="chip-key">내 스택</span>
            <b>{info.heroStack}bb</b>
            <small>{info.heroRank}위 / {info.players}명</small>
          </li>
        )}
        <li>
          <span className="chip-key">앤티</span>
          <b>{info.ante > 0 ? `BB ${info.ante}bb` : '없음'}</b>
        </li>
        <li>
          <span className="chip-key">계산 기준</span>
          <b>{info.mode === 'icm' ? '상금 (ICM)' : '칩 (Chip EV)'}</b>
        </li>
      </ul>

      <p className="payout-line payout-static">
        <span className="payout-name">{info.payout ? info.payout.name : '칩 기준'}</span>
        <span className="payout-hint">{info.payout ? info.payout.hint : '상금 구조 없이 칩 기댓값만으로 판단해요'}</span>
      </p>
    </div>
  );
}
