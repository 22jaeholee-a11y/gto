import { useEffect, useState } from 'react';
import type { ActionReview } from '../../engine/training/hand';
import { RangePanel, type RangeTab } from './RangePanel';
import { VERDICT_LABEL } from './stats';

const STREET_LABEL = { preflop: '프리플랍', flop: '플랍', turn: '턴', river: '리버' } as const;

function fmt(x: number | null, digits: number, unit: string) {
  if (x === null || !Number.isFinite(x)) return '—';
  const s = x.toFixed(digits);
  return `${x > 0 && Number(s) !== 0 ? '+' : ''}${s}${unit}`;
}

export function ReviewCard({ review }: { review: ActionReview | null }) {
  if (!review) {
    return (
      <section className="review empty">
        <p className="eyebrow">결정 리뷰</p>
        <p>액션을 고르면 솔버 기준 빈도와 EV, 손실이 바로 표시됩니다.</p>
      </section>
    );
  }
  return <ReviewBody review={review} />;
}

function ReviewBody({ review }: { review: ActionReview }) {
  // the range chart follows the chosen action until another action is picked
  const [tab, setTab] = useState<RangeTab>(review.chosen);
  useEffect(() => setTab(review.chosen), [review]);
  const primaryUnit = review.primary === 'icm' ? '%p' : 'bb';
  const showIcm = review.options.some((o) => o.evIcm !== null);
  const showFreq = review.options.some((o) => o.freq !== null);
  const chosen = review.options[review.chosen];
  return (
    <section className={`review verdict-${review.verdict}`} aria-live="polite">
      <div className="review-head">
        <span className="verdict-badge">{VERDICT_LABEL[review.verdict]}</span>
        <span className="review-meta">{STREET_LABEL[review.street]} · {review.hand} · {review.options[review.chosen].label}</span>
      </div>
      {!review.explanation && <p className="review-line">
        <b>{chosen.label}</b>
        {review.verdict === 'info'
          ? ' — EV를 계산하지 않은 액션입니다.'
          : review.loss > 1e-9
            ? ` — 최선(${review.options[review.best].label}) 대비 ${review.loss.toFixed(review.primary === 'icm' ? 3 : 2)}${primaryUnit} 손실${review.primary === 'icm' ? ` (약 ${review.lossBB.toFixed(2)}bb)` : ''}`
            : ' — EV 손실 없음'}
      </p>}
      {review.explanation && (
        <div className="coach">
          <p className="coach-headline">{review.explanation.headline}</p>
          <p className="eyebrow">왜 이 판단인가</p>
          <ul className="coach-reasons">
            {review.explanation.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
          {review.explanation.tags.length > 0 && (
            <div className="coach-tags">
              {review.explanation.tags.map((t) => <span key={t} className="coach-tag">{t}</span>)}
            </div>
          )}
        </div>
      )}
      <div className="review-table-wrap">
        <table className="review-table">
          <thead>
            <tr>
              <th scope="col">액션</th>
              {showFreq && <th scope="col">GTO 빈도</th>}
              {showIcm && <th scope="col">ICM EV</th>}
              <th scope="col">Chip EV</th>
            </tr>
          </thead>
          <tbody>
            {review.options.map((o, i) => (
              <tr key={i} className={`${i === review.chosen ? 'chosen' : ''}${i === review.best ? ' best' : ''}`}>
                <th scope="row">
                  {review.range ? (
                    <button type="button" className="range-action" onClick={() => setTab(i)} aria-pressed={tab === i} title="레인지 차트에서 이 액션의 EV 보기">
                      {i === review.best && <span className="best-mark" aria-label="최선">★</span>}
                      {o.label}
                    </button>
                  ) : (
                    <>
                      {i === review.best && <span className="best-mark" aria-label="최선">★</span>}
                      {o.label}
                    </>
                  )}
                </th>
                {showFreq && (
                  <td>
                    <span className="freq-bar"><span style={{ width: `${Math.round((o.freq ?? 0) * 100)}%` }} /></span>
                    <span className="freq-num">{o.freq === null ? '—' : `${(o.freq * 100).toFixed(0)}%`}</span>
                  </td>
                )}
                {showIcm && <td>{fmt(o.evIcm, 3, '')}</td>}
                <td>{fmt(o.evChip, 2, '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {review.notes.length > 0 && (
        <ul className="review-notes">
          {review.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
      <p className="hint">EV는 핸드 시작 대비 결과의 기대값입니다 (ICM: 상금 풀 %p, Chip: bb).</p>
      {review.range ? (
        <RangePanel range={review.range} primary={review.primary} chosen={review.chosen} tab={tab} onTab={setTab} />
      ) : (
        <p className="hint">이 결정은 솔버가 없는 3인 이상 팟이라 레인지별 EV를 계산하지 않습니다.</p>
      )}
    </section>
  );
}
