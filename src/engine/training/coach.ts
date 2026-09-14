// Rule-based coaching: turns the solver numbers behind a decision into short explanations.
// Every sentence is derived from quantities the solver or the hand evaluator produced.

import { NUM_CLASSES } from '../cards';
import { describeHand, equityVsRange, preflopEquityVsRange, preflopFeatures, PREFLOP_PERCENTILE, rangeShare, strengthPercentile, strongShare } from './handinfo';

export interface Explanation {
  headline: string;
  reasons: string[];
  tags: string[];
}

type Kind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

interface CommonInput {
  hand: string;
  labels: string[];
  kinds: Kind[];
  freq: Array<number | null>;
  evIcm: Array<number | null>;
  evChip: Array<number | null>;
  chosen: number;
  best: number;
  primary: 'icm' | 'chip';
  loss: number;
  lossBB: number;
}

export interface PreflopCoachInput extends CommonInput {
  heroClass: number;
  heroName: string;
  seatNames: string[];
  hero: number;
  pot: number;
  toCall: number;
  heroContrib: number;
  /** chips the hero has left behind */
  heroBehind: number;
  isBlind: boolean;
  /** last raiser before the hero, or null when the pot is unopened / limped */
  aggressor: number | null;
  aggressorAllin: boolean;
  /** class-level reach of the aggressor's range, including the raise */
  villainReach: Float64Array | null;
  /** equity the hero needs for the call to beat folding, when the call leads to a heads-up all-in */
  requiredChip: number | null;
  requiredIcm: number | null;
  playersLeft: number;
  /** share of the hero's range that raises or shoves at this node */
  heroOpenShare: number | null;
  startStacks: number[];
  payouts: number[];
}

export interface PostflopCoachInput extends CommonInput {
  street: 'flop' | 'turn' | 'river';
  hole: [number, number];
  board: number[];
  villainName: string;
  pot: number;
  toCall: number;
  heroBehind: number;
  villainBehind: number;
  inPosition: boolean;
  heroRange: Float64Array;
  villainRange: Float64Array;
  requiredChip: number | null;
  requiredIcm: number | null;
}

export interface MultiwayCoachInput extends CommonInput {
  street: 'flop' | 'turn' | 'river';
  hole: [number, number];
  board: number[];
  equity: number;
  toCall: number;
  pot: number;
  players: number;
}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const bb = (x: number) => `${(Math.round(x * 10) / 10).toFixed(1)}bb`;
const short = (label: string) => label.split(' (')[0];
/** action name quoted so Korean particles attach to "액션" instead of an English word */
const act = (label: string) => `'${short(label)}' 액션`;

function argmax(values: Array<number | null>): number {
  let best = -1;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) return;
    if (best < 0 || v > (values[best] as number)) best = i;
  });
  return best;
}

function headline(inp: CommonInput): string {
  const unit = inp.primary === 'icm' ? '%p' : 'bb';
  const chosen = short(inp.labels[inp.chosen]);
  if (inp.chosen === inp.best || inp.lossBB <= 0.05) {
    const f = inp.freq[inp.chosen];
    if (f !== null && f < 0.5 && inp.chosen !== inp.best) return `좋은 선택: ${chosen} — 최선과 EV 차이가 거의 없습니다`;
    return `최선의 선택: ${chosen}`;
  }
  const digits = inp.primary === 'icm' ? 3 : 2;
  return `더 나은 선택: ${short(inp.labels[inp.best])} (${chosen}보다 +${inp.loss.toFixed(digits)}${unit}${inp.primary === 'icm' ? `, 약 ${inp.lossBB.toFixed(2)}bb` : ''})`;
}

/**
 * Chip EV and ICM disagree about the best action: the payout structure is doing the work.
 * Mentioned when the hero picked the chip-EV action, or when the spot is an all-in decision.
 */
