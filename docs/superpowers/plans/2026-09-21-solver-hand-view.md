# 솔버 핸드 뷰 · 포스트플랍 탐색기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 솔버 탭에서 핸드를 먼저 고정해 포지션별 상황마다 더 나은 액션을 보고, 헤즈업 라인은 플랍·턴·리버까지 이어서 탐색할 수 있게 한다.

**Architecture:** 솔버 탭 안에 `레인지 / 핸드` 뷰 전환을 넣는다. 프리플랍 상황 열거는 순수 함수 모듈(`src/ui/situations.ts`), 포스트플랍 탐색 상태는 React 의존이 없는 클래스(`src/engine/postflop/explore.ts`)로 만들고 둘 다 vitest로 테스트한다. 프리플랍 종료 노드 → 포스트플랍 시작 상태 변환은 공유 헬퍼(`src/engine/postflop/spot.ts`)로 뽑아 트레이닝 모드와 탐색기가 같은 계산을 쓰게 한다.

**Tech Stack:** TypeScript, React 18, Vite 6, vitest 3, Web Worker (기존 `PostflopClient` 재사용)

**Spec:** `docs/superpowers/specs/2026-09-21-solver-hand-view-design.md`

## Global Constraints

- 모든 주석·UI 문구는 한국어. 코드 식별자는 영어. 기존 파일의 스타일(2칸 들여쓰기, 세미콜론, 작은따옴표)을 따른다.
- 새 런타임 의존성을 추가하지 않는다. React 테스트 라이브러리가 없으므로 **UI 컴포넌트에는 단위 테스트를 쓰지 않는다** — UI 과제의 검증은 `npx tsc -b`와 브라우저 수동 확인이다.
- 포스트플랍 솔브는 헤즈업 전용. 참가자가 2명이 아닌 플랍 종료 노드에서는 탐색기를 열지 않는다.
- 카드 표기: `card = rank * 4 + suit`, rank 0..12 = 2..A, suit 0..3 = c d h s (`src/engine/postflop/combos.ts`).
- 핸드 클래스 인덱스: 0..168, `row * 13 + col`, row/col 0 = Ace (`src/engine/cards.ts`).
- 좌석 순서: `config.stacks`는 프리플랍 액션 순서, 마지막 두 좌석이 SB·BB. 포스트플랍 순서는 `postflopRank(seat, n)`.
- ICM EV 단위는 상금 풀 지분 변화(%p), Chip EV는 bb.
- `npm test`는 항상 전부 통과해야 한다. 기존 테스트를 수정하지 않는다.
- 커밋 메시지는 영어 한 줄 요약 + 필요시 본문, 끝에 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `src/engine/postflop/spot.ts` (신규) | 클래스 reach → 1326 콤보 변환, 프리플랍 플랍 종료 노드 → 포스트플랍 시작 상태, `PostflopService` 인터페이스 |
| `src/engine/postflop/spot.test.ts` (신규) | 위 헬퍼 테스트 |
| `src/engine/postflop/explore.ts` (신규) | `PostflopExplorer` — 보드 입력·액션 진행·스트리트 전환·레인지 좁힘·솔브 캐시 |
| `src/engine/postflop/explore.test.ts` (신규) | 가짜 `PostflopService`로 탐색기 테스트 |
| `src/ui/situations.ts` (신규) | 프리플랍 상황 열거·라벨·추천 액션 판정 (순수 함수) |
| `src/ui/situations.test.ts` (신규) | 합성 트리로 열거 규칙 테스트 |
| `src/ui/coachinput.ts` (신규) | 코치 해설 입력 구성. 워커가 뺀 종료 노드 유틸리티를 ICM으로 재구성 |
| `src/ui/coachinput.test.ts` (신규) | 재구성 값을 엔진 트리의 실제 유틸리티와 대조 |
| `src/ui/HandView.tsx` (신규) | 핸드 뷰 전체 (핸드·포지션 고정 바 + 상황 목록 + 상세) |
| `src/ui/SituationList.tsx` (신규) | 상황 목록 행과 펼침 상세 |
| `src/ui/CardPicker.tsx` (신규) | 카드 선택기 |
| `src/ui/PostflopView.tsx` (신규) | 포스트플랍 탐색기 화면 |
| `src/engine/solver.ts` (수정) | `playerTemperatures`의 인자 타입을 넓혀 `LightTree`로도 호출 가능하게 |
| `src/engine/training/hand.ts` (수정) | 새 공유 헬퍼를 쓰도록 교체, `buildRangeReview` export |
| `src/ui/App.tsx` (수정) | 뷰 전환 상태, `PostflopClient` 수명 |
| `src/ui/styles.css` (수정) | 새 화면 스타일 |
| `README.md` (수정) | 구조 표·기능 설명 갱신 |

---

## Task 1: 포스트플랍 진입 공유 헬퍼

**Files:**
- Create: `src/engine/postflop/spot.ts`
- Create: `src/engine/postflop/spot.test.ts`
- Modify: `src/engine/training/hand.ts` (30행 `PostflopService` 정의, 226-236행 생성자, 512-533행 `preflopTerminal` 헤즈업 분기, 612-620행 `icmContext`, 1021-1034행 `PostflopState`, 1036-1040행 `classToComboWeights`)

**Interfaces:**
- Consumes: 없음 (첫 과제)
- Produces:
  - `classToComboWeights(reach: Float64Array): Float64Array`
  - `anteBySeat(config: SolverConfig): number[]`
  - `normalizedPayouts(config: SolverConfig): number[]`
  - `interface PostflopService { solve(spot, ranges, onProgress?): Promise<PostflopResult> }`
  - `interface PreflopExit { seats: [number, number]; ranges: [Float64Array, Float64Array]; pot: number; base: number[]; icm: PostflopSpot['icm'] }`
  - `preflopExit(input: PreflopExitInput): PreflopExit`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/engine/postflop/spot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SolverConfig } from '../config';
import { NUM_CLASSES } from '../cards';
import { CLASS_COMBOS, COMBO_CLASS, NC } from './combos';
import { anteBySeat, classToComboWeights, normalizedPayouts, preflopExit } from './spot';

const cfg = (over: Partial<SolverConfig> = {}): SolverConfig => ({ ...DEFAULT_CONFIG, ...over });

describe('classToComboWeights', () => {
  it('클래스 가중치를 그 클래스의 모든 콤보에 그대로 펼친다', () => {
    const reach = new Float64Array(NUM_CLASSES);
    reach[0] = 0.25; // AA
    reach[1] = 0.5; // AKs
    const w = classToComboWeights(reach);
    expect(w.length).toBe(NC);
    for (const k of CLASS_COMBOS[0]) expect(w[k]).toBe(0.25);
    for (const k of CLASS_COMBOS[1]) expect(w[k]).toBe(0.5);
    let others = 0;
    for (let k = 0; k < NC; k++) if (COMBO_CLASS[k] > 1) others += w[k];
    expect(others).toBe(0);
  });
});

describe('anteBySeat', () => {
  it('BB 좌석만 앤티를 내고 스택으로 상한이 걸린다', () => {
    expect(anteBySeat(cfg({ stacks: [25, 25, 25], ante: 1 }))).toEqual([0, 0, 1]);
    expect(anteBySeat(cfg({ stacks: [25, 25, 0.4], ante: 1 }))).toEqual([0, 0, 0.4]);
  });
});

describe('normalizedPayouts', () => {
  it('상금을 합이 1이 되게 정규화한다', () => {
    const p = normalizedPayouts(cfg({ payouts: [30, 20, 10] }));
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(p[0]).toBeCloseTo(0.5, 12);
    expect(p[1]).toBeCloseTo(1 / 3, 12);
    expect(p[2]).toBeCloseTo(1 / 6, 12);
  });
});

