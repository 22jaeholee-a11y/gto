// 프리플랍 솔브 결과에서 헤즈업 포스트플랍 시작 상태를 만드는 공유 헬퍼.
// 트레이닝 모드(실제 핸드 플레이)와 솔버 탐색기가 같은 계산을 쓰도록 한 곳에 모은다.

import type { SolverConfig } from '../config';
import { postflopRank } from '../tree';
import { COMBO_CLASS, NC } from './combos';
import type { PostflopResult } from './solver';
import type { PostflopSpot } from './tree';

/** 포스트플랍 솔브를 수행하는 주체 (워커 클라이언트 또는 테스트용 가짜). */
export interface PostflopService {
  solve(spot: PostflopSpot, ranges: [Float64Array, Float64Array], onProgress?: (fraction: number) => void): Promise<PostflopResult>;
}

/** 169 클래스 reach를 1326 콤보에 그대로 펼친다. */
export function classToComboWeights(reach: Float64Array): Float64Array {
  const out = new Float64Array(NC);
  for (let k = 0; k < NC; k++) out[k] = reach[COMBO_CLASS[k]];
  return out;
}

/** BB 앤티: 마지막 좌석만 내고 그 좌석의 스택이 상한이다. */
export function anteBySeat(config: SolverConfig): number[] {
  const n = config.stacks.length;
  return config.stacks.map((s, i) => (i === n - 1 ? Math.min(config.ante, s) : 0));
}

/** 합이 1이 되게 정규화한 상금. */
export function normalizedPayouts(config: SolverConfig): number[] {
  const total = config.payouts.reduce((a, b) => a + b, 0) || 1;
  return config.payouts.map((p) => p / total);
}

export interface PreflopExit {
  /** 테이블 좌석 번호 [OOP, IP] */
  seats: [number, number];
  /** [OOP, IP]의 1326 콤보 레인지 */
  ranges: [Float64Array, Float64Array];
  /** 프리플랍이 끝난 시점의 팟 */
  pot: number;
  /** 좌석별 남은 칩 (앤티와 프리플랍 투입액을 뺀 값) */
  base: number[];
  icm: PostflopSpot['icm'];
}

export interface PreflopExitInput {
  config: SolverConfig;
  /** 플랍 종료 노드의 participants */
  participants: number[];
  pot: number;
  /** 좌석별 프리플랍 투입액 (종료 노드의 contrib) */
  contrib: number[];
  /** 좌석 인덱스별 169 클래스 reach. participants의 좌석만 읽는다 */
  reachBySeat: Float64Array[];
}

export function preflopExit(input: PreflopExitInput): PreflopExit {
  const { config, participants, pot, contrib, reachBySeat } = input;
  if (participants.length !== 2) throw new Error('포스트플랍 솔브는 헤즈업(2인)만 지원합니다');
  const n = config.stacks.length;
  const ante = anteBySeat(config);
  const base = config.stacks.map((s, i) => s - ante[i] - contrib[i]);
  const ordered = participants.slice().sort((a, b) => postflopRank(a, n) - postflopRank(b, n)) as [number, number];
  return {
    seats: ordered,
    ranges: [classToComboWeights(reachBySeat[ordered[0]]), classToComboWeights(reachBySeat[ordered[1]])],
    pot,
    base,
    icm: {
      mode: config.mode,
      payouts: normalizedPayouts(config),
      startStacks: config.stacks.slice(),
      baseStacks: base.slice(),
      seats: ordered,
    },
  };
}