function icmVsChip(inp: CommonInput, reasons: string[], tags: string[], allinSpot = false) {
  if (inp.primary !== 'icm') return;
  const bc = argmax(inp.evChip);
  const bi = argmax(inp.evIcm);
  if (bc < 0 || bi < 0 || bc === bi) return;
  if (inp.chosen !== bc && !allinSpot) return;
  const chipGain = (inp.evChip[bc] as number) - (inp.evChip[bi] as number);
  const icmGain = (inp.evIcm[bi] as number) - (inp.evIcm[bc] as number);
  if (chipGain < 0.05) return;
  reasons.push(
    `칩 EV로만 보면 ${act(inp.labels[bc])}이 ${chipGain.toFixed(2)}bb 더 벌지만, ICM에서는 ${act(inp.labels[bi])}이 ${icmGain.toFixed(3)}%p 더 낫습니다. ` +
      `상금 구조에서는 칩을 잃는 손해가 같은 양을 따는 이득보다 크게 평가되기 때문입니다.`,
  );
  tags.push('ICM 압박');
}

function mixed(inp: CommonInput, reasons: string[], tags: string[]) {
  const f = inp.freq[inp.chosen];
  if (f === null) return;
  if (inp.chosen !== inp.best && f >= 0.1) {
    reasons.push(`솔버도 이 핸드로 ${act(inp.labels[inp.chosen])}을 ${pct(f, 0)} 섞습니다. 액션 간 EV 차이가 작아 둘 다 쓸 수 있는 스팟입니다.`);
    tags.push('혼합 전략');
  } else if (inp.chosen !== inp.best && f < 0.02 && inp.lossBB > 0.3) {
    reasons.push(`솔버는 이 핸드로 ${act(inp.labels[inp.chosen])}을 거의 선택하지 않습니다 (${pct(f, 1)}).`);
  }
}

function tournamentContext(inp: PreflopCoachInput, reasons: string[], tags: string[], risky: boolean) {
  if (inp.primary !== 'icm' || !risky) return;
  const n = inp.startStacks.length;
  const paid = inp.payouts.filter((p) => p > 0).length;
  const heroStack = inp.startStacks[inp.hero];
  if (paid < n) {
    reasons.push(`${n}명 중 ${paid}명만 상금을 받는 버블 상황입니다. 여기서 탈락하면 상금이 0이라 살아남는 가치가 칩 가치보다 큽니다.`);
    tags.push('버블');
  }
  const shorter = inp.startStacks.filter((s, i) => i !== inp.hero && s < heroStack).length;
  if (shorter > 0 && paid >= n) {
    reasons.push(`나보다 짧은 스택이 ${shorter}명 있어, 무리하지 않고 기다리기만 해도 순위(상금)가 오를 여지가 있습니다.`);
    tags.push('래더');
  }
  if (inp.aggressor !== null) {
    const v = inp.startStacks[inp.aggressor];
    const name = inp.seatNames[inp.aggressor];
    if (v >= heroStack) {
      reasons.push(`${name} 스택(${bb(v)})이 내 스택(${bb(heroStack)})을 커버해서, 이 올인에서 지면 바로 탈락합니다.`);
      tags.push('탈락 위험');
    } else {
      reasons.push(`내 스택(${bb(heroStack)})이 ${name}(${bb(v)})보다 커서 져도 탈락하지는 않습니다.`);
    }
  }
}

