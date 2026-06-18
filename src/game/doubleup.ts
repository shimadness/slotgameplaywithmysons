// ===== ダブルアップ（DOUBLE UP CHALLENGE） =========================
// 獲得配当を賭けてディーラーと勝負。両モード共通の機能。
// ・3箇所から1つ選び、ディーラーより強い目なら勝ち（賭け分が倍）。
// ・各回 COLLECT / 半分賭け / 全部賭け（価値1のとき半分は不可）。
// ・価値が UPPER_CAP を超えたら強制 COLLECT。
// ・3リールが全て同じ＝スペシャルボーナスで強制終了。
import { DSYMBOLS, type DSym } from "./dropEngine";

/** 強さ順（弱→強）。ダブルアップ専用の12段ラダー。 */
export const DU_LADDER: DSym[] = [
  "cherry", "orange", "plum", "banana", "melon", "bell",
  "bar", "bar2", "bar3", "blue7", "red7", "gold7",
];
export function rank(s: DSym): number { return DU_LADDER.indexOf(s); }
export function duGlyph(s: DSym): string { return DSYMBOLS[s].glyph; }
export function duColor(s: DSym): string { return DSYMBOLS[s].color; }

/** スペシャルボーナス配当（3つ揃いのシンボル別。BET倍率）。 */
export const SPECIAL_BONUS: Record<DSym, number> = {
  cherry: 30, orange: 45, plum: 60, banana: 90, melon: 120, bell: 150,
  bar: 300, bar2: 450, bar3: 600, blue7: 900, red7: 1500, gold7: 3000,
  wild: 0,
};

/** 価値の上限。これを超えたら強制 COLLECT。 */
export const UPPER_CAP = 50000;

export interface DURound {
  reels: [DSym, DSym, DSym]; // プレイヤーの3リール（伏せて出す→選択で開く）
  dealer: DSym;              // ディーラーの目（先に提示）
}

/** ラダーから一様ランダムに1つ */
function pickRank(): DSym {
  return DU_LADDER[(Math.random() * DU_LADDER.length) | 0];
}

/** 1ラウンドの配り（ディーラー＋3リール）。一様ランダムで公平寄りの勝負に。 */
export function dealRound(): DURound {
  return {
    reels: [pickRank(), pickRank(), pickRank()],
    dealer: pickRank(),
  };
}

/** 3リールが全て同じ＝スペシャル。 */
export function isSpecial(r: DURound): DSym | null {
  const [a, b, c] = r.reels;
  return a === b && b === c ? a : null;
}

/** 選んだ目がディーラーより強ければ勝ち（同値は負け）。 */
export function beatsDealer(r: DURound, pick: number): boolean {
  return rank(r.reels[pick]) > rank(r.dealer);
}
