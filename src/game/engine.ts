// ===== リール抽選エンジン ==========================================
import type { SymbolId } from "./symbols";
import { ALL_SYMBOL_IDS, SYMBOLS } from "./symbols";
import { REELS, ROWS, type Grid } from "./paylines";

/**
 * リールごとの「帯（ストリップ）」を重み付きで生成する。
 * 各リールが固有の帯を持つことで本物のスロットらしい出目分布になる。
 */
function buildStrip(length: number): SymbolId[] {
  const pool: SymbolId[] = [];
  for (const id of ALL_SYMBOL_IDS) {
    const w = SYMBOLS[id].weight;
    for (let i = 0; i < w; i++) pool.push(id);
  }
  const strip: SymbolId[] = [];
  let prev: SymbolId | null = null;
  for (let i = 0; i < length; i++) {
    let pick: SymbolId;
    // 同一シンボルの3連続を避けて見栄えを整える
    let guard = 0;
    do {
      pick = pool[Math.floor(Math.random() * pool.length)];
      guard++;
    } while (pick === prev && Math.random() < 0.6 && guard < 5);
    strip.push(pick);
    prev = pick;
  }
  return strip;
}

const STRIP_LEN = 64;

export class ReelEngine {
  /** 5本ぶんの固定リール帯 */
  readonly strips: SymbolId[][];

  constructor() {
    this.strips = Array.from({ length: REELS }, () => buildStrip(STRIP_LEN));
  }

  /**
   * 各リールの停止位置をランダムに決め、表示用の 5x3 グリッドを返す。
   * @returns { grid, stops } grid は reel-major、stops は各リール先頭(上段)の帯インデックス
   */
  spin(): { grid: Grid; stops: number[] } {
    const grid: Grid = [];
    const stops: number[] = [];
    for (let reel = 0; reel < REELS; reel++) {
      const strip = this.strips[reel];
      const stop = Math.floor(Math.random() * strip.length);
      stops.push(stop);
      const col: SymbolId[] = [];
      for (let row = 0; row < ROWS; row++) {
        col.push(strip[(stop + row) % strip.length]);
      }
      grid.push(col);
    }
    return { grid, stops };
  }
}