export function explainPreflop(inp: PreflopCoachInput): Explanation {
  const reasons: string[] = [];
  const tags: string[] = [];
  const bestKind = inp.kinds[inp.best];
  const feats = preflopFeatures(inp.heroClass);
  const percentile = PREFLOP_PERCENTILE[inp.heroClass];
  const riskyChoice = [inp.best, inp.chosen].some((i) => inp.kinds[i] === 'allin' || (inp.kinds[i] === 'call' && inp.aggressorAllin));

  // facing an all-in: equity needed versus equity held
  if (inp.requiredChip !== null && inp.requiredIcm !== null && inp.villainReach) {
    const eq = preflopEquityVsRange(inp.heroClass, inp.villainReach);
    const share = rangeShare(inp.villainReach);
    const name = inp.aggressor !== null ? inp.seatNames[inp.aggressor] : '상대';
    if (eq !== null) {
      const premium = inp.requiredIcm - inp.requiredChip;
      let text = `콜하려면 에퀴티가 칩 기준 ${pct(inp.requiredChip)}${inp.primary === 'icm' ? `, ICM 기준 ${pct(inp.requiredIcm)}` : ''} 필요합니다. ` +
        `${inp.hand}는 ${name}의 레인지(전체 핸드의 ${pct(share, 0)}) 상대로 에퀴티 ${pct(eq)}입니다. `;
      const need = inp.primary === 'icm' ? inp.requiredIcm : inp.requiredChip;
      if (eq + 0.005 < need) {
        text += inp.primary === 'icm' && eq >= inp.requiredChip
          ? `칩 기준으로는 콜할 만하지만 ICM 기준에 ${((need - eq) * 100).toFixed(1)}%p 모자라 폴드가 낫습니다.`
          : `필요한 에퀴티에 ${((need - eq) * 100).toFixed(1)}%p 모자라 폴드가 낫습니다.`;
      } else {
        text += `필요한 에퀴티보다 ${((eq - need) * 100).toFixed(1)}%p 높아 콜이 이득입니다.`;
      }
      reasons.push(text);
      if (inp.primary === 'icm' && premium >= 0.02) {
        reasons.push(`ICM이 요구하는 추가 에퀴티(리스크 프리미엄)는 +${(premium * 100).toFixed(1)}%p입니다. 칩을 두 배로 불리는 것보다 탈락을 피하는 것이 상금 기대값에 더 중요하다는 뜻입니다.`);
        tags.push('리스크 프리미엄');
      }
    }
  }

  icmVsChip(inp, reasons, tags, inp.requiredIcm !== null);
  tournamentContext(inp, reasons, tags, riskyChoice || inp.requiredIcm !== null);

  // first in: opening range and hand strength
  if (inp.aggressor === null && inp.toCall <= 1 + 1e-9 && inp.heroOpenShare !== null && inp.kinds.some((k) => k === 'raise' || k === 'allin')) {
    let text = `${inp.heroName} 위치에서 솔버의 오픈(레이즈·올인) 비율은 ${pct(inp.heroOpenShare, 0)}이고, ${inp.hand}(${feats.label})는 전체 핸드 중 상위 ${pct(percentile, 0)}입니다. `;
    if (bestKind === 'fold') text += inp.playersLeft > 0 ? `뒤에 ${inp.playersLeft}명이 남아 있어 이 핸드로 열면 더 강한 핸드에 부딪히기 쉽습니다.` : '이 핸드는 오픈 레인지 밖입니다.';
    else text += '오픈 레인지 안쪽이라 블라인드와 앤티를 가져오는 이득이 큽니다.';
    reasons.push(text);
    tags.push('오픈 레인지');
  }

  // stack depth and all-in vs raise
  const depth = inp.heroBehind + inp.heroContrib;
  if (inp.kinds.includes('allin')) {
    if (bestKind === 'allin' && depth <= 15) {
      reasons.push(`스택이 ${bb(depth)}로 짧아 레이즈 후 상대 리레이즈에 폴드하면 손해가 큽니다. 처음부터 올인해 폴드 에퀴티를 최대로 가져가는 편이 효율적입니다.`);
      tags.push('숏스택');
    } else if ((bestKind === 'raise' || bestKind === 'call') && inp.kinds[inp.chosen] === 'allin' && depth > 20) {
      reasons.push(`스택이 ${bb(depth)}로 깊어 올인하면 더 약한 핸드는 폴드하고 강한 핸드만 콜합니다. 작은 사이즈로 더 넓은 핸드에서 가치를 얻는 편이 낫습니다.`);
      tags.push('사이징');
    }
  }

  // defending from the blinds
  if (inp.isBlind && inp.aggressor !== null && !inp.aggressorAllin && inp.toCall > 0 && bestKind !== 'fold') {
    const odds = inp.toCall / (inp.pot + inp.toCall);
    reasons.push(`블라인드로 이미 ${bb(inp.heroContrib)}를 넣어서 ${bb(inp.toCall)}만 더 내면 ${bb(inp.pot + inp.toCall)} 팟을 다툽니다 (필요 에퀴티 ${pct(odds, 0)}). 그래서 넓게 디펜스합니다.`);
    tags.push('팟 오즈');
  }

  // blockers for aggressive lines against a raise
  if (inp.aggressor !== null && (bestKind === 'raise' || bestKind === 'allin') && percentile > 0.12 && (feats.hasAce || feats.hasKing)) {
    reasons.push(`${feats.hasAce ? 'A' : 'K'}를 들고 있어 상대가 ${feats.hasAce ? 'AA·AK' : 'KK·AK'} 같은 강한 핸드를 가질 조합이 줄어듭니다 (블로커). 공격적인 라인에 유리합니다.`);
    tags.push('블로커');
  }

  mixed(inp, reasons, tags);
  if (reasons.length === 0) reasons.push(`${inp.hand}는 전체 핸드 중 상위 ${pct(percentile, 0)}인 ${feats.label}입니다. 이 지점에서는 솔버 EV가 가장 높은 ${act(inp.labels[inp.best])}이 기준입니다.`);
  return { headline: headline(inp), reasons: reasons.slice(0, 5), tags: Array.from(new Set(tags)) };
}