describe('preflopExit', () => {
  const base8 = cfg({ stacks: [25, 25, 25, 25, 25, 25, 25, 25], ante: 1, payouts: [30, 20, 14, 10, 8, 7, 6, 5], mode: 'icm' });
  const reachBySeat = () => {
    const r: Float64Array[] = [];
    for (let s = 0; s < 8; s++) {
      const a = new Float64Array(NUM_CLASSES);
      a.fill(s === 4 ? 0.2 : 0.7);
      r.push(a);
    }
    return r;
  };

  it('OOP(먼저 행동하는 좌석)를 앞에 두고 좌석을 정렬한다', () => {
    // 8인 테이블: CO = 4 (postflopRank 6), BB = 7 (postflopRank 1) -> BB가 OOP
    const exit = preflopExit({
      config: base8,
      participants: [4, 7],
      pot: 5,
      contrib: [0, 0, 0, 0, 2, 0, 0.5, 2],
      reachBySeat: reachBySeat(),
    });
    expect(exit.seats).toEqual([7, 4]);
    expect(exit.icm.seats).toEqual([7, 4]);
  });

  it('앤티와 프리플랍 투입액을 뺀 남은 스택을 계산한다', () => {
    const exit = preflopExit({
      config: base8,
      participants: [4, 7],
      pot: 5,
      contrib: [0, 0, 0, 0, 2, 0, 0.5, 2],
      reachBySeat: reachBySeat(),
    });
    expect(exit.base[7]).toBeCloseTo(22, 9); // 25 - 앤티 1 - 투입 2
    expect(exit.base[4]).toBeCloseTo(23, 9);
    expect(exit.base[6]).toBeCloseTo(24.5, 9);
    expect(exit.icm.baseStacks).toEqual(exit.base);
  });

  it('레인지를 OOP·IP 순서로 콤보 가중치로 펼친다', () => {
    const exit = preflopExit({
      config: base8,
      participants: [4, 7],
      pot: 5,
      contrib: [0, 0, 0, 0, 2, 0, 0.5, 2],
      reachBySeat: reachBySeat(),
    });
    expect(exit.ranges[0][0]).toBeCloseTo(0.7, 9); // BB
    expect(exit.ranges[1][0]).toBeCloseTo(0.2, 9); // CO
  });

  it('ICM 컨텍스트에 모드·정규화 상금·시작 스택을 담는다', () => {
    const exit = preflopExit({
      config: base8,
      participants: [4, 7],
      pot: 5,
      contrib: [0, 0, 0, 0, 2, 0, 0.5, 2],
      reachBySeat: reachBySeat(),
    });
    expect(exit.icm.mode).toBe('icm');
    expect(exit.icm.payouts.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(exit.icm.startStacks).toEqual(base8.stacks);
  });

  it('참가자가 2명이 아니면 거부한다', () => {
    expect(() => preflopExit({
      config: base8,
      participants: [4, 6, 7],
      pot: 6,
      contrib: [0, 0, 0, 0, 2, 0, 2, 2],
      reachBySeat: reachBySeat(),
    })).toThrow();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/engine/postflop/spot.test.ts`
Expected: FAIL — `Failed to resolve import "./spot"`

- [ ] **Step 3: 헬퍼를 구현한다**

`src/engine/postflop/spot.ts`:

```ts
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
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/engine/postflop/spot.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: `hand.ts`가 새 헬퍼를 쓰도록 바꾼다**

5-1. `src/engine/training/hand.ts` 30-32행의 `PostflopService` 정의를 지우고, 임포트 블록(10-16행 근처)에 다음을 더한다:

```ts
import { anteBySeat, classToComboWeights, normalizedPayouts, preflopExit } from '../postflop/spot';
export type { PostflopService } from '../postflop/spot';
```

(재수출이므로 `coach.test.ts`, `hand.test.ts`, `ui/training/clients.ts`의 기존 임포트는 그대로 동작한다.)

5-2. 1036-1040행의 지역 함수 `classToComboWeights`를 지운다 (임포트한 것과 이름이 겹친다).

5-3. 생성자(233-235행)의 중복 계산을 헬퍼로 바꾼다:

```ts
    this.ante = anteBySeat(cfg);
    this.payouts = normalizedPayouts(cfg);
    this.totalChips = this.startStacks.reduce((a, b) => a + b, 0);
```

5-4. `PostflopState`(1021행)에 ICM 컨텍스트를 담을 자리를 더한다:

```ts
interface PostflopState {
  seats: [number, number];
  ranges: [Float64Array, Float64Array];
  /** pot when the current street started */
  pot: number;
  /** every seat's chips behind when the current street started */
  base: number[];
  icm: PostflopSpot['icm'];
  board: number[];
  street: Street;
  tree: PostflopTree | null;
  result: PostflopResult | null;
  node: number;
  contrib: [number, number];
}
```

5-5. `preflopTerminal`의 헤즈업 분기(513-533행)를 바꾼다. 기존:

```ts
    const ordered = parts.slice().sort((a, b) => postflopRank(a, this.n) - postflopRank(b, this.n));
    const base = this.finalsAfterPreflop(t);
    const reach = ordered.map((seat) => this.preflopReach(seat));
    if (ordered.length === 2) {
      this.pf = {
        seats: [ordered[0], ordered[1]],
        ranges: reach.map((r) => classToComboWeights(r)) as [Float64Array, Float64Array],
        pot: t.pot,
        base,
        board: [],
        street: 'flop',
        tree: null,
        result: null,
        node: 0,
        contrib: [0, 0],
      };
      await this.nextPostflopStreet();
    } else {
      this.mw = new MultiwayState(ordered, reach, t.pot, base);
      await this.nextMultiwayStreet();
    }
```

새로:

```ts
    const ordered = parts.slice().sort((a, b) => postflopRank(a, this.n) - postflopRank(b, this.n));
    const base = this.finalsAfterPreflop(t);
    const reach = ordered.map((seat) => this.preflopReach(seat));
    if (ordered.length === 2) {
      const reachBySeat: Float64Array[] = this.startStacks.map(() => new Float64Array(N));
      ordered.forEach((seat, i) => { reachBySeat[seat] = reach[i]; });
      const exit = preflopExit({ config: this.sc.tree.config, participants: parts, pot: t.pot, contrib: t.contrib, reachBySeat });
      this.pf = {
        seats: exit.seats,
        ranges: exit.ranges,
        pot: exit.pot,
        base: exit.base,
        icm: exit.icm,
        board: [],
        street: 'flop',
        tree: null,
        result: null,
        node: 0,
        contrib: [0, 0],
      };
      await this.nextPostflopStreet();
    } else {
      this.mw = new MultiwayState(ordered, reach, t.pot, base);
      await this.nextMultiwayStreet();
    }
```

5-6. `icmContext`(612-620행)를 지우고, `nextPostflopStreet`(644행)에서 쓰던 자리를 `pf.icm`으로 바꾼다:

```ts
    const spot: PostflopSpot = { street: pf.street as PStreet, board: pf.board.slice(), pot: pf.pot, icm: pf.icm, sizing: DEFAULT_POSTFLOP_SIZING };
```

**주의:** `endPostflopStreet`(810-819행)는 `pf.base`를 제자리에서 줄인다. `pf.icm.baseStacks`는 **핸드 시작 시점의 값으로 고정**되어야 하므로 (기존 `icmContext`도 그 시점의 `pf.base`를 복사해 썼다) 여기서 함께 갱신해야 한다. `endPostflopStreet`의 `for` 루프 바로 뒤에 한 줄을 더한다:

```ts
    const matched = Math.min(pf.contrib[0], pf.contrib[1]);
    for (let p = 0; p < 2; p++) pf.base[pf.seats[p]] -= matched;
    pf.icm = { ...pf.icm, baseStacks: pf.base.slice() };
    pf.pot += 2 * matched;
```

- [ ] **Step 6: 전체 테스트와 타입 검사를 돌린다**

Run: `npm test`
Expected: PASS — 기존 테스트 전부 통과 (특히 `src/engine/training/hand.test.ts`, `coach.test.ts`)

Run: `npx tsc -b`
Expected: 에러 없음

- [ ] **Step 7: 커밋**

```bash
git add src/engine/postflop/spot.ts src/engine/postflop/spot.test.ts src/engine/training/hand.ts
git commit -m "Extract shared preflop-to-postflop entry helper

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 프리플랍 상황 열거

**Files:**
- Modify: `src/engine/solver.ts:771` (`playerTemperatures` 인자 타입)
- Create: `src/ui/situations.ts`
- Create: `src/ui/situations.test.ts`

**Interfaces:**
- Consumes: Task 1의 헬퍼는 쓰지 않는다. 기존 `src/ui/spot.ts`의 `actionTotals`, `freqOf`, `evOf`, `label`, `playerReach`, `rareSteps`, `TrailStep`을 쓴다.
- Produces:
  - `const MAX_HERO_DECISIONS = 2`, `MIN_REACH = 0.005`, `MAX_ROWS = 40`
  - `interface SituationOption { index: number; label: string; freq: number; evIcm: number; evChip: number }`
  - `interface Situation { path: number[]; node: LightDecision; depth: number; reach: number; label: string; options: SituationOption[]; best: number; second: number; gap: number; mixed: boolean; rare: boolean }`
  - `enumerateSituations(tree: LightTree, result: SolveResult, hero: number, hand: number): Situation[]`

- [ ] **Step 1: `playerTemperatures`의 인자 타입을 넓힌다**

`src/engine/solver.ts:771`. 이 함수는 `tree.numPlayers`와 `tree.config`만 읽으므로 `LightTree`로도 부를 수 있어야 한다. 시그니처만 바꾼다 (본문 그대로):

```ts
/** logit temperature per player in the solver's utility: bb for chip EV, ICM %p per bb of that player's stack */
export function playerTemperatures(tree: { numPlayers: number; config: SolverConfig }, tauBB: number, util: 'icm' | 'chip'): number[] {
```

`SolverConfig`는 이미 이 파일에 임포트되어 있는지 확인하고, 없으면 `import { ... type SolverConfig } from './config';`에 더한다. `GameTree`는 구조적으로 이 타입을 만족하므로 기존 호출부는 바뀌지 않는다.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`src/ui/situations.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SolverConfig } from '../engine/config';
import { NUM_CLASSES } from '../engine/cards';
import type { SolveResult } from '../engine/solver';
import type { Action } from '../engine/tree';
import type { LightDecision, LightNode, LightTerminal, LightTree } from '../worker/protocol';
import { enumerateSituations } from './situations';

const N = NUM_CLASSES;

function dec(id: number, player: number, dIndex: number, actions: Action[]): LightDecision {
  return {
    kind: 'decision', id, parent: -1, parentAction: -1, pot: 1.5,
    contrib: [0, 0], behind: [25, 25], folded: [false, false], allin: [false, false],
    player, bet: 1, actions, dIndex,
  };
}

function term(id: number): LightTerminal {
  return {
    kind: 'terminal', id, parent: -1, parentAction: -1, pot: 1.5,
    contrib: [0, 0], behind: [25, 25], folded: [false, false], allin: [false, false],
    tType: 'fold', participants: [0],
  };
}

/**
 * 히어로(좌석 0)가 세 번 행동할 수 있는 2인 트리.
 *   0: 히어로   Fold -> 9 | Raise 2 -> 1
 *   1: 상대     Fold -> 9 | Call 2 -> 9 | Raise 6 -> 2
 *   2: 히어로   Fold -> 9 | All-in 25 -> 3
 *   3: 상대     Fold -> 9 | Call 25 -> 4
 *   4: 히어로   Fold -> 9 | Call 25 -> 9      (히어로 3번째 결정: 목록에서 빠져야 한다)
 */
function buildTree(config: SolverConfig): LightTree {
  const nodes: LightNode[] = [
    dec(0, 0, 0, [{ type: 'fold', to: 0, child: 9 }, { type: 'raise', to: 2, child: 1 }]),
    dec(1, 1, 1, [{ type: 'fold', to: 0, child: 9 }, { type: 'call', to: 2, child: 9 }, { type: 'raise', to: 6, child: 2 }]),
    dec(2, 0, 2, [{ type: 'fold', to: 0, child: 9 }, { type: 'allin', to: 25, child: 3 }]),
    dec(3, 1, 3, [{ type: 'fold', to: 0, child: 9 }, { type: 'call', to: 25, child: 4 }]),
    dec(4, 0, 4, [{ type: 'fold', to: 0, child: 9 }, { type: 'call', to: 25, child: 9 }]),
    term(5), term(6), term(7), term(8), term(9),
  ];
  return { numPlayers: 2, seatNames: ['SB', 'BB'], nodes, numDecisions: 5, startIcm: [50, 50], config };
}

/** 노드별 액션 빈도와 EV를 그대로 받아 SolveResult를 만든다 (모든 클래스에 같은 값). */
function buildResult(freqByNode: number[][], evByNode: number[][]): SolveResult {
  const offsets = new Int32Array(freqByNode.length);
  let total = 0;
  freqByNode.forEach((f, d) => { offsets[d] = total; total += f.length * N; });
  const strategy = new Float32Array(total);
  const evIcm = new Float32Array(total);
  const evChip = new Float32Array(total);
  freqByNode.forEach((f, d) => {
    for (let a = 0; a < f.length; a++) {
      for (let h = 0; h < N; h++) {
        strategy[offsets[d] + a * N + h] = f[a];
        evIcm[offsets[d] + a * N + h] = evByNode[d][a];
        evChip[offsets[d] + a * N + h] = evByNode[d][a];
      }
    }
  });
  return { offsets, strategy, evIcm, evChip, rootIcm: [0, 0], rootChip: [0, 0], exploitability: 0, iterations: 400 };
}

const config = (over: Partial<SolverConfig> = {}): SolverConfig =>
  ({ ...DEFAULT_CONFIG, stacks: [25, 25], payouts: [60, 40], mode: 'chip', smoothing: 0.15, ...over });

/** 모든 노드에서 액션이 고르게 갈리고, EV는 뒤쪽 액션이 확실히 높은 기본 세트. */
function defaults() {
  return {
    freq: [[0.5, 0.5], [0.4, 0.3, 0.3], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]],
    ev: [[-1, 1], [-1, 0, 1], [-1, 1], [-1, 1], [-1, 1]],
  };
}

describe('enumerateSituations', () => {
  it('히어로가 세 번째로 행동하는 노드는 목록에 넣지 않는다', () => {
    const { freq, ev } = defaults();
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    const ids = out.map((s) => s.node.id);
    expect(ids).toContain(0);
    expect(ids).toContain(2);
    expect(ids).not.toContain(4);
  });

  it('도달 확률이 임계값 미만인 라인은 제외한다', () => {
    const { freq, ev } = defaults();
    freq[1] = [0.999, 0.0005, 0.0005]; // 상대가 거의 항상 폴드 -> 노드 2에 도달하지 못함
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    expect(out.map((s) => s.node.id)).toEqual([0]);
  });

  it('첫 결정의 도달 확률은 1이고 깊이는 0이다', () => {
    const { freq, ev } = defaults();
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    const first = out.find((s) => s.node.id === 0)!;
    expect(first.reach).toBeCloseTo(1, 9);
    expect(first.depth).toBe(0);
    expect(first.path).toEqual([]);
    expect(first.label).toBe('첫 액션');
  });

  it('경로 라벨에 내 액션과 상대 액션을 순서대로 담는다', () => {
    const { freq, ev } = defaults();
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    const second = out.find((s) => s.node.id === 2)!;
    expect(second.depth).toBe(1);
    expect(second.path).toEqual([1, 2]);
    expect(second.label).toBe('내 Raise 2 → BB Raise 6');
  });

  it('주 단위 EV가 가장 높은 액션을 best로 고른다', () => {
    const { freq, ev } = defaults();
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    const first = out.find((s) => s.node.id === 0)!;
    expect(first.best).toBe(1);
    expect(first.second).toBe(0);
    expect(first.gap).toBeCloseTo(2, 9);
    expect(first.mixed).toBe(false);
  });

  it('EV 차이가 smoothing 이내이면 혼합으로 판정한다', () => {
    const { freq, ev } = defaults();
    ev[0] = [0.0, 0.05]; // 0.05bb 차이 < smoothing 0.15bb
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    const first = out.find((s) => s.node.id === 0)!;
    expect(first.gap).toBeCloseTo(0.05, 9);
    expect(first.mixed).toBe(true);
  });

  it('ICM 모드에서는 EV를 evIcm으로 읽는다', () => {
    const { freq, ev } = defaults();
    const res = buildResult(freq, ev);
    // ICM 배열만 순서를 뒤집어, 어느 배열을 읽는지 구분한다
    for (let i = 0; i < res.evIcm.length; i++) res.evIcm[i] = -res.evChip[i];
    const out = enumerateSituations(buildTree(config({ mode: 'icm' })), res, 0, 0);
    const first = out.find((s) => s.node.id === 0)!;
    expect(first.best).toBe(0);
  });

  it('깊이 다음으로 도달 확률 내림차순으로 정렬한다', () => {
    const { freq, ev } = defaults();
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].depth).toBeGreaterThanOrEqual(out[i - 1].depth);
      if (out[i].depth === out[i - 1].depth) expect(out[i].reach).toBeLessThanOrEqual(out[i - 1].reach);
    }
  });

  it('선택한 핸드의 빈도로 히어로 자신의 앞선 액션을 가중한다', () => {
    const { freq, ev } = defaults();
    const res = buildResult(freq, ev);
    // 클래스 5에서만 히어로가 루트에서 Raise를 20%만 쓴다
    res.strategy[res.offsets[0] + 0 * N + 5] = 0.8;
    res.strategy[res.offsets[0] + 1 * N + 5] = 0.2;
    const out = enumerateSituations(buildTree(config()), res, 0, 5);
    const second = out.find((s) => s.node.id === 2)!;
    expect(second.reach).toBeCloseTo(0.2 * 0.3, 9); // 내 레이즈 0.2 × 상대 3벳 0.3
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `npx vitest run src/ui/situations.test.ts`
Expected: FAIL — `Failed to resolve import "./situations"`

- [ ] **Step 4: 구현한다**

`src/ui/situations.ts`:

```ts
// 선택한 핸드가 특정 좌석에서 마주치는 프리플랍 상황을 열거한다.
// 화면에 의존하지 않는 순수 함수라서 테스트할 수 있다.

import type { SolveResult } from '../engine/solver';
import { playerTemperatures } from '../engine/solver';
import type { LightDecision, LightTree } from '../worker/protocol';
import { actionTotals, evOf, freqOf, label, playerReach, rareSteps, type TrailStep } from './spot';

/** 히어로가 이 횟수만큼 이미 행동한 경로는 더 내려가지 않는다. */
export const MAX_HERO_DECISIONS = 2;
/** 선택한 핸드 기준 도달 확률이 이 값 미만이면 숨긴다 (희소 라인은 EV가 불안정하다). */
export const MIN_REACH = 0.005;
/** 한 번에 보여주는 최대 행 수. */
export const MAX_ROWS = 40;

export interface SituationOption {
  index: number;
  label: string;
  freq: number;
  evIcm: number;
  evChip: number;
}

export interface Situation {
  /** 루트에서 이 결정 노드까지의 액션 인덱스 */
  path: number[];
  node: LightDecision;
  /** 이 경로에서 히어로가 이미 행동한 횟수 */
  depth: number;
  /** 선택한 핸드를 들고 이 노드에 도달할 확률 */
  reach: number;
  label: string;
  options: SituationOption[];
  /** 주 단위 EV가 가장 높은 액션의 인덱스 */
  best: number;
  /** 2등 액션의 인덱스, 액션이 하나뿐이면 -1 */
  second: number;
  /** best와 second의 EV 차이 (주 단위) */
  gap: number;
  /** 차이가 솔버의 smoothing 온도 이내라 사실상 동등한가 */
  mixed: boolean;
  /** 경로에 균형 전략이 거의 쓰지 않는 액션이 있는가 */
  rare: boolean;
}

function num(x: number): number {
  return Number.isFinite(x) ? x : -Infinity;
}

/** 경로를 한 줄로 압축한다. 폴드는 생략하고 마지막에 한 번만 알린다. */
function pathLabel(tree: LightTree, trail: TrailStep[], hero: number): string {
  const parts: string[] = [];
  let folded = false;
  for (const { node, action } of trail) {
    const a = node.actions[action];
    if (a.type === 'fold') { folded = true; continue; }
    const name = node.player === hero ? '내' : tree.seatNames[node.player];
    parts.push(`${name} ${label(a, node)}`);
  }
  if (parts.length === 0) return folded ? '첫 액션 · 나머지 폴드' : '첫 액션';
  return parts.join(' → ') + (folded ? ' · 나머지 폴드' : '');
}

function buildSituation(
  tree: LightTree, result: SolveResult, node: LightDecision,
  path: number[], trail: TrailStep[], depth: number, reach: number,
  hand: number, hero: number, tau: number,
): Situation {
  const options: SituationOption[] = node.actions.map((a, i) => ({
    index: i,
    label: label(a, node),
    freq: freqOf(result, node, i, hand),
    evIcm: evOf(result.evIcm, result, node, i, hand),
    evChip: evOf(result.evChip, result, node, i, hand),
  }));
  const key = tree.config.mode === 'icm' ? 'evIcm' : 'evChip';
  let best = 0;
  for (let i = 1; i < options.length; i++) if (num(options[i][key]) > num(options[best][key])) best = i;
  let second = -1;
  for (let i = 0; i < options.length; i++) {
    if (i === best) continue;
    if (second < 0 || num(options[i][key]) > num(options[second][key])) second = i;
  }
  const gap = second >= 0 ? num(options[best][key]) - num(options[second][key]) : 0;
  return {
    path, node, depth, reach,
    label: pathLabel(tree, trail, hero),
    options, best, second,
    gap: Number.isFinite(gap) ? gap : 0,
    mixed: second >= 0 && Number.isFinite(gap) && gap <= tau,
    rare: rareSteps(result, trail).length > 0,
  };
}

export function enumerateSituations(tree: LightTree, result: SolveResult, hero: number, hand: number): Situation[] {
  const out: Situation[] = [];
  const tauBB = tree.config.smoothing ?? 0;
  const tau = playerTemperatures(tree, tauBB, tree.config.mode)[hero];
  const trail: TrailStep[] = [];
  const path: number[] = [];

  const visit = (id: number, depth: number, reach: number): void => {
    const node = tree.nodes[id];
    if (node.kind !== 'decision') return;
    if (node.player === hero) {
      if (depth >= MAX_HERO_DECISIONS) return;
      out.push(buildSituation(tree, result, node, path.slice(), trail.slice(), depth, reach, hand, hero, tau));
    }
    // 상대 좌석은 레인지 전체의 빈도, 히어로 자신은 선택한 핸드의 빈도로 가중한다
    const freqs = node.player === hero
      ? node.actions.map((_, a) => freqOf(result, node, a, hand))
      : actionTotals(result, node, playerReach(result, trail, node.player)).freq;
    for (let a = 0; a < node.actions.length; a++) {
      const next = reach * freqs[a];
      if (next < MIN_REACH) continue;
      trail.push({ node, action: a });
      path.push(a);
      visit(node.actions[a].child, node.player === hero ? depth + 1 : depth, next);
      path.pop();
      trail.pop();
    }
  };

  visit(0, 0, 1);
  out.sort((x, y) => x.depth - y.depth || y.reach - x.reach);
  return out;
}
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/ui/situations.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: 전체 테스트와 타입 검사**

Run: `npm test`
Expected: PASS

Run: `npx tsc -b`
Expected: 에러 없음

- [ ] **Step 7: 커밋**

```bash
git add src/engine/solver.ts src/ui/situations.ts src/ui/situations.test.ts
git commit -m "Add preflop situation enumeration for a fixed hand

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 포스트플랍 탐색기 엔진

**Files:**
- Create: `src/engine/postflop/explore.ts`
- Create: `src/engine/postflop/explore.test.ts`

**Interfaces:**
- Consumes: Task 1의 `PreflopExit`, `PostflopService` (`./spot`)
- Produces:
  - `interface ExploreState { status; street; board; needed; pot; node; tree; result; ranges; contrib; progress; ending; error }`
  - `class PostflopExplorer { constructor(exit: PreflopExit, heroSeat: number, service: PostflopService); readonly heroPlayer: 0 | 1; get state(): ExploreState; subscribe(fn: () => void): () => void; seatOf(p: 0 | 1): number; deadCards(): number[]; setCards(cards: number[]): Promise<void>; setHeroCombo(combo: number): Promise<void>; act(action: number): Promise<void>; undo(): Promise<void>; canUndo(): boolean }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/engine/postflop/explore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SolverConfig } from '../config';
import { NUM_CLASSES } from '../cards';
import { COMBO_INDEX, NC, parseCard } from './combos';
import { PostflopExplorer } from './explore';
import { preflopExit, type PostflopService, type PreflopExit } from './spot';
import type { PostflopResult } from './solver';
import { buildPostflopTree, DEFAULT_POSTFLOP_SIZING, type PDecision, type PostflopSpot } from './tree';

/** 모든 결정 노드에서 액션을 고르게 섞는 가짜 솔버. 호출 횟수를 센다. */
class FakeService implements PostflopService {
  calls = 0;
  lastRanges: [Float64Array, Float64Array] | null = null;

  solve(spot: PostflopSpot, ranges: [Float64Array, Float64Array]): Promise<PostflopResult> {
    this.calls++;
    this.lastRanges = [ranges[0].slice(), ranges[1].slice()];
    const tree = buildPostflopTree(spot);
    const nodeIds: number[] = [];
    for (const nd of tree.nodes) if (nd.kind === 'decision' && nd.root) nodeIds.push(nd.id);
    const strategy: Float32Array[] = [];
    const evIcm: Float32Array[] = [];
    const evChip: Float32Array[] = [];
    for (const id of nodeIds) {
      const nd = tree.nodes[id] as PDecision;
      const A = nd.actions.length;
      const s = new Float32Array(A * NC).fill(1 / A);
      const e = new Float32Array(A * NC);
      for (let a = 0; a < A; a++) for (let k = 0; k < NC; k++) e[a * NC + k] = a;
      strategy.push(s);
      evIcm.push(e);
      evChip.push(e.slice());
    }
    return Promise.resolve({ nodeIds, strategy, evIcm, evChip, exploitability: 0, iterations: 100 });
  }
}

const cfg: SolverConfig = { ...DEFAULT_CONFIG, stacks: [25, 25, 25, 25, 25, 25, 25, 25], mode: 'chip' };

function exitOf(): PreflopExit {
  const reachBySeat = Array.from({ length: 8 }, () => {
    const a = new Float64Array(NUM_CLASSES);
    a.fill(0.5);
    return a;
  });
  return preflopExit({ config: cfg, participants: [4, 7], pot: 5, contrib: [0, 0, 0, 0, 2, 0, 0.5, 2], reachBySeat });
}

const flop = ['2c', '7d', 'Ts'].map(parseCard);
const heroCombo = COMBO_INDEX[parseCard('As') * 52 + parseCard('Kh')];

describe('PostflopExplorer', () => {
  it('시작할 때 플랍 3장을 요구한다', () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    expect(ex.state.status).toBe('need-cards');
    expect(ex.state.street).toBe('flop');
    expect(ex.state.needed).toBe(3);
    expect(ex.heroPlayer).toBe(0); // BB가 OOP
  });

  it('플랍을 받으면 솔브하고 준비 상태가 된다', async () => {
    const svc = new FakeService();
    const ex = new PostflopExplorer(exitOf(), 7, svc);
    await ex.setCards(flop);
    expect(svc.calls).toBe(1);
    expect(ex.state.status).toBe('ready');
    expect(ex.state.board).toEqual(flop);
    expect(ex.state.result).not.toBeNull();
  });

  it('히어로 콤보를 레인지에 남겨 솔버가 전략을 내게 한다', async () => {
    const svc = new FakeService();
    const ex = new PostflopExplorer(exitOf(), 7, svc);
    await ex.setHeroCombo(heroCombo);
    await ex.setCards(flop);
    expect(svc.lastRanges![0][heroCombo]).toBeGreaterThan(0);
  });

  it('액션을 진행하면 그 플레이어의 레인지가 전략만큼 좁혀진다', async () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    await ex.setCards(flop);
    const before = ex.state.ranges[0].slice();
    const node = ex.state.tree!.nodes[ex.state.node] as PDecision;
    const A = node.actions.length;
    await ex.act(0);
    const after = ex.state.ranges[0];
    let live = 0;
    for (let k = 0; k < NC; k++) if (before[k] > 0) { expect(after[k]).toBeCloseTo(before[k] / A, 9); live++; }
    expect(live).toBeGreaterThan(0);
  });

  it('체크-체크로 스트리트가 끝나면 다음 카드를 요구한다', async () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    await ex.setCards(flop);
    const check = (nd: PDecision) => nd.actions.findIndex((a) => a.type === 'check');
    await ex.act(check(ex.state.tree!.nodes[ex.state.node] as PDecision));
    await ex.act(check(ex.state.tree!.nodes[ex.state.node] as PDecision));
    expect(ex.state.status).toBe('need-cards');
    expect(ex.state.street).toBe('turn');
    expect(ex.state.needed).toBe(1);
  });

  it('턴 카드를 받으면 좁혀진 레인지로 다시 솔브한다', async () => {
    const svc = new FakeService();
    const ex = new PostflopExplorer(exitOf(), 7, svc);
    await ex.setCards(flop);
    const check = (nd: PDecision) => nd.actions.findIndex((a) => a.type === 'check');
    await ex.act(check(ex.state.tree!.nodes[ex.state.node] as PDecision));
    await ex.act(check(ex.state.tree!.nodes[ex.state.node] as PDecision));
    await ex.setCards([parseCard('3h')]);
    expect(svc.calls).toBe(2);
    expect(ex.state.status).toBe('ready');
    expect(ex.state.board.length).toBe(4);
  });

  it('폴드로 라인이 끝나면 승자를 알린다', async () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    await ex.setCards(flop);
    const oop = ex.state.tree!.nodes[ex.state.node] as PDecision;
    const bet = oop.actions.findIndex((a) => a.type === 'bet');
    await ex.act(bet);
    const ip = ex.state.tree!.nodes[ex.state.node] as PDecision;
    await ex.act(ip.actions.findIndex((a) => a.type === 'fold'));
    expect(ex.state.status).toBe('done');
    expect(ex.state.ending).toEqual({ kind: 'fold', winner: 0 });
  });

  it('양쪽이 올인이면 카드를 더 받지 않고 런아웃으로 끝낸다', async () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    await ex.setCards(flop);
    const oop = ex.state.tree!.nodes[ex.state.node] as PDecision;
    await ex.act(oop.actions.findIndex((a) => a.type === 'allin'));
    const ip = ex.state.tree!.nodes[ex.state.node] as PDecision;
    await ex.act(ip.actions.findIndex((a) => a.type === 'call'));
    expect(ex.state.status).toBe('done');
    expect(ex.state.ending).toEqual({ kind: 'showdown', runout: true });
  });

  it('되돌린 뒤 같은 액션을 다시 고르면 솔브를 반복하지 않는다', async () => {
    const svc = new FakeService();
    const ex = new PostflopExplorer(exitOf(), 7, svc);
    await ex.setCards(flop);
    const check = (nd: PDecision) => nd.actions.findIndex((a) => a.type === 'check');
    await ex.act(check(ex.state.tree!.nodes[ex.state.node] as PDecision));
    await ex.act(check(ex.state.tree!.nodes[ex.state.node] as PDecision));
    await ex.setCards([parseCard('3h')]);
    expect(svc.calls).toBe(2);
    await ex.undo(); // 턴 솔브 이전으로
    await ex.setCards([parseCard('3h')]);
    expect(svc.calls).toBe(2); // 캐시 적중
  });

  it('보드와 히어로 카드가 겹치지 않도록 dead 카드를 알려준다', async () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    await ex.setHeroCombo(heroCombo);
    await ex.setCards(flop);
    const dead = ex.deadCards();
    for (const c of flop) expect(dead).toContain(c);
    expect(dead).toContain(parseCard('As'));
    expect(dead).toContain(parseCard('Kh'));
  });

  it('상태가 바뀔 때 구독자를 부른다', async () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    let n = 0;
    const off = ex.subscribe(() => { n++; });
    await ex.setCards(flop);
    expect(n).toBeGreaterThan(0);
    off();
    const before = n;
    await ex.act(0);
    expect(n).toBe(before);
  });
});

// 사이즈 세트가 기본값인지 확인해 테스트가 트리 모양 가정에 기대는 것을 드러낸다
it('기본 사이즈 세트를 쓴다', () => {
  expect(DEFAULT_POSTFLOP_SIZING.flop.bets.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/engine/postflop/explore.test.ts`
Expected: FAIL — `Failed to resolve import "./explore"`

- [ ] **Step 3: 구현한다**

`src/engine/postflop/explore.ts`:

```ts
// 솔버 탭의 헤즈업 포스트플랍 탐색기.
// 보드를 직접 받고, 양쪽 액션을 사용자가 고르며, 스트리트마다 좁혀진 레인지로 다시 솔브한다.
// 트레이닝 모드와 달리 딜링도 봇도 없다.

import { COMBO_C1, COMBO_C2, NC } from './combos';
import type { PostflopResult } from './solver';
import type { PostflopService, PreflopExit } from './spot';
import {
  buildPostflopTree, DEFAULT_POSTFLOP_SIZING,
  type PDecision, type PostflopSpot, type PostflopTree, type Street,
} from './tree';

const CARDS_NEEDED: Record<Street, number> = { flop: 3, turn: 1, river: 1 };
const CACHE_LIMIT = 8;

/** runout: 리버 전에 양쪽이 올인이라 남은 보드가 그냥 깔리는 경우 */
export type Ending = { kind: 'fold'; winner: 0 | 1 } | { kind: 'showdown'; runout: boolean } | null;

export interface ExploreState {
  /** need-cards: 다음 스트리트 카드를 기다림 / solving / ready / done */
  status: 'need-cards' | 'solving' | 'ready' | 'done';
  street: Street;
  board: number[];
  /** 지금 필요한 카드 장수 (status가 need-cards일 때만 의미 있음) */
  needed: number;
  /** 현재 스트리트가 시작될 때의 팟 */
  pot: number;
  node: number;
  tree: PostflopTree | null;
  result: PostflopResult | null;
  ranges: [Float64Array, Float64Array];
  contrib: [number, number];
  progress: number;
  ending: Ending;
  error: string | null;
}

interface Snapshot {
  status: ExploreState['status'];
  street: Street;
  board: number[];
  pot: number;
  node: number;
  tree: PostflopTree | null;
  result: PostflopResult | null;
  ranges: [Float64Array, Float64Array];
  contrib: [number, number];
  base: number[];
  baseStacks: number[];
  /** 지금까지 고른 액션들 (솔브 캐시 키의 일부) */
  actionKey: string;
  ending: Ending;
}

export class PostflopExplorer {
  readonly heroPlayer: 0 | 1;
  private exit: PreflopExit;
  private service: PostflopService;
  private listeners = new Set<() => void>();
  private cache = new Map<string, PostflopResult>();
  private history: Snapshot[] = [];
  private heroCombo: number | null = null;
  private v: ExploreState;
  /** 현재 스트리트 시작 시점의 좌석별 남은 칩 */
  private base: number[];
  private baseStacks: number[];
  /** 지금까지 고른 액션들. 보드와 합쳐 솔브 캐시 키를 만든다 (제자리 누적 금지) */
  private actionKey = '';

  constructor(exit: PreflopExit, heroSeat: number, service: PostflopService) {
    this.exit = exit;
    this.service = service;
    this.heroPlayer = exit.seats[0] === heroSeat ? 0 : 1;
    this.base = exit.base.slice();
    this.baseStacks = exit.icm.baseStacks.slice();
    this.v = {
      status: 'need-cards',
      street: 'flop',
      board: [],
      needed: 3,
      pot: exit.pot,
      node: 0,
      tree: null,
      result: null,
      ranges: [exit.ranges[0].slice(), exit.ranges[1].slice()],
      contrib: [0, 0],
      progress: 0,
      ending: null,
      error: null,
    };
  }

  get state(): ExploreState {
    return this.v;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  /** 포스트플랍 플레이어 번호(0 = OOP)를 테이블 좌석 번호로 바꾼다. */
  seatOf(p: 0 | 1): number {
    return this.exit.seats[p];
  }

  /** 보드와 히어로 카드 — 카드 선택기에서 고를 수 없는 카드들. */
  deadCards(): number[] {
    const out = this.v.board.slice();
    if (this.heroCombo !== null) out.push(COMBO_C1[this.heroCombo], COMBO_C2[this.heroCombo]);
    return out;
  }

  private emit(patch: Partial<ExploreState>): void {
    this.v = { ...this.v, ...patch };
    for (const fn of this.listeners) fn();
  }

  private snapshot(): Snapshot {
    return {
      status: this.v.status,
      street: this.v.street,
      board: this.v.board.slice(),
      pot: this.v.pot,
      node: this.v.node,
      tree: this.v.tree,
      result: this.v.result,
      ranges: [this.v.ranges[0].slice(), this.v.ranges[1].slice()],
      contrib: [this.v.contrib[0], this.v.contrib[1]],
      base: this.base.slice(),
      baseStacks: this.baseStacks.slice(),
      actionKey: this.actionKey,
      ending: this.v.ending,
    };
  }

  private restore(s: Snapshot): void {
    this.base = s.base;
    this.baseStacks = s.baseStacks;
    this.actionKey = s.actionKey;
    this.emit({
      status: s.status, street: s.street, board: s.board, needed: CARDS_NEEDED[s.street],
      pot: s.pot, node: s.node, tree: s.tree, result: s.result, ranges: s.ranges,
      contrib: s.contrib, ending: s.ending, progress: s.status === 'ready' ? 1 : 0, error: null,
    });
  }

  /** 히어로 콤보를 바꾼다. 이미 솔브했으면 현재 스트리트를 다시 푼다. */
  async setHeroCombo(combo: number): Promise<void> {
    if (this.heroCombo === combo) return;
    this.heroCombo = combo;
    this.cache.clear();
    if (this.v.status === 'ready' || this.v.status === 'done') await this.solveStreet();
  }

  /** 현재 스트리트에 필요한 카드를 넘긴다 (플랍 3장, 턴·리버 1장). */
  async setCards(cards: number[]): Promise<void> {
    if (this.v.status !== 'need-cards') return;
    const need = CARDS_NEEDED[this.v.street];
    if (cards.length !== need) {
      this.emit({ error: `${need}장을 골라주세요` });
      return;
    }
    const dead = new Set(this.deadCards());
    for (const c of cards) {
      if (dead.has(c)) { this.emit({ error: '이미 쓰인 카드입니다' }); return; }
      dead.add(c);
    }
    this.history.push(this.snapshot());
    this.emit({ board: [...this.v.board, ...cards], error: null });
    await this.solveStreet();
  }

  private async solveStreet(): Promise<void> {
    // 히어로 콤보를 레인지에 남겨 솔버가 그 콤보의 전략을 내게 한다
    const ranges: [Float64Array, Float64Array] = [this.v.ranges[0].slice(), this.v.ranges[1].slice()];
    if (this.heroCombo !== null && ranges[this.heroPlayer][this.heroCombo] < 1e-5) {
      ranges[this.heroPlayer][this.heroCombo] = 1e-5;
    }
    const spot: PostflopSpot = {
      street: this.v.street,
      board: this.v.board.slice(),
      pot: this.v.pot,
      icm: { ...this.exit.icm, baseStacks: this.baseStacks.slice() },
      sizing: DEFAULT_POSTFLOP_SIZING,
    };
    const tree = buildPostflopTree(spot);
    const key = `${this.v.board.join(',')}|${this.actionKey}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);       // 다시 넣어 최근 사용으로 올린다 (LRU)
      this.cache.set(key, cached);
      this.emit({ tree, result: cached, node: 0, contrib: [0, 0], status: 'ready', progress: 1 });
      return this.advance();
    }
    this.emit({ tree, status: 'solving', progress: 0, node: 0, contrib: [0, 0] });
    try {
      const result = await this.service.solve(spot, ranges, (x) => this.emit({ progress: x }));
      this.cache.set(key, result);
      if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
      this.emit({ result, status: 'ready', progress: 1 });
      await this.advance();
    } catch (e) {
      this.emit({ status: 'need-cards', error: e instanceof Error ? e.message : '포스트플랍 솔브 실패', board: this.v.board.slice(0, this.v.board.length - CARDS_NEEDED[this.v.street]) });
    }
  }

  /** 현재 노드가 결정이 아니면 스트리트를 닫거나 라인을 끝낸다. */
  private async advance(): Promise<void> {
    const tree = this.v.tree;
    if (!tree) return;
    const nd = tree.nodes[this.v.node];
    if (nd.kind === 'decision') return;
    if (nd.kind === 'terminal' && nd.tType === 'fold') {
      this.emit({ status: 'done', ending: { kind: 'fold', winner: nd.winner as 0 | 1 } });
      return;
    }
    // chance / showdown / equity: 이번 스트리트의 베팅이 끝났다
    await this.closeStreet();
  }

  private async closeStreet(): Promise<void> {
    const matched = Math.min(this.v.contrib[0], this.v.contrib[1]);
    const base = this.base.slice();
    for (let p = 0; p < 2; p++) base[this.exit.seats[p]] -= matched;
    this.base = base;
    this.baseStacks = base.slice();
    const pot = this.v.pot + 2 * matched;
    // 양쪽이 올인이면 남은 보드는 런아웃이라 더 솔브할 것이 없다
    const chipsLeft = base[this.exit.seats[0]] > 1e-9 && base[this.exit.seats[1]] > 1e-9;
    if (this.v.street === 'river' || !chipsLeft) {
      this.emit({ status: 'done', ending: { kind: 'showdown', runout: this.v.street !== 'river' }, pot });
      return;
    }
    const next: Street = this.v.street === 'flop' ? 'turn' : 'river';
    this.emit({ status: 'need-cards', street: next, needed: CARDS_NEEDED[next], pot, contrib: [0, 0], node: 0, tree: null, result: null });
  }

  /** 현재 결정 노드에서 액션 하나를 고른다. 그 플레이어의 레인지를 전략만큼 좁힌다. */
  async act(action: number): Promise<void> {
    if (this.v.status !== 'ready') return;
    const tree = this.v.tree;
    const result = this.v.result;
    if (!tree || !result) return;
    const nd = tree.nodes[this.v.node];
    if (nd.kind !== 'decision') return;
    const a = nd.actions[action];
    if (!a) return;

    this.history.push(this.snapshot());

    const idx = result.nodeIds.indexOf(nd.id);
    const strat = result.strategy[idx];
    const ranges: [Float64Array, Float64Array] = [this.v.ranges[0].slice(), this.v.ranges[1].slice()];
    const range = ranges[nd.player];
    let after = 0;
    for (let k = 0; k < NC; k++) {
      range[k] *= strat[action * NC + k];
      after += range[k];
    }
    // 솔버가 거의 쓰지 않는 액션이라 레인지가 비면 균등 레인지로 되살린다 (이후 EV는 참고용)
    if (after <= 0) for (let k = 0; k < NC; k++) range[k] = 1e-6;

    const contrib: [number, number] = [this.v.contrib[0], this.v.contrib[1]];
    contrib[nd.player] = a.to;
    this.actionKey = `${this.actionKey}|${nd.id}:${action}`;
    this.emit({ ranges, contrib, node: a.child });
    await this.advance();
  }

  async undo(): Promise<void> {
    const s = this.history.pop();
    if (!s) return;
    this.restore(s);
  }
}
```

**주의 (구현자용):** 캐시 키는 `solveStreet`에서 `보드 + actionKey`로 **매번 새로 계산**한다. 필드에 누적하면 같은 스트리트를 다시 풀 때(예: `setHeroCombo`) 키가 계속 길어져 캐시가 절대 맞지 않는다. `snapshot`/`restore`가 `actionKey`를 함께 저장·복원하므로 되돌린 뒤 같은 경로를 다시 밟으면 같은 키가 나온다. 테스트 "되돌린 뒤 같은 액션을 다시 고르면 솔브를 반복하지 않는다"가 이것을 검증한다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/engine/postflop/explore.test.ts`
Expected: PASS (12 tests)

실패하면 가짜 솔버가 만드는 트리 모양(`DEFAULT_POSTFLOP_SIZING`)에서 어떤 액션 타입이 실제로 있는지 먼저 확인한다:

```bash
npx vitest run src/engine/postflop/explore.test.ts -t '플랍을 받으면'
```

- [ ] **Step 5: 전체 테스트와 타입 검사**

Run: `npm test`
Expected: PASS

Run: `npx tsc -b`
Expected: 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add src/engine/postflop/explore.ts src/engine/postflop/explore.test.ts
git commit -m "Add heads-up postflop explorer engine

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 프리플랍 코치 해설 입력 빌더

워커가 UI로 보내는 `LightTerminal`은 payload를 줄이려고 `utilIcm`·`utilChip`·`outcomes`를 빼고 온다.
그래서 코치 해설에서 가장 유용한 "콜하려면 에퀴티가 몇 % 필요한가" 문단을 솔버 탭에서는 바로 만들 수 없다.
헤즈업 올인 쇼다운의 승·패 결과를 엔진과 **똑같은 식**으로 다시 계산해 채운다.

**Files:**
- Create: `src/ui/coachinput.ts`
- Create: `src/ui/coachinput.test.ts`

**Interfaces:**
- Consumes: Task 1의 `anteBySeat`, `normalizedPayouts` (`../engine/postflop/spot`), 기존 `distributeSidePots`·`icmEquity`, 기존 `src/ui/spot.ts`
- Produces:
  - `showdownUtilities(tree: LightTree, terminal: LightTerminal, hero: number): { winIcm: number; loseIcm: number; winChip: number; loseChip: number } | null`
  - `requiredEquity(tree: LightTree, result: SolveResult, node: LightDecision, hand: number, hero: number): { chip: number | null; icm: number | null }`
  - `buildPreflopCoachInput(tree: LightTree, result: SolveResult, trail: TrailStep[], node: LightDecision, hand: number, chosen: number, best: number): PreflopCoachInput`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/ui/coachinput.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SolverConfig } from '../engine/config';
