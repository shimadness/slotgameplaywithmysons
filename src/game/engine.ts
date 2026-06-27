// ===== リール抽選エンジン ==========================================
import type { SymbolId } from "./symbols";
import { ALL_SYMBOL_IDS, SYMBOLS } from "./symbols";
import { REELS, ROWS, type Grid } from "./paylines";

// 帯生成は「固定シード」で全プレイヤー共通にする＝RTPを安定させる
// （実機スロット同様、帯は設計値。出目のランダム性は spin() の停止位置で担保）。
// ※ Math.random は使わない（プレイヤー毎・実行毎にブレるのを防ぐ）。
const STRIP_SEED = 0x54656e67; // "Teng"
function makeRng(seedNum: number): () => number {
  let s = seedNum >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ワイルドを出せるリール（リール2・3・4＝index 1,2,3）。リール1/5には出さない。 */
function wildAllowed(reel: number): boolean {
  return reel >= 1 && reel <= 3;
}

// ★ワイルド（＝花火×N倍率）は「フリーゲーム中だけ」出る。通常ゲームには一切出さない。
//   通常帯 wildWeight=0（ワイルド除外）／フリー帯 wildWeight=FREE_WILD_WEIGHT。
//   設計：突入1/141(≈5〜15分に1回)を保ちつつ、フリーは「ランキング一撃エンジン」として
//   ワイルド高め(=12, 約1.4スピンに1個)にする。ワイルドを増やすほどフリー配当が跳ねRTP↑。
const FREE_WILD_WEIGHT = 12;

/**
 * リールごとの「帯（ストリップ）」を重み付きで生成する。
 * 各リールが固有の帯を持つことで本物のスロットらしい出目分布になる。
 * @param allowWild ワイルドを帯に含めるか（リール2〜4のみ true）。
 * @param wildWeight ワイルドの重み（0なら帯に一切含めない＝通常ゲーム）。
 */
function buildStrip(
  length: number,
  allowWild: boolean,
  rng: () => number,
  wildWeight: number
): SymbolId[] {
  // ① 重みに比例した「正確な枚数」で帯を構成（帯ごとの枚数ブレを無くす）。
  const includeWild = allowWild && wildWeight > 0;
  const ids = ALL_SYMBOL_IDS.filter((id) => id !== "wild" || includeWild);
  const weightOf = (id: SymbolId) =>
    id === "wild" ? wildWeight : SYMBOLS[id].weight;
  let totalW = 0;
  for (const id of ids) totalW += weightOf(id);
  const strip: SymbolId[] = [];
  for (const id of ids) {
    const n = Math.max(1, Math.round((weightOf(id) / totalW) * length));
    for (let i = 0; i < n; i++) strip.push(id);
  }
  // ② 決定的シャッフル（Fisher–Yates）。
  for (let i = strip.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [strip[i], strip[j]] = [strip[j], strip[i]];
  }
  // ③ 同一シンボルの3連続をほぐす（見栄え＆連続当たりの偏り低減）。
  for (let i = 2; i < strip.length; i++) {
    if (strip[i] === strip[i - 1] && strip[i] === strip[i - 2]) {
      const j = Math.floor(rng() * strip.length);
      [strip[i], strip[j]] = [strip[j], strip[i]];
    }
  }
  return strip;
}

const STRIP_LEN = 64;

function buildStripSet(wildWeight: number): SymbolId[][] {
  const rng = makeRng(STRIP_SEED); // 固定シード＝毎回同じ帯
  return Array.from({ length: REELS }, (_, reel) =>
    buildStrip(STRIP_LEN, wildAllowed(reel), rng, wildWeight)
  );
}

export class ReelEngine {
  /** 通常帯 と フリー帯（ワイルド多め）。表示中の帯は active。 */
  private readonly normalStrips: SymbolId[][];
  private readonly freeStrips: SymbolId[][];
  private freeMode = false;

  constructor() {
    this.normalStrips = buildStripSet(0); // 通常はワイルド無し
    this.freeStrips = buildStripSet(FREE_WILD_WEIGHT); // フリーのみワイルドあり
  }

  /** 現在表示中（抽選対象）の帯。Board と共有する。 */
  get strips(): SymbolId[][] {
    return this.freeMode ? this.freeStrips : this.normalStrips;
  }

  /** フリーゲーム帯への切替（true=ワイルド多めのフリー帯）。 */
  setFreeMode(on: boolean): void {
    this.freeMode = on;
  }

  /**
   * 各リールの停止位置をランダムに決め、表示用の 5x3 グリッドを返す。
   * @returns { grid, stops } grid は reel-major、stops は各リール先頭(上段)の帯インデックス
   */
  spin(): { grid: Grid; stops: number[] } {
    const strips = this.strips;
    const grid: Grid = [];
    const stops: number[] = [];
    for (let reel = 0; reel < REELS; reel++) {
      const strip = strips[reel];
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