export function explainPostflop(inp: PostflopCoachInput): Explanation {
  const reasons: string[] = [];
  const tags: string[] = [];
  const bestKind = inp.kinds[inp.best];
  const desc = describeHand(inp.hole, inp.board);
  const eq = equityVsRange(inp.hole, inp.board, inp.villainRange);
  const rank = strengthPercentile(inp.hole, inp.board, inp.heroRange);

  // what the hand is
  let text = `${inp.hand}: ${desc.made}${desc.draws.length ? ` + ${desc.draws.join(', ')}` : ''}.`;
  if (eq !== null) text += ` ${inp.villainName} 레인지 상대로 에퀴티 ${pct(eq)}${inp.street !== 'river' ? ' (남은 카드 전부 오픈 기준)' : ''}.`;
  if (rank !== null) text += rank <= 0.5 ? ` 내 레인지 안에서 현재 강도 상위 ${pct(Math.max(rank, 0.01), 0)}.` : ` 내 레인지 안에서 현재 강도 하위 ${pct(Math.max(1 - rank, 0.01), 0)}.`;
  reasons.push(text);

  // calling decisions
  if (inp.toCall > 0 && eq !== null) {
    const req = inp.requiredChip ?? inp.toCall / (inp.pot + inp.toCall);
    let t = `${bb(inp.toCall)}를 콜해 ${bb(inp.pot + inp.toCall)} 팟을 가져가려면 에퀴티 ${pct(req)}가 필요합니다`;
    if (inp.requiredIcm !== null && inp.primary === 'icm') t += ` (ICM 기준 ${pct(inp.requiredIcm)})`;
    t += inp.street === 'river' ? '. ' : ' (이후 스트리트 베팅 전 기준). ';
    const need = inp.primary === 'icm' && inp.requiredIcm !== null ? inp.requiredIcm : req;
    if (bestKind === 'fold') t += eq < need ? '에퀴티가 부족해 폴드가 낫습니다.' : '에퀴티는 충분해 보여도 뒤 스트리트에서 더 큰 베팅을 맞을 가능성까지 반영하면 폴드가 낫습니다.';
    else if (bestKind === 'call') t += eq >= need ? '에퀴티가 충분해 콜이 이득입니다.' : '당장 에퀴티는 모자라지만 드로우가 완성되면 더 받아낼 수 있어(임플라이드 오즈) 콜이 낫습니다.';
    else t += '콜보다 레이즈가 더 많은 가치를 얻습니다.';
    reasons.push(t);
    if (inp.requiredIcm !== null && inp.primary === 'icm' && inp.requiredIcm - req >= 0.02) tags.push('리스크 프리미엄');
    tags.push('팟 오즈');
  }

  // why bet / check
  if (eq !== null && (bestKind === 'bet' || bestKind === 'raise' || bestKind === 'allin')) {
    if (eq >= 0.6) { reasons.push('밸류: 상대 레인지보다 크게 앞서 있어, 더 약한 핸드의 콜을 받아 팟을 키우는 것이 이득입니다.'); tags.push('밸류'); }
    else if (eq <= 0.35 && desc.draws.length) { reasons.push(`세미블러프: 지금은 뒤처지지만 ${desc.draws.join(', ')}로 역전할 수 있고, 베팅으로 더 좋은 핸드를 폴드시킬 수도 있습니다.`); tags.push('세미블러프'); }
    else if (eq <= 0.35) { reasons.push('블러프: 쇼다운에서 이기기 어려운 핸드라, 베팅으로 상대의 폴드를 받아내는 편이 체크보다 낫습니다.'); tags.push('블러프'); }
    else { reasons.push('보호·에퀴티 거부: 앞서는 경우가 많지만 역전 카드도 많아, 지금 베팅해 상대가 싸게 드로우를 보지 못하게 하는 편이 낫습니다.'); tags.push('보호'); }
  } else if (eq !== null && bestKind === 'check' && inp.toCall <= 0) {
    if (eq >= 0.65) { reasons.push('트랩: 충분히 강하지만 베팅하면 약한 핸드가 폴드합니다. 체크로 상대의 베팅·블러프를 유도하는 편이 낫습니다.'); tags.push('트랩'); }
    else if (eq >= 0.35) { reasons.push('팟 컨트롤: 쇼다운 가치는 있지만 베팅하면 더 강한 핸드에게만 콜을 받습니다. 체크로 팟을 작게 유지합니다.'); tags.push('팟 컨트롤'); }
    else { reasons.push('베팅해도 폴드시킬 수 있는 핸드가 적고 콜을 받으면 대부분 집니다. 체크가 손실을 줄입니다.'); tags.push('블러프 포기'); }
  }

  // range and nut advantage
  const mine = strongShare(inp.heroRange, inp.board);
  const theirs = strongShare(inp.villainRange, inp.board);
  if (mine !== null && theirs !== null && Math.abs(mine - theirs) >= 0.08) {
    reasons.push(`투페어 이상 강한 핸드 비율: 내 레인지 ${pct(mine, 0)} vs ${inp.villainName} ${pct(theirs, 0)}. ` +
      (mine > theirs ? '넛 우위가 내 쪽이라 크게 베팅할 명분이 있습니다.' : `넛 우위가 ${inp.villainName} 쪽이라 공격적인 라인은 줄이는 편이 좋습니다.`));
    tags.push('넛 우위');
  }

  // stack to pot
  const spr = Math.min(inp.heroBehind, inp.villainBehind) / Math.max(inp.pot, 1e-9);
  if (bestKind === 'allin' && spr <= 1.5) {
    reasons.push(`SPR ${spr.toFixed(1)}: 남은 스택이 팟보다 작아서 조금이라도 앞서면 올인이 자연스럽습니다.`);
    tags.push('SPR');
  }

  icmVsChip(inp, reasons, tags);
  mixed(inp, reasons, tags);
  return { headline: headline(inp), reasons: reasons.slice(0, 5), tags: Array.from(new Set(tags)) };
}

