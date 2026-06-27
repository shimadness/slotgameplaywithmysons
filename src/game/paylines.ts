// ===== 当たり判定（左詰め全リール方式 / TENGU KING 化） =================
// ラインの概念を廃止。「各シンボルが左リール(リール1)から連続して何リールに
// 出たか」で配当を決める。配当は 2個そろいから発生。
// ワイルドは ①通常の代用 ②各ワイルドが花火で×2/×3を持ち、盤面の全ワイルドの
// 倍率を掛け合わせて「総配当(baseWin)」に乗算する（当たりがある時=baseWin>0のみ）。
// docs/TENGU_KING_DESIGN.md 参照。
import type { SymbolId } from "./symbols";
import { SCATTER, WILD, sym } from "./symbols";

export const REELS = 5;
export const ROWS = 3;

/**
 * 旧10ライン方式の名残り。評価には使わない（単一ベット化の橋渡し）。
 * `state.totalBet = lineBet × LINE_COUNT` の計算を壊さないよう 1 を維持。
 */
export const LINE_COUNT = 1;

/** グリッドは reel-major: grid[reel][row] = SymbolId */
export type Grid = SymbolId[][];

/** 1シンボルぶんの左詰め当たり。 */
export interface SymbolWin {
  symbol: SymbolId; // 当たりシンボル
  count: number; // 左から連続して出たリール数（2〜5）
  amount: number; // 払い出し（ワイルド倍率を掛ける前）
  cells: Array<[number, number]>; // [reel,row] のリスト（演出用ハイライト）
}

/** ワイルド1個ぶんの花火倍率。 */
export interface WildMult {
  mult: number; // ×2 or ×3
  cell: [number, number]; // [reel,row]
}

export interface ScatterWin {
  count: number;
  amount: number; // 天狗は直接配当を持たない（常に0／突入トリガー専用）
  cells: Array<[number, number]>;
  triggersBonus: boolean;
}

export interface SpinEvaluation {
  wins: SymbolWin[]; // 左詰め当たり一覧
  baseWin: number; // ワイルド倍率を掛ける前の総配当
  wildMults: WildMult[]; // 盤面に出た各ワイルドの花火倍率（baseWin>0のときのみ）
  wildMultiplier: number; // 上記の積（花火なしは 1）
  scatter: ScatterWin | null;
  total: number; // 最終総配当 = baseWin × wildMultiplier
}

const BONUS_SCATTER_MIN = 3;

/** 花火で ×3 を引く確率（残りは ×2）。RTPで調整。 */
const WILD_X3_CHANCE = 0.3;

/** あるリールの3セルのどこかに S（またはワイルド）が出ているか。 */
function reelHas(grid: Grid, reel: number, base: SymbolId): boolean {
  for (let row = 0; row < ROWS; row++) {
    const s = grid[reel][row];
    if (s === base || s === WILD) return true;
  }
  return false;
}

/** あるリールで S（またはワイルド）に該当するセル座標を返す。 */
function matchCells(
  grid: Grid,
  reel: number,
  base: SymbolId
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let row = 0; row < ROWS; row++) {
    const s = grid[reel][row];
    if (s === base || s === WILD) out.push([reel, row]);
  }
  return out;
}

/**
 * グリッドを評価する。
 * @param grid   reel-major のシンボル配置
 * @param bet    1スピンの固定ベット
 * @param multiplier 外部倍率（通常1。ハーネスは1）
 */
export function evaluate(
  grid: Grid,
  bet: number,
  multiplier = 1
): SpinEvaluation {
  const wins: SymbolWin[] = [];

  // リール1（最左）に出ている実シンボルを起点に、左詰めで連続数を数える。
  // ワイルドはリール1に出さない（engine.ts）ので、起点は常に実シンボル。
  const seen = new Set<SymbolId>();
  for (let row = 0; row < ROWS; row++) {
    const base = grid[0][row];
    if (base === WILD || base === SCATTER) continue;
    if (seen.has(base)) continue; // 同一シンボルは1回のみ計上
    seen.add(base);

    let count = 1;
    const cells: Array<[number, number]> = matchCells(grid, 0, base);
    for (let reel = 1; reel < REELS; reel++) {
      if (reelHas(grid, reel, base)) {
        count++;
        cells.push(...matchCells(grid, reel, base));
      } else {
        break;
      }
    }

    if (count >= 2) {
      const payMul = sym(base).pay[count as 2 | 3 | 4 | 5] ?? 0;
      const amount = payMul * bet * multiplier;
      if (amount > 0) {
        wins.push({ symbol: base, count, amount, cells });
      }
    }
  }

  const baseWin = wins.reduce((a, w) => a + w.amount, 0);

  // ▼ ワイルド花火の倍率（当たりがある＝baseWin>0 のときだけ発火）
  const wildMults: WildMult[] = [];
  let wildMultiplier = 1;
  if (baseWin > 0) {
    for (let reel = 0; reel < REELS; reel++) {
      for (let row = 0; row < ROWS; row++) {
        if (grid[reel][row] === WILD) {
          const mult = Math.random() < WILD_X3_CHANCE ? 3 : 2;
          wildMults.push({ mult, cell: [reel, row] });
          wildMultiplier *= mult;
        }
      }
    }
  }

  // 天狗（スキャッター・位置不問）。直接配当なし、突入トリガー専用。
  const scatterCells: Array<[number, number]> = [];
  for (let reel = 0; reel < REELS; reel++) {
    for (let row = 0; row < ROWS; row++) {
      if (grid[reel][row] === SCATTER) scatterCells.push([reel, row]);
    }
  }
  let scatter: ScatterWin | null = null;
  if (scatterCells.length >= BONUS_SCATTER_MIN) {
    scatter = {
      count: scatterCells.length,
      amount: 0,
      cells: scatterCells,
      triggersBonus: true,
    };
  }

  const total = baseWin * wildMultiplier;

  return { wins, baseWin, wildMults, wildMultiplier, scatter, total };
}

/** フリースピン付与数（天狗の数に応じて）。3個=8 / 4個=15 / 5個=25。 */
export function freeSpinsFor(scatterCount: number): number {
  if (scatterCount >= 5) return 25;
  if (scatterCount === 4) return 15;
  if (scatterCount === 3) return 8;
  return 0;
}