import { buildTree, type TerminalNode } from '../engine/tree';
import type { LightTerminal, LightTree } from '../worker/protocol';
import { showdownUtilities } from './coachinput';

/** 엔진 트리를 워커가 보내는 모양으로 깎는다 (utilIcm 등 제거). */
function lighten(tree: ReturnType<typeof buildTree>): LightTree {
  return {
    numPlayers: tree.numPlayers,
    seatNames: tree.seatNames,
    numDecisions: tree.numDecisions,
    startIcm: tree.startIcm,
    config: tree.config,
    nodes: tree.nodes.map((nd) => {
      if (nd.kind === 'decision') return nd;
      const { utilIcm, utilChip, outcomes, eqr, playScale, ...rest } = nd;
      void utilIcm; void utilChip; void outcomes; void eqr; void playScale;
      return rest as LightTerminal;
    }),
  };
}

const cfg = (over: Partial<SolverConfig> = {}): SolverConfig =>
  ({ ...DEFAULT_CONFIG, stacks: [10, 12, 8], payouts: [50, 30, 20], ante: 1, pushFoldOnly: true, mode: 'icm', ...over });

describe('showdownUtilities', () => {
  it('헤즈업 올인 쇼다운의 승·패 값을 엔진과 같게 재구성한다', () => {
    const full = buildTree(cfg());
    const light = lighten(full);
    const showdowns = full.nodes.filter(
      (nd): nd is TerminalNode => nd.kind === 'terminal' && nd.tType === 'showdown' && nd.participants.length === 2,
    );
    expect(showdowns.length).toBeGreaterThan(0);

    for (const t of showdowns) {
      const hero = t.participants[0];
      const n = full.numPlayers;
      const oWin = t.outcomes.findIndex((o) => o[0] === hero);
      const oLose = 1 - oWin;
      const got = showdownUtilities(light, light.nodes[t.id] as LightTerminal, hero)!;
      expect(got.winIcm).toBeCloseTo(t.utilIcm[oWin * n + hero], 9);
      expect(got.loseIcm).toBeCloseTo(t.utilIcm[oLose * n + hero], 9);
      expect(got.winChip).toBeCloseTo(t.utilChip[oWin * n + hero], 9);
      expect(got.loseChip).toBeCloseTo(t.utilChip[oLose * n + hero], 9);
    }
  });

  it('참가자가 2명이 아니거나 쇼다운이 아니면 null을 준다', () => {
    const full = buildTree(cfg());
    const light = lighten(full);
    const fold = full.nodes.find((nd) => nd.kind === 'terminal' && nd.tType === 'fold')!;
    expect(showdownUtilities(light, light.nodes[fold.id] as LightTerminal, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/ui/coachinput.test.ts`
Expected: FAIL — `Failed to resolve import "./coachinput"`

- [ ] **Step 3: 구현한다**

`src/ui/coachinput.ts`:

```ts
// 솔버 탭 상황 상세에서 쓰는 프리플랍 코치 해설 입력.
// 워커가 보내는 LightTerminal에는 종료 노드의 유틸리티가 없어서, 헤즈업 올인 쇼다운의
// 승·패 결과를 엔진(buildTree)과 같은 식으로 다시 계산한다.

import { classLabel } from '../engine/cards';
import { icmEquity } from '../engine/icm';
import { anteBySeat, normalizedPayouts } from '../engine/postflop/spot';
import type { SolveResult } from '../engine/solver';
import type { PreflopCoachInput } from '../engine/training/coach';
import { distributeSidePots } from '../engine/tree';
import type { LightDecision, LightTerminal, LightTree } from '../worker/protocol';
import { actionTotals, evOf, freqOf, label, playerReach, type TrailStep } from './spot';

export interface ShowdownUtilities {
  winIcm: number;
  loseIcm: number;
  winChip: number;
  loseChip: number;
}

/** 히어로가 이 헤즈업 올인 쇼다운에서 이기면 / 지면 얻는 값 (핸드 시작 대비). */
export function showdownUtilities(tree: LightTree, terminal: LightTerminal, hero: number): ShowdownUtilities | null {
  if (terminal.tType !== 'showdown') return null;
  if (terminal.participants.length !== 2) return null;
  if (!terminal.participants.includes(hero)) return null;
  const { stacks } = tree.config;
  const n = stacks.length;
  const ante = anteBySeat(tree.config);
  const payouts = normalizedPayouts(tree.config);
  const villain = terminal.participants.find((s) => s !== hero)!;
  const baseStacks = stacks.map((s, i) => s - ante[i] - terminal.contrib[i]);
  const settle = (order: number[]): number[] => {
    const f = baseStacks.slice();
    const win = distributeSidePots(terminal.contrib, terminal.folded, ante[n - 1], order);
    for (let j = 0; j < n; j++) f[j] += win[j];
    return f;
  };
  const fWin = settle([hero, villain]);
  const fLose = settle([villain, hero]);
  const start = tree.startIcm[hero];
  return {
    winIcm: icmEquity(fWin, payouts, stacks)[hero] * 100 - start,
    loseIcm: icmEquity(fLose, payouts, stacks)[hero] * 100 - start,
    winChip: fWin[hero] - stacks[hero],
    loseChip: fLose[hero] - stacks[hero],
  };
}

/**
 * 콜이 (뒤가 모두 폴드해) 헤즈업 올인 쇼다운으로 이어질 때, 콜이 폴드를 이기는 데 필요한 에퀴티.
 * 그런 라인이 없으면 null.
 */
export function requiredEquity(
  tree: LightTree, result: SolveResult, node: LightDecision, hand: number, hero: number,
): { chip: number | null; icm: number | null } {
  const callIdx = node.actions.findIndex((a) => a.type === 'call');
  const foldIdx = node.actions.findIndex((a) => a.type === 'fold');
  if (callIdx < 0 || foldIdx < 0) return { chip: null, icm: null };
  // 콜 뒤로 폴드만 따라가 종료 노드에 닿는다 (엔진의 explainPreflopDecision과 같은 규칙)
  let id = node.actions[callIdx].child;
  for (let guard = 0; guard < 12; guard++) {
    const x = tree.nodes[id];
    if (x.kind === 'terminal') {
      const u = showdownUtilities(tree, x, hero);
      if (!u) return { chip: null, icm: null };
      const fI = evOf(result.evIcm, result, node, foldIdx, hand);
      const fC = evOf(result.evChip, result, node, foldIdx, hand);
      const clamp = (x0: number) => Math.min(1, Math.max(0, x0));
      return {
        icm: Number.isFinite(fI) && u.winIcm !== u.loseIcm ? clamp((fI - u.loseIcm) / (u.winIcm - u.loseIcm)) : null,
        chip: Number.isFinite(fC) && u.winChip !== u.loseChip ? clamp((fC - u.loseChip) / (u.winChip - u.loseChip)) : null,
      };
    }
    const fold = x.actions.findIndex((a) => a.type === 'fold');
    if (fold < 0) break;
    id = x.actions[fold].child;
  }
  return { chip: null, icm: null };
}

export function buildPreflopCoachInput(
  tree: LightTree, result: SolveResult, trail: TrailStep[], node: LightDecision,
  hand: number, chosen: number, best: number,
): PreflopCoachInput {
  const hero = node.player;
  const n = tree.config.stacks.length;
  const primary = tree.config.mode;
  const labels = node.actions.map((a) => label(a, node));
  const freq = node.actions.map((_, i) => freqOf(result, node, i, hand));
  const evIcm = node.actions.map((_, i) => finite(evOf(result.evIcm, result, node, i, hand)));
  const evChip = node.actions.map((_, i) => finite(evOf(result.evChip, result, node, i, hand)));
  const key = primary === 'icm' ? evIcm : evChip;
  const loss = Math.max(0, (key[best] ?? 0) - (key[chosen] ?? 0));
  const lossBB = primary === 'icm' ? loss / bbPerIcm(tree, hero) : loss;

  // 히어로 앞의 마지막 레이저
  let aggressor: number | null = null;
  for (const st of trail) {
    const t = st.node.actions[st.action].type;
    if (t === 'raise' || t === 'allin') aggressor = st.node.player;
  }
  const req = requiredEquity(tree, result, node, hand, hero);
  let playersLeft = 0;
  for (let s = hero + 1; s < n; s++) if (!node.folded[s]) playersLeft++;
  const reach = playerReach(result, trail, hero);
  const totals = actionTotals(result, node, reach);
  const openShare = node.actions.reduce(
    (acc, a, i) => acc + (a.type === 'raise' || a.type === 'allin' ? totals.freq[i] : 0), 0,
  );

  return {
    hand: classLabel(hand),
    labels,
    kinds: node.actions.map((a) => a.type),
    freq,
    evIcm,
    evChip,
    chosen, best, primary, loss, lossBB,
    heroClass: hand,
    heroName: tree.seatNames[hero],
    seatNames: tree.seatNames,
    hero,
    pot: node.pot,
    toCall: Math.max(0, Math.min(node.bet - node.contrib[hero], node.behind[hero])),
    heroContrib: node.contrib[hero],
    heroBehind: node.behind[hero],
    isBlind: hero >= n - 2,
    aggressor,
    aggressorAllin: aggressor !== null && node.allin[aggressor],
    villainReach: aggressor !== null ? playerReach(result, trail, aggressor) : null,
    requiredChip: req.chip,
    requiredIcm: req.icm,
    playersLeft,
    heroOpenShare: aggressor === null ? openShare : null,
    startStacks: tree.config.stacks.slice(),
    payouts: normalizedPayouts(tree.config),
  };
}

function finite(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

/** ICM %p 한 단위가 몇 bb인지 (손실을 bb로 환산할 때 쓴다). */
function bbPerIcm(tree: LightTree, seat: number): number {
  const { stacks } = tree.config;
  const payouts = normalizedPayouts(tree.config);
  const n = stacks.length;
  const moved = (d: number) => {
    const x = stacks.slice();
    x[seat] += d;
    for (let j = 0; j < n; j++) if (j !== seat) x[j] -= d / (n - 1);
    return icmEquity(x, payouts)[seat] * 100;
  };
  const d = Math.min(0.5, stacks[seat] / 2);
  const slope = (moved(d) - moved(-d)) / (2 * d);
  return Math.max(1e-6, slope);
}

export type { PreflopCoachInput };
```

**주의:** `distributeSidePots`의 세 번째 인자는 데드머니(BB 앤티)다. `anteBySeat`가 마지막 좌석에만 값을 두므로
`ante[n - 1]`이 그 값이다. `icmEquity`의 세 번째 인자(`stacks`)는 같은 순위로 탈락한 플레이어를 가르는 데 쓰이므로
반드시 넘겨야 한다 (`src/engine/tree.ts:166`이 그렇게 부른다).

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `npx vitest run src/ui/coachinput.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: 전체 테스트와 타입 검사**

Run: `npm test`
Expected: PASS

Run: `npx tsc -b`
Expected: 에러 없음

- [ ] **Step 6: 커밋**

```bash
git add src/ui/coachinput.ts src/ui/coachinput.test.ts
git commit -m "Rebuild preflop coach input from the worker's light tree

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 핸드 뷰 UI (프리플랍)

**Files:**
- Create: `src/ui/SituationList.tsx`
- Create: `src/ui/HandView.tsx`
- Modify: `src/ui/App.tsx` (SolverApp에 뷰 전환 추가)
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: Task 2의 `enumerateSituations`·`MAX_ROWS`·`Situation`, Task 4의 `buildPreflopCoachInput`, 기존 `HandDetail`·`explainPreflop`
- Produces:
  - `postflopEntries(tree: LightTree, situation: Situation, hero: number): PostflopEntry[]`
  - `SituationList({ tree, result, hand, hero, situations, expanded, onExpand, onOpenPostflop })`
  - `HandView({ tree, result, hand, onHand, seat, onSeat, expanded, onExpand, onOpenPostflop, showAll, onShowAll })`
  - `interface PostflopEntry { situation: Situation; terminalId: number; label: string }`

- [ ] **Step 1: 상황 목록 컴포넌트를 만든다**

`src/ui/SituationList.tsx`:

```tsx
import { classLabel } from '../engine/cards';
import type { SolveResult } from '../engine/solver';
import { explainPreflop } from '../engine/training/coach';
import type { LightDecision, LightTree } from '../worker/protocol';
import { buildPreflopCoachInput } from './coachinput';
import { HandDetail } from './HandDetail';
import { actionColor, pct, signed } from './format';
import { actionTotals, label, playerReach, raiseRank, walkPath } from './spot';
import type { Situation } from './situations';

/** 이 상황에서 곧장 이어지는 헤즈업 플랍 종료 노드 하나. */
export interface PostflopEntry {
  situation: Situation;
  /** 종료 노드 id */
  terminalId: number;
  label: string;
}

/**
 * 상황에서 히어로가 액션을 하나 고른 뒤 나머지가 행동을 마쳤을 때 도달하는
 * 헤즈업 플랍 종료 노드들을 모은다. 다른 좌석의 액션은 레인지 전체에서 가장 잦은 것을 따른다.
 */
export function postflopEntries(tree: LightTree, situation: Situation, hero: number): PostflopEntry[] {
  const out: PostflopEntry[] = [];
  const seen = new Set<number>();

  const walk = (id: number, steps: string[], depth: number): void => {
    if (depth > 8) return;
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

- [ ] **Step 2: 핸드 뷰를 만든다**

`src/ui/HandView.tsx`:

```tsx
import { useMemo } from 'react';
import { classLabel, NUM_CLASSES } from '../engine/cards';
import type { SolveResult } from '../engine/solver';
import type { LightTree } from '../worker/protocol';
import { SituationList, type PostflopEntry } from './SituationList';
import { MAX_ROWS, enumerateSituations } from './situations';

interface Props {
  tree: LightTree;
  result: SolveResult;
  hand: number;
  onHand: (h: number) => void;
  seat: number;
  onSeat: (s: number) => void;
  expanded: number | null;
  onExpand: (i: number | null) => void;
  onOpenPostflop: (entry: PostflopEntry) => void;
  showAll: boolean;
  onShowAll: (v: boolean) => void;
}

export function HandView({ tree, result, hand, onHand, seat, onSeat, expanded, onExpand, onOpenPostflop, showAll, onShowAll }: Props) {
  const all = useMemo(() => enumerateSituations(tree, result, seat, hand), [tree, result, seat, hand]);
  const shown = showAll ? all : all.slice(0, MAX_ROWS);

  return (
    <section className="hand-view">
      <div className="hand-picker">
        <p className="eyebrow">핸드</p>
        <div className="mini-grid" role="grid" aria-label="핸드 선택">
          {Array.from({ length: NUM_CLASSES }, (_, h) => (
            <button type="button" role="gridcell" key={h} className={`mini-cell${hand === h ? ' sel' : ''}`}
              onClick={() => onHand(h)} aria-label={classLabel(h)} aria-selected={hand === h}>
              {classLabel(h)}
            </button>
          ))}
        </div>
      </div>

      <div className="seat-picker" role="radiogroup" aria-label="포지션 선택">
        <p className="eyebrow">포지션</p>
        <div className="seg">
          {tree.seatNames.map((name, s) => (
            <button type="button" role="radio" key={s} aria-checked={seat === s} className={seat === s ? 'on' : ''} onClick={() => onSeat(s)}>{name}</button>
          ))}
        </div>
      </div>

      <div className="hand-head">
        <h1><b>{classLabel(hand)}</b> · {tree.seatNames[seat]}</h1>
        <p className="hint">
          {tree.config.mode === 'icm' ? 'ICM EV' : 'Chip EV'} 기준으로 가장 높은 액션에 ▸를 붙입니다.
          2등과의 차이가 솔버의 혼합 온도({tree.config.smoothing ?? 0}bb) 이내면 <b>혼합</b>으로 표시합니다.
        </p>
      </div>

      <SituationList tree={tree} result={result} hand={hand} hero={seat} situations={shown}
        expanded={expanded} onExpand={onExpand} onOpenPostflop={onOpenPostflop} />

      {all.length > MAX_ROWS && (
        <button type="button" className="crumb" onClick={() => onShowAll(!showAll)}>
          {showAll ? '접기' : `더 보기 (${all.length - MAX_ROWS}개)`}
        </button>
      )}
    </section>
  );
}
```

- [ ] **Step 3: `App.tsx`에 뷰 전환을 붙인다**

`src/ui/App.tsx`의 `SolverApp` 안에서:

3-1. 상태를 더한다 (`const [tab, setTab] = useState<'setup' | 'chart'>('setup');` 아래):

```tsx
  const [boardView, setBoardView] = useState<'range' | 'hand'>('range');
  const [handSeat, setHandSeat] = useState(0);
  const [handClass, setHandClass] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
```

3-2. 임포트를 더한다:

```tsx
import { HandView } from './HandView';
import type { PostflopEntry } from './SituationList';
```

3-3. `<main className="board">` 안의 `{tree && spot && (...)}` 블록 **앞**에 뷰 전환을 넣는다:

```tsx
        {tree && (
          <div className="seg board-view" role="radiogroup" aria-label="보기 전환">
            <button type="button" role="radio" aria-checked={boardView === 'range'} className={boardView === 'range' ? 'on' : ''} onClick={() => setBoardView('range')}>레인지</button>
            <button type="button" role="radio" aria-checked={boardView === 'hand'} className={boardView === 'hand' ? 'on' : ''} onClick={() => setBoardView('hand')}>핸드</button>
          </div>
        )}
```

3-4. 기존 `{tree && spot && (` 를 `{tree && spot && boardView === 'range' && (` 로 바꾼다.

3-5. 그 블록 뒤에 핸드 뷰를 더한다:

```tsx
        {tree && result && boardView === 'hand' && (
          <HandView
            tree={tree} result={result}
            hand={handClass} onHand={(h) => { setHandClass(h); setExpanded(null); }}
            seat={handSeat} onSeat={(s) => { setHandSeat(s); setExpanded(null); }}
            expanded={expanded} onExpand={setExpanded}
            onOpenPostflop={(e: PostflopEntry) => { void e; }}
            showAll={showAll} onShowAll={setShowAll}
          />
        )}
        {tree && !result && boardView === 'hand' && (
          <p className="hint">솔브가 끝나면 상황 목록이 표시됩니다.</p>
        )}
```

(`onOpenPostflop`은 Task 6에서 채운다.)

3-6. `onStart`에서 `setExpanded(null); setShowAll(false);`를 더한다.

- [ ] **Step 4: 스타일을 더한다**

`src/ui/styles.css` 끝에 추가한다. 기존 CSS 변수(`--act-*`, `--ev-pos`, `--ev-neg`)와 같은 톤을 쓴다:

```css
/* ---- 핸드 뷰 ---- */
.board-view { margin: 0 0 12px; }
.hand-view { display: grid; gap: 14px; }
.hand-picker .mini-grid {
  display: grid; grid-template-columns: repeat(13, minmax(0, 1fr)); gap: 2px;
}
.mini-cell {
  font-size: 10px; padding: 3px 0; border: 1px solid transparent; border-radius: 3px;
  background: var(--cell, #1b1f26); color: inherit; cursor: pointer; line-height: 1.1;
}
.mini-cell.sel { border-color: currentColor; font-weight: 700; }
.seat-picker .seg { flex-wrap: wrap; }
.hand-head h1 { margin: 0 0 4px; font-size: 18px; }

.situations { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.situation-row {
  width: 100%; display: grid; align-items: center; gap: 8px;
  grid-template-columns: minmax(0, 1fr) 48px minmax(0, 150px) 56px 76px auto auto;
  padding: 8px 10px; border-radius: 6px; border: 1px solid transparent;
  background: var(--panel, #161a20); color: inherit; text-align: left; cursor: pointer;
}
.situation.open .situation-row { border-color: currentColor; }
.situation-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.situation-reach, .situation-freq, .situation-ev { font-variant-numeric: tabular-nums; text-align: right; }
.situation-best { color: var(--c); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font-size: 10px; padding: 1px 5px; border-radius: 999px; border: 1px solid currentColor; opacity: 0.8; }
.situation-detail { padding: 8px 0 12px 10px; display: grid; gap: 10px; }
.postflop-entries { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.coach { display: grid; gap: 6px; }
.coach-headline { margin: 0; font-weight: 600; }
.coach-reason { margin: 0; opacity: 0.85; line-height: 1.5; }
.coach-tags { display: flex; gap: 4px; flex-wrap: wrap; margin: 2px 0 0; }

@media (max-width: 720px) {
  .situation-row { grid-template-columns: minmax(0, 1fr) auto; grid-auto-rows: auto; }
  .situation-best { grid-column: 1 / -1; }
  .situation-freq, .situation-ev { grid-column: auto; }
}
```

- [ ] **Step 5: 타입 검사와 기존 테스트**

Run: `npx tsc -b`
Expected: 에러 없음 (초안의 `labelOf`/`require_label`을 지웠는지 여기서 걸린다)

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 브라우저에서 확인한다**

Run: `npm run dev`

브라우저에서 `http://localhost:5391`을 열고 확인한다:
1. 기본 설정(8인 25bb ICM)으로 **솔브**를 누르고 끝날 때까지 기다린다.
2. 결과 위의 `레인지 / 핸드` 전환에서 **핸드**를 누른다.
3. 13×13 미니 그리드에서 `AKs`를, 포지션에서 `CO`를 고른다.
4. 상황 목록에 `첫 액션 · 나머지 폴드`를 포함한 여러 줄이 나오고, 각 줄에 `▸ 액션`, 빈도, EV가 보이는지 본다.
5. 한 줄을 눌러 상세가 펼쳐지고 액션별 표 · 레인지 요약 · 코치 해설이 나오는지, `포스트플랍` 버튼 또는 미지원 안내가 보이는지 본다.
5-1. 올인을 마주하는 상황(예: 짧은 스택 좌석의 올인 뒤 `BB`)을 펼쳐 코치 해설에 **"콜하려면 에퀴티가 … 필요합니다"** 문단이 나오는지 확인한다. 이 문단은 Task 4가 제대로 동작해야만 나온다.
6. `레인지`로 돌아가면 기존 화면이 그대로인지 확인한다.
7. 브라우저 폭을 400px로 줄여 상황 행이 두 줄로 접히는지 확인한다.
8. 콘솔에 에러가 없는지 확인한다.

- [ ] **Step 7: 커밋**

```bash
git add src/ui/HandView.tsx src/ui/SituationList.tsx src/ui/App.tsx src/ui/styles.css
git commit -m "Add hand-first situation view with coach notes to the solver tab

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 포스트플랍 탐색기 UI

**Files:**
- Create: `src/ui/CardPicker.tsx`
- Create: `src/ui/PostflopView.tsx`
- Modify: `src/engine/training/hand.ts:85` (`buildRangeReview`를 export 한다 — 한 단어 추가)
- Modify: `src/ui/App.tsx` (`onOpenPostflop` 연결, `PostflopClient` 수명)
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: Task 1의 `preflopExit`, Task 3의 `PostflopExplorer`/`ExploreState`, Task 5의 `PostflopEntry`, 기존 `PostflopClient`(`./training/clients`), 기존 `RangePanel`(`./training/RangePanel`), 기존 `buildRangeReview`·`RangeReview`(`../engine/training/hand`), 기존 `playerReach`·`walkPath`(`./spot`)
- Produces:
  - `CardPicker({ need, dead, onPick })`
  - `PostflopView({ tree, result, entry, hand, hero, client, onClose })`

- [ ] **Step 1: 카드 선택기를 만든다**

`src/ui/CardPicker.tsx`:

```tsx
import { useState } from 'react';
import { cardText, SUIT_SYMBOLS } from '../engine/postflop/combos';

const RANKS = 'AKQJT98765432';

interface Props {
  /** 골라야 하는 장수 */
  need: number;
  /** 고를 수 없는 카드 */
  dead: number[];
  onPick: (cards: number[]) => void;
}

export function CardPicker({ need, dead, onPick }: Props) {
  const [picked, setPicked] = useState<number[]>([]);
  const blocked = new Set([...dead, ...picked]);

  const toggle = (c: number) => {
    if (picked.includes(c)) { setPicked(picked.filter((x) => x !== c)); return; }
    if (picked.length >= need) return;
    const next = [...picked, c];
    setPicked(next);
    if (next.length === need) { onPick(next); setPicked([]); }
  };

  return (
    <div className="card-picker">
      <p className="eyebrow">카드 {need}장 선택 ({picked.map(cardText).join(' ') || '없음'})</p>
      <div className="card-grid">
        {Array.from({ length: 4 }, (_, suit) => (
          <div className="card-row" key={suit}>
            {Array.from({ length: 13 }, (_, i) => {
              const rank = 12 - i; // A부터
              const c = rank * 4 + suit;
              const off = blocked.has(c) && !picked.includes(c);
              return (
                <button type="button" key={c} className={`pick s${suit}${picked.includes(c) ? ' on' : ''}`}
                  disabled={off} onClick={() => toggle(c)} aria-label={cardText(c)}>
                  {RANKS[i]}<span className="suit">{SUIT_SYMBOLS[suit]}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 탐색기 화면을 만든다**

`src/ui/PostflopView.tsx`:

```tsx
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
    const reachBySeat = tree.config.stacks.map(() => new Float64Array(NUM_CLASSES));
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
            <RangePanel range={rangeReview} primary={primary} chosen={best ? best.i : 0} tab={rangeTab} onTab={setRangeTab} />
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
```

**주의:** `RangePanel`의 `chosen`은 트레이닝 리뷰에서 "사용자가 고른 액션"을 뜻하지만, 탐색기에는 고른 액션이 없으므로 최선 액션을 넘긴다. `buildRangeReview`는 지금 `src/engine/training/hand.ts`의 모듈 내부 함수이므로, 이 과제에서 `function buildRangeReview(` 앞에 `export `를 붙여 내보낸다 (다른 변경 없음). `RangeReview` 타입은 이미 export 되어 있다.

- [ ] **Step 3: `App.tsx`에 연결한다**

3-1. 임포트를 더한다:

```tsx
import { useRef } from 'react';
import { PostflopView } from './PostflopView';
import { PostflopClient } from './training/clients';
```

3-2. `SolverApp` 안에 상태를 더한다:

```tsx
  const [postflop, setPostflop] = useState<PostflopEntry | null>(null);
  const pfClient = useRef<PostflopClient | null>(null);
  const getClient = () => (pfClient.current ??= new PostflopClient());
  useEffect(() => () => pfClient.current?.dispose(), []);
```

3-3. Task 5에서 비워 둔 `onOpenPostflop`을 채운다:

```tsx
            onOpenPostflop={(e: PostflopEntry) => setPostflop(e)}
```

3-4. 핸드 뷰 블록 아래에 탐색기를 넣는다:

```tsx
        {tree && result && boardView === 'hand' && postflop && (
          <PostflopView tree={tree} result={result} entry={postflop} hand={handClass} hero={handSeat}
            client={getClient()} onClose={() => setPostflop(null)} />
        )}
```

3-5. `onStart`와 핸드·좌석 변경 시 `setPostflop(null)`을 더한다.

- [ ] **Step 4: 스타일을 더한다**

`src/ui/styles.css` 끝에 추가:

```css
/* ---- 포스트플랍 탐색기 ---- */
.postflop-view { display: grid; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid currentColor; }
.postflop-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.action-btn.best { outline: 2px solid var(--ev-pos); }
.action-btn .action-ev { font-variant-numeric: tabular-nums; opacity: 0.85; }

.card-picker { display: grid; gap: 6px; }
.card-grid { display: grid; gap: 3px; }
.card-row { display: grid; grid-template-columns: repeat(13, minmax(0, 1fr)); gap: 3px; }
.pick {
  padding: 4px 0; border-radius: 4px; border: 1px solid transparent;
  background: var(--panel, #161a20); color: inherit; cursor: pointer; font-size: 11px; line-height: 1.1;
}
.pick .suit { margin-left: 1px; }
.pick.s0, .pick.s1 { color: #6fcf97; }
.pick.s2, .pick.s3 { color: #eb9a9a; }
.pick.on { border-color: currentColor; font-weight: 700; }
.pick:disabled { opacity: 0.25; cursor: not-allowed; }
```

- [ ] **Step 5: 타입 검사와 기존 테스트**

Run: `npx tsc -b`
Expected: 에러 없음

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 브라우저에서 확인한다**

Run: `npm run dev`

1. 8인 25bb ICM으로 솔브 → `핸드` 뷰 → `AKs` · `CO`.
2. `내 Raise 2 → BB Call` 같은 헤즈업 플랍 라인이 있는 상황을 펼치고 **플랍 보기**를 누른다.
3. 수트 드롭다운에 `AsKs` 같은 항목이 보이는지 확인한다.
4. 카드 선택기에서 `2c 7d Ts`를 고른다. 솔브 진행률이 뜨고 2~5초 안에 액션 표가 나오는지 확인한다.
5. 액션 표에 빈도·EV가 있고 최선 액션에 테두리가 있는지, 그 아래 13×13 레인지 차트가 나오는지 확인한다. 차트의 액션 탭을 눌러 액션별 EV 차트로 바뀌는지도 본다.
6. `Check`를 두 번 눌러 턴 카드 선택기로 넘어가는지, 턴 카드를 고르면 다시 솔브하는지 확인한다.
7. `한 단계 뒤로`를 눌러 되돌아가는지, 같은 카드를 다시 고르면 즉시 나오는지(캐시) 확인한다.
8. `Bet` → 상대 `Fold`로 라인을 끝내고 승자 문구가 나오는지 확인한다.
9. 콘솔에 에러가 없는지 확인한다.

문제가 있으면 고치고 5-6단계를 다시 돈다.

- [ ] **Step 7: 커밋**

```bash
git add src/ui/CardPicker.tsx src/ui/PostflopView.tsx src/ui/App.tsx src/ui/styles.css src/engine/training/hand.ts
git commit -m "Add postflop explorer UI to the solver hand view

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 문서 갱신과 최종 검증

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1-6 전부
- Produces: 없음

- [ ] **Step 1: README의 `## 구조` 표에 새 파일을 더한다**

`src/engine/postflop/` 행 바로 아래에 넣는다:

```markdown
| `src/engine/postflop/spot.ts` | 프리플랍 종료 노드 → 헤즈업 포스트플랍 시작 상태 (트레이닝·탐색기 공용) |
| `src/engine/postflop/explore.ts` | 솔버 탭의 포스트플랍 탐색기 (보드 직접 지정, 양쪽 액션 수동 진행) |
```

그리고 `src/ui/` 행을 고친다:

```markdown
| `src/ui/` | React UI: 설정 패널, 좌석 레일, 핸드 차트, 핸드 뷰(상황 목록·포스트플랍 탐색기), 모바일 탭 |
```

- [ ] **Step 2: 솔버 모드 설명을 더한다**

`## 트레이닝 모드` 섹션 **앞**에 새 섹션을 넣는다:

```markdown
## 솔버 모드

솔브가 끝나면 결과를 두 가지 방식으로 본다.

- **레인지 뷰:** 좌석 레일과 액션 경로로 스팟을 고르고, 13×13 차트에서 핸드를 눌러 액션별 빈도와 EV를 본다.
- **핸드 뷰:** 핸드와 포지션을 먼저 고정하면, 그 포지션에서 자주 마주치는 상황(히어로 결정 2회까지, 선택한 핸드
  기준 도달 확률 0.5% 이상)을 한 목록으로 보여준다. 줄마다 주 단위(ICM 또는 Chip) EV가 가장 높은 액션과 그
  빈도·EV·2등과의 차이가 붙는다. 차이가 혼합 온도(`smoothing`, 기본 0.15bb) 이내면 `혼합`으로 표시해
  사실상 동등한 선택을 정답처럼 보이지 않게 한다.

**포스트플랍 탐색기 (헤즈업):** 상황을 펼쳐 헤즈업으로 플랍에 가는 라인을 고르면, 수트를 지정하고 보드를 직접
입력해 플랍·턴·리버를 이어서 볼 수 있다. 양쪽 액션을 모두 사용자가 고르며, 고른 액션만큼 그 플레이어의 레인지가
좁혀진 채 다음 스트리트를 다시 솔브한다. 같은 (보드, 경로)는 결과를 재사용한다.
3인 이상으로 플랍에 가는 라인은 솔버가 지원하지 않아 프리플랍 EV(EQR 근사)까지만 제공한다.
```

- [ ] **Step 3: `## 한계`에 한 줄 더한다**

```markdown
- 포스트플랍 탐색기는 헤즈업 전용이고 스트리트마다 실시간 솔브라 즉답이 아니다 (플랍 2~3초, 턴 약 4초)
```

- [ ] **Step 4: 최종 검증**

Run: `npm test`
Expected: PASS — 실패 0개. 출력의 마지막 요약 줄을 그대로 확인한다.

Run: `npx tsc -b`
Expected: 에러 없음

Run: `npm run build`
Expected: 성공, `dist/`에 산출물 생성

Run: `npm run preview` 후 `http://localhost:4173`에서 Task 6 Step 6의 시나리오를 한 번 더 통과시킨다 (빌드 결과에서도 워커가 뜨는지 확인).

- [ ] **Step 5: 커밋**

```bash
git add README.md
git commit -m "Document the solver hand view and postflop explorer

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## 실행 순서 요약

1. Task 1 — 공유 헬퍼 (엔진, 테스트 있음)
2. Task 2 — 상황 열거 (순수 함수, 테스트 있음)
3. Task 3 — 탐색기 엔진 (테스트 있음)
4. Task 4 — 코치 해설 입력 빌더 (테스트 있음)
5. Task 5 — 핸드 뷰 UI (타입 검사 + 브라우저 확인)
6. Task 6 — 포스트플랍 UI (타입 검사 + 브라우저 확인)
7. Task 7 — 문서와 최종 검증

의존 관계: Task 3 → Task 1, Task 4 → Task 1, Task 5 → Task 2·4, Task 6 → Task 1·3·5.
Task 2와 Task 4는 서로 독립이므로 순서를 바꿔도 된다.