export function explainMultiway(inp: MultiwayCoachInput): Explanation {
  const reasons: string[] = [];
  const tags: string[] = [];
  const desc = describeHand(inp.hole, inp.board);
  reasons.push(`${inp.hand}: ${desc.made}${desc.draws.length ? ` + ${desc.draws.join(', ')}` : ''}. ${inp.players}인 팟에서 남은 상대 전체를 이길 확률 ${pct(inp.equity)}.`);
  if (inp.toCall > 0) {
    const req = inp.toCall / (inp.pot + inp.toCall);
    reasons.push(`콜에 필요한 에퀴티는 ${pct(req)}입니다. ${inp.equity >= req ? '에퀴티가 충분해 콜할 수 있습니다.' : '에퀴티가 모자라 폴드가 낫습니다.'}`);
    tags.push('팟 오즈');
  }
  if (desc.draws.length) {
    reasons.push('여러 명이 남은 팟에서는 드로우가 완성돼도 더 좋은 핸드에 질 수 있어, 헤즈업보다 드로우 가치가 낮습니다.');
    tags.push('멀티웨이');
  }
  return { headline: headline(inp), reasons, tags };
}

export type SummaryTone = 'perfect' | 'good' | 'close' | 'review' | 'none';

export interface HandSummary {
  decisions: number;
  lossBB: number;
  grade: string;
  tone: SummaryTone;
  /** every graded hero decision, in order; logIndex points into the hand log */
  items: Array<{ logIndex: number; street: string; text: string; verdict: string; lossBB: number }>;
  /** log index of the costliest decision (loss above 0.05bb), or null */
  worstIndex: number | null;
  lessons: string[];
}

