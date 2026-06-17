// ===== ペイライン & 当たり判定 =====================================
import type { SymbolId } from "./symbols";
import { SCATTER, WILD, sym } from "./symbols";

export const REELS = 5;
export const ROWS = 3;

/** 各ラインは「リールごとの行インデックス(0=上,1=中,2=下)」の配列。 */
export const PAYLINES: number[][] = [
  [1, 1, 1, 1, 1], // 1. 中央横
  [0, 0, 0, 0, 0], // 2. 上横
  [2, 2, 2, 2, 2], // 3. 下横
  [0, 1, 2, 1, 0], // 4. V字
  [2, 1, 0, 1, 2], // 5. 山型
  [1, 0, 0, 0, 1], // 6. 上寄せ
  [1, 2, 2, 2, 1], // 7. 下寄せ
  [0, 0, 1, 2, 2], // 8. 右下り
  [2, 2, 1, 0, 0], // 9. 右上り
  [1, 0, 1, 2, 1], // 10. ジグザグ
];

export const LINE_COUNT = PAYLINES.length;

/** グリッドは reel-major: grid[reel][row] = SymbolId */
export type Grid = SymbolId[][];

export interface LineWin {
  line: number; // ペイラインのインデックス
  symbol: SymbolId; // 当たりシンボル（ワイルド代用後の本体）
  count: number; // 左から連続した数
  amount: number; // 払い出し
  cells: Array<[number, number]>; // [reel,row] のリスト
}

export interface ScatterWin {
  count: number;
  amount: number;
  cells: Array<[number, number]>;
  triggersBonus: boolean;
}

export interface SpinEvaluation {
  lineWins: LineWin[];
  scatter: ScatterWin | null;
  total: number; // ライン + スキャッターの合計
}

const BONUS_SCATTER_MIN = 3;

/**
 * グリッドを評価する。
 * @param grid   reel-major のシンボル配置
 * @param lineBet 1ラインあたりのベット
 * @param totalBet 総ベット（スキャッター配当に使用）
 * @param multiplier フリースピン時などの倍率
 */
export function evaluate(
  grid: Grid,
  lineBet: number,
  totalBet: number,
  multiplier = 1
): SpinEvaluation {
  const lineWins: LineWin[] = [];

  for (let li = 0; li < PAYLINES.length; li++) {
    const pattern = PAYLINES[li];
    const lineSymbols: SymbolId[] = pattern.map((row, reel) => grid[reel][row]);

    // 左端から見て「本体シンボル」を決める（先頭がワイルドなら次の非ワイルド）。
    let base: SymbolId | null = null;
    for (const s of lineSymbols) {
      if (s === SCATTER) break; // スキャッターはライン非対象
      if (s !== WILD) {
        base = s;
        break;
      }
    }
    // 全部ワイルドのケース
    if (base === null && lineSymbols[0] === WILD) base = WILD;
    if (base === null || base === SCATTER) continue;

    // 左から連続一致数を数える（ワイルドは代用）
    let count = 0;
    const cells: Array<[number, number]> = [];
    for (let reel = 0; reel < REELS; reel++) {
      const s = lineSymbols[reel];
      if (s === base || s === WILD) {
        count++;
        cells.push([reel, pattern[reel]]);
      } else {
        break;
      }
    }

    if (count >= 3) {
      const def = sym(base);
      const payMul = def.pay[count as 3 | 4 | 5] ?? 0;
      const amount = payMul * lineBet * multiplier;
      if (amount > 0) {
        lineWins.push({ line: li, symbol: base, count, amount, cells });
      }
    }
  }

  // スキャッター（位置不問）
  const scatterCells: Array<[number, number]> = [];
  for (let reel = 0; reel < REELS; reel++) {
    for (let row = 0; row < ROWS; row++) {
      if (grid[reel][row] === SCATTER) scatterCells.push([reel, row]);
    }
  }
  let scatter: ScatterWin | null = null;
  if (scatterCells.length >= 3) {
    const n = Math.min(scatterCells.length, 5) as 3 | 4 | 5;
    const payMul = sym(SCATTER).pay[n] ?? 0;
    const amount = payMul * totalBet * multiplier;
    scatter = {
      count: scatterCells.length,
      amount,
      cells: scatterCells,
      triggersBonus: scatterCells.length >= BONUS_SCATTER_MIN,
    };
  }

  const total =
    lineWins.reduce((a, w) => a + w.amount, 0) + (scatter?.amount ?? 0);

  return { lineWins, scatter, total };
}

/** フリースピン付与数（スキャッター数に応じて） */
export function freeSpinsFor(scatterCount: number): number {
  if (scatterCount >= 5) return 20;
  if (scatterCount === 4) return 15;
  if (scatterCount === 3) return 10;
  return 0;
}