const LESSONS: Record<string, string> = {
  '리스크 프리미엄': 'ICM 상황의 올인 콜은 칩 기준보다 높은 에퀴티가 필요합니다. 필요 에퀴티를 먼저 따져 보세요.',
  'ICM 압박': '칩 EV와 ICM이 다를 때는 ICM을 따르세요. 탈락을 피하는 가치가 칩보다 큽니다.',
  '버블': '버블에서는 짧은 스택일수록 생존 가치가 커서, 커버당하는 올인 콜을 좁혀야 합니다.',
  '탈락 위험': '나를 커버하는 스택을 상대로는 콜 범위를 좁히세요.',
  '래더': '짧은 스택이 남아 있으면 기다리는 것만으로 순위가 오를 수 있습니다.',
  '오픈 레인지': '포지션별 오픈 레인지를 기억하세요. 앞 포지션일수록 좁게 엽니다.',
  '팟 오즈': '팟 오즈로 필요한 에퀴티를 계산하고 상대 레인지와 비교하세요.',
  '숏스택': '짧은 스택은 레이즈-폴드보다 올인이 효율적입니다.',
  '사이징': '깊은 스택에서는 올인보다 작은 사이즈가 더 넓은 핸드에서 가치를 얻습니다.',
  '블로커': '블로커가 있는 핸드는 공격적인 라인의 좋은 후보입니다.',
  '밸류': '앞서 있을 때는 체크보다 베팅으로 가치를 뽑으세요.',
  '블러프': '쇼다운 가치가 없는 핸드는 베팅으로 폴드를 받아내는 선택지를 고려하세요.',
  '세미블러프': '드로우는 베팅으로 폴드 에퀴티와 완성 에퀴티를 함께 가져갈 수 있습니다.',
  '보호': '역전 카드가 많은 앞선 핸드는 베팅으로 보호하세요.',
  '팟 컨트롤': '중간 강도 핸드는 팟을 키우지 않는 편이 낫습니다.',
  '트랩': '아주 강한 핸드는 체크로 상대의 베팅을 유도할 수 있습니다.',
  '블러프 포기': '폴드시킬 핸드가 없는 보드에서는 블러프를 줄이세요.',
  '넛 우위': '강한 핸드 비율이 높은 쪽이 큰 사이즈로 압박합니다.',
  'SPR': 'SPR이 낮으면 앞선 핸드로 스택을 넣는 결정을 빨리 내리세요.',
  '멀티웨이': '멀티웨이 팟에서는 드로우와 약한 페어의 가치가 떨어집니다.',
};

export function summarizeHand(
  reviews: Array<{ logIndex: number; street: string; text: string; lossBB: number; verdict: string; explanation?: Explanation }>,
): HandSummary {
  const graded = reviews.filter((r) => r.verdict !== 'info');
  const lossBB = graded.reduce((s, r) => s + r.lossBB, 0);
  const worstReview = graded.reduce<(typeof graded)[number] | null>((w, r) => (r.lossBB > 0.05 && (!w || r.lossBB > w.lossBB) ? r : w), null);
  const lessonTags = new Set<string>();
  for (const r of graded) {
    if (r.verdict !== 'mistake' && r.verdict !== 'blunder' && r.verdict !== 'inaccuracy') continue;
    for (const t of r.explanation?.tags ?? []) if (LESSONS[t]) lessonTags.add(t);
  }
  const tone: SummaryTone = graded.length === 0 ? 'none' : lossBB < 0.1 ? 'perfect' : lossBB < 0.5 ? 'good' : lossBB < 2 ? 'close' : 'review';
  const grade = { none: '결정할 차례가 없었어요', perfect: '완벽해요', good: '잘했어요', close: '아쉬워요', review: '복습이 필요해요' }[tone];
  return {
    decisions: graded.length,
    lossBB,
    grade,
    tone,
    items: graded.map((r) => ({ logIndex: r.logIndex, street: r.street, text: r.text, verdict: r.verdict, lossBB: r.lossBB })),
    worstIndex: worstReview ? worstReview.logIndex : null,
    lessons: Array.from(lessonTags).slice(0, 3).map((t) => LESSONS[t]),
  };
}

export const COACH_CLASSES = NUM_CLASSES;
