// ===== 本家準拠 DROP エンジン（Phase 1） =============================
// トゥインクルドロップRUSH の配当系統を忠実に再現した新エンジン。
// 1BET=全ライン有効。配当は「3系統の総和（足し算）」：
//   ① ラインペイ  : 8ライン(縦3横3斜め2)。役成立で BET × 現在オッズ[symbol]
//                   役成立ごとに「そのシンボル以上」が階段を1段上昇（フリーゲーム持ち越し）
//   ② コネクト    : 同シンボル3個以上隣接(neighbors規則) で BET × コネクト表[個数][symbol]
//   ③ コンボ      : 4連鎖以上で BET × 連鎖倍率（最大30コンボ=1024倍）
// gold7 はライン1000固定（昇降せず・激レア）。WILD5 は消えずに最大5回代用。
//
// ※このファイルは UI 非依存。math を rtp で検証してから UI/main を差し替える。

// ---- シンボル（弱→強） --------------------------------------------
export type DSym =
  | "cherry" | "orange" | "plum" | "banana" | "melon" | "bell"
  | "bar" | "bar2" | "bar3" | "blue7" | "red7" | "gold7"
  | "wild";

/** 配当に関わる土台シンボル（弱→強・11種）。gold7/wild は別扱い。 */
export const BASE_SYMS: DSym[] = [
  "cherry", "orange", "plum", "banana", "melon", "bell",
  "bar", "bar2", "bar3", "blue7", "red7",
];

export interface DSymDef {
  id: DSym;
  glyph: string;
  color: string;
  /** ライン・オッズ開始値（マスター階段上の開始位置の値） */
  lineOdds: number;
  /** スポーン重み（出やすさ）。RTP は rtp で計測して調整。 */
  weight: number;
}

export const DSYMBOLS: Record<DSym, DSymDef> = {
  // weight は弱→強。全体RTPは FREEZE_RATE（氷出現率）で調整（固定配当・1BET経済で約95%）。
  cherry: { id: "cherry", glyph: "🍒", color: "#ff5c7a", lineOdds: 1, weight: 100 },
  orange: { id: "orange", glyph: "🍊", color: "#ff9f1c", lineOdds: 2, weight: 84 },
  plum:   { id: "plum",   glyph: "🍇", color: "#9b5de5", lineOdds: 3, weight: 68 },
  banana: { id: "banana", glyph: "🍌", color: "#ffd23f", lineOdds: 4, weight: 54 },
  melon:  { id: "melon",  glyph: "🍈", color: "#90be6d", lineOdds: 5, weight: 42 },
  bell:   { id: "bell",   glyph: "🔔", color: "#ffd24a", lineOdds: 6, weight: 22 },
  bar:    { id: "bar",    glyph: "BAR", color: "#5bc0ff", lineOdds: 8, weight: 10 },
  bar2:   { id: "bar2",   glyph: "BAR²", color: "#5b8cff", lineOdds: 10, weight: 4 },
  bar3:   { id: "bar3",   glyph: "BAR³", color: "#7b6bff", lineOdds: 12, weight: 1.6 },
  blue7:  { id: "blue7",  glyph: "7", color: "#3b82f6", lineOdds: 16, weight: 0.6 },
  red7:   { id: "red7",   glyph: "7", color: "#ef4444", lineOdds: 20, weight: 0.28 },
  gold7:  { id: "gold7",  glyph: "7", color: "#ffd24a", lineOdds: 1000, weight: 0.02 },
  wild:   { id: "wild",   glyph: "✨", color: "#fff27a", lineOdds: 0, weight: 4 },
};

/** 氷（凍結）出現率＝新しい全体RTPダイヤル。凍ったセルは溶けるまで役に使えない
 *  （隣接セルが役成立で溶ける）。出現率を上げるほど実効マッチ率↓＝RTP↓。rtpで較正。 */
export let FREEZE_RATE = 0.5;
export function setFreezeRate(x: number): void { FREEZE_RATE = x; }
function freezeRoll(): boolean { return Math.random() < FREEZE_RATE; }

export const COLS = 3;
export const ROWS = 3;
export const WILD_USES = 5;

/** マスター階段（昇順・999上限）。各土台シンボルは自分の lineOdds の位置から開始。 */
export const ODDS_LADDER = [
  1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20,
  25, 30, 40, 50, 75, 100, 150, 200, 300, 400, 500, 750, 999,
];
const LADDER_MAX = ODDS_LADDER.length - 1;
/** 土台シンボル → 開始インデックス（lineOdds が階段の何番目か） */
const BASE_INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (const id of BASE_SYMS) m[id] = ODDS_LADDER.indexOf(DSYMBOLS[id].lineOdds);
  return m;
})();

/** GOLD7 のライン固定配当 */
const GOLD7_LINE = 1000;

// ---- コネクトボーナス表（個数×シンボル）★赤7・3個=8を確定アンカー。
//      中位(個数3〜4の右端)は画像読み取りの仮値。要最終確認。 -----------
// 列順は BASE_SYMS（cherry…red7）。gold7 はコネクト無し（激レア）。
const CONNECT: Record<number, Partial<Record<DSym, number>>> = {
  9: row([100, 200, 300, 400, 500, 1000, 2000, 3000, 5000, 8000, 10000]),
  8: row([50, 100, 150, 200, 250, 500, 1000, 1500, 2500, 4000, 5000]),
  7: row([10, 20, 30, 40, 50, 100, 200, 300, 500, 800, 1000]),
  6: row([4, 8, 12, 16, 20, 40, 80, 120, 200, 320, 400]),
  5: row([1, 2, 3, 4, 5, 10, 20, 30, 50, 80, 100]),
  4: row([0, 0, 0, 1, 2, 4, 8, 12, 16, 30, 50]), // 赤7=50（確定）, 青7=30(仮)
  3: row([0, 0, 0, 0, 1, 2, 3, 4, 8, 12, 20]),   // 青7=12・赤7=20（確定）
};
function row(vals: number[]): Partial<Record<DSym, number>> {
  const o: Partial<Record<DSym, number>> = {};
  BASE_SYMS.forEach((id, i) => (o[id] = vals[i] ?? 0));
  return o;
}
function connectPay(sym: DSym, count: number): number {
  if (sym === "gold7" || sym === "wild") return 0;
  const n = Math.min(9, count);
  return CONNECT[n]?.[sym] ?? 0;
}

/** コンボ（連鎖）倍率：4連鎖から。15〜30は1024固定、31以上は0（打ち止め）。 */
const COMBO_MULT = [0, 0, 0, 0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
function comboMult(chain: number): number {
  if (chain < 4) return 0;
  if (chain > 30) return 0;
  if (chain >= 14) return 1024;
  return COMBO_MULT[chain] ?? 0;
}

/** 8ライン（縦3・横3・斜め2）。各セルは [col,row]。 */
const LINES: Array<Array<[number, number]>> = [
  // 横3
  [[0, 0], [1, 0], [2, 0]],
  [[0, 1], [1, 1], [2, 1]],
  [[0, 2], [1, 2], [2, 2]],
  // 縦3
  [[0, 0], [0, 1], [0, 2]],
  [[1, 0], [1, 1], [1, 2]],
  [[2, 0], [2, 1], [2, 2]],
  // 斜め2
  [[0, 0], [1, 1], [2, 2]],
  [[2, 0], [1, 1], [0, 2]],
];

// ---- 隣接規則（旧版踏襲：直交は常時、斜めは中央絡みのみ） -------------
const CENTER_C = (COLS - 1) / 2;
const CENTER_R = (ROWS - 1) / 2;
const isCenter = (c: number, r: number) => c === CENTER_C && r === CENTER_R;
export function neighbors(c: number, r: number): Array<[number, number]> {
  const dirs: Array<[number, number, boolean]> = [
    [1, 0, false], [-1, 0, false], [0, 1, false], [0, -1, false],
    [1, 1, true], [1, -1, true], [-1, 1, true], [-1, -1, true],
  ];
  const out: Array<[number, number]> = [];
  for (const [dc, dr, diag] of dirs) {
    const nc = c + dc, nr = r + dr;
    if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
    if (diag && !isCenter(c, r) && !isCenter(nc, nr)) continue;
    out.push([nc, nr]);
  }
  return out;
}

// ---- 型 -----------------------------------------------------------
export type DGrid = DSym[][]; // grid[col][row]

export interface LineWin { line: number; symbol: DSym; odds: number; pay: number; cells: Array<[number, number]>; }
export interface ConnectWin { symbol: DSym; count: number; pay: number; cells: Array<[number, number]>; }
export interface CascadeStep {
  chain: number;
  lineWins: LineWin[];
  connectWins: ConnectWin[];
  comboMult: number;
  comboPay: number;
  cleared: Array<[number, number]>;
  stepWin: number;
  gridAfter: DGrid;
  wildAfter: number[][];
  /** frozenAfter[col][row] = 落下後の凍結状態（true=氷） */
  frozenAfter: boolean[][];
  /** このステップで溶けた氷のセル（演出用） */
  melted: Array<[number, number]>;
  oddsAfter: Record<string, number>; // 表示用：各土台シンボルの現在オッズ
  from: number[][];
  previewAfter: DSym[][];
}
export interface DropResult {
  initial: DGrid;
  initialWild: number[][];
  /** 初期盤面の凍結状態（true=氷） */
  initialFrozen: boolean[][];
  initialPreview: DSym[][];
  oddsStart: Record<string, number>;
  steps: CascadeStep[];
  totalWin: number;
  maxChain: number;
  /** コンボボーナス（連鎖終了時に1回。4連鎖以上で BET×倍率） */
  comboMult: number;
  comboPay: number;
}

// ---- 抽選 ---------------------------------------------------------
let POOL: DSym[] = buildPool();
function buildPool(): DSym[] {
  // 小数の重みも扱えるよう ×100 して丸める（gold7=0.02 等を切り捨てない）。
  const p: DSym[] = [];
  for (const id of Object.keys(DSYMBOLS) as DSym[]) {
    const n = Math.round(DSYMBOLS[id].weight * 100);
    for (let i = 0; i < n; i++) p.push(id);
  }
  return p;
}
/** 重み(DSYMBOLS[*].weight)を書き換えた後に呼ぶとプールを作り直す（RTP調整用）。 */
export function rebuildPool(): void { POOL = buildPool(); }
function pick(): DSym { return POOL[(Math.random() * POOL.length) | 0]; }
export function randomDropSymbol(): DSym { return pick(); }

function randomBoard(): { grid: DGrid; frozen: boolean[][] } {
  const g: DGrid = [], f: boolean[][] = [];
  for (let c = 0; c < COLS; c++) {
    const col: DSym[] = [], fc: boolean[] = [];
    for (let r = 0; r < ROWS; r++) { col.push(pick()); fc.push(freezeRoll()); }
    g.push(col); f.push(fc);
  }
  return { grid: g, frozen: f };
}
function cloneGrid(g: DGrid): DGrid { return g.map((c) => c.slice()); }
function wildChargesOf(g: DGrid): number[][] {
  return g.map((col) => col.map((id) => (id === "wild" ? WILD_USES : 0)));
}

// ---- ライン判定（wild 代用） --------------------------------------
/** ライン上の3セルが揃うか。揃う場合その土台シンボルを返す（全wildやgold混在は別途）。 */
function lineSymbol(g: DGrid, fz: boolean[][], cells: Array<[number, number]>): DSym | null {
  let base: DSym | null = null;
  for (const [c, r] of cells) {
    if (fz[c][r]) return null; // 氷が1つでもあればライン不成立（溶けるまで使えない）
    const s = g[c][r];
    if (s === "wild") continue;
    if (base === null) base = s;
    else if (base !== s) return null;
  }
  // 全部ワイルド（base=null）は全シンボル代用＝最高位 red7 として成立させる
  return base ?? "red7";
}

// ---- コネクト判定（同シンボルの隣接クラスター。wild 代用） -----------
export function findConnects(g: DGrid, fz: boolean[][]): ConnectWin[] {
  const bases = new Set<DSym>();
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
    if (fz[c][r]) continue; // 氷は役に使えない
    const s = g[c][r];
    if (s !== "wild") bases.add(s);
  }
  const out: ConnectWin[] = [];
  const claimed = new Set<string>(); // 土台セルのみ確定（wildは共有可）
  // 価値の高い順に貪欲確定
  const order = [...bases].sort(
    (a, b) => BASE_SYMS.indexOf(b) - BASE_SYMS.indexOf(a)
  );
  for (const base of order) {
    if (base === "gold7") continue; // gold7 はコネクト対象外
    const match = (c: number, r: number) => !fz[c][r] && (g[c][r] === base || g[c][r] === "wild");
    const seen = Array.from({ length: COLS }, () => new Array(ROWS).fill(false));
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      if (seen[c][r] || !match(c, r)) continue;
      const comp: Array<[number, number]> = [];
      const stack: Array<[number, number]> = [[c, r]];
      seen[c][r] = true;
      while (stack.length) {
        const [cc, rr] = stack.pop()!;
        comp.push([cc, rr]);
        for (const [nc, nr] of neighbors(cc, rr)) {
          if (!seen[nc][nr] && match(nc, nr)) { seen[nc][nr] = true; stack.push([nc, nr]); }
        }
      }
      // 土台セル（wild以外）が未確定のものだけ採用
      const free = comp.filter(([fc, fr]) => g[fc][fr] === "wild" || !claimed.has(`${fc},${fr}`));
      const hasBase = free.some(([fc, fr]) => g[fc][fr] === base);
      if (free.length >= 3 && hasBase) {
        const pay = connectPay(base, free.length);
        for (const [fc, fr] of free) if (g[fc][fr] !== "wild") claimed.add(`${fc},${fr}`);
        out.push({ symbol: base, count: free.length, pay, cells: free });
      }
    }
  }
  // 純ワイルドのみの隣接(3個以上)＝全シンボル代用なので最高位 red7 のコネクトとして支払う
  const covered = new Set<string>();
  for (const w of out) for (const [c, r] of w.cells) covered.add(`${c},${r}`);
  const seenW = Array.from({ length: COLS }, () => new Array(ROWS).fill(false));
  const wildAt = (c: number, r: number) => g[c][r] === "wild" && !fz[c][r];
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
    if (seenW[c][r] || !wildAt(c, r) || covered.has(`${c},${r}`)) continue;
    const comp: Array<[number, number]> = [];
    const stack: Array<[number, number]> = [[c, r]];
    seenW[c][r] = true;
    while (stack.length) {
      const [cc, rr] = stack.pop()!;
      comp.push([cc, rr]);
      for (const [nc, nr] of neighbors(cc, rr))
        if (!seenW[nc][nr] && wildAt(nc, nr) && !covered.has(`${nc},${nr}`)) {
          seenW[nc][nr] = true; stack.push([nc, nr]);
        }
    }
    if (comp.length >= 3)
      out.push({ symbol: "red7", count: comp.length, pay: connectPay("red7", comp.length), cells: comp });
  }
  return out;
}

// ---- 落下＆補充（旧版踏襲） ---------------------------------------
export const PREVIEW_ROWS = 1;
function collapse(
  g: DGrid, ch: number[][], fz: boolean[][], cleared: Array<[number, number]>, streams: DSym[][]
): { grid: DGrid; charges: number[][]; frozen: boolean[][]; from: number[][] } {
  const clearedSet = new Set(cleared.map(([c, r]) => `${c},${r}`));
  const out: DGrid = [], outCh: number[][] = [], outFz: boolean[][] = [], from: number[][] = [];
  for (let c = 0; c < COLS; c++) {
    const survivors: Array<{ sym: DSym; charge: number; frozen: boolean; row: number }> = [];
    for (let r = 0; r < ROWS; r++)
      if (!clearedSet.has(`${c},${r}`))
        survivors.push({ sym: g[c][r], charge: ch[c][r], frozen: fz[c][r], row: r });
    const spawnCount = ROWS - survivors.length;
    const taken = streams[c].splice(0, spawnCount);
    while (streams[c].length < PREVIEW_ROWS + 3) streams[c].push(pick());
    const col: DSym[] = new Array(ROWS);
    const colCh: number[] = new Array(ROWS);
    const colFz: boolean[] = new Array(ROWS);
    const colFrom: number[] = new Array(ROWS);
    for (let j = 0; j < spawnCount; j++) {
      const rr = spawnCount - 1 - j;
      col[rr] = taken[j];
      colCh[rr] = taken[j] === "wild" ? WILD_USES : 0;
      colFz[rr] = false; // NEXT(補充)からは氷は降ってこない（初期9マスのみ氷）
      colFrom[rr] = rr - spawnCount;
    }
    for (let i = 0; i < survivors.length; i++) {
      const fr = spawnCount + i;
      col[fr] = survivors[i].sym; colCh[fr] = survivors[i].charge;
      colFz[fr] = survivors[i].frozen; colFrom[fr] = survivors[i].row;
    }
    out.push(col); outCh.push(colCh); outFz.push(colFz); from.push(colFrom);
  }
  return { grid: out, charges: outCh, frozen: outFz, from };
}
function previewOf(streams: DSym[][]): DSym[][] {
  return streams.map((s) => s.slice(0, PREVIEW_ROWS));
}

// ---- オッズ状態 ---------------------------------------------------
function freshOdds(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const id of BASE_SYMS) o[id] = BASE_INDEX[id]; // 階段インデックス
  return o;
}
function oddsValue(oddsIdx: Record<string, number>, sym: DSym): number {
  if (sym === "gold7") return GOLD7_LINE;
  return ODDS_LADDER[oddsIdx[sym] ?? 0];
}
/** 検証用：false でオッズ上昇を無効化 */
export const TUNING = { escalate: true };
/** symbol がライン成立 → そのシンボル以上を1段上昇（gold7は対象外） */
function raiseOdds(oddsIdx: Record<string, number>, sym: DSym): void {
  if (!TUNING.escalate) return;
  if (sym === "gold7" || sym === "wild") return;
  const base = BASE_INDEX[sym];
  for (const id of BASE_SYMS)
    if (BASE_INDEX[id] >= base) oddsIdx[id] = Math.min(LADDER_MAX, oddsIdx[id] + 1);
}

// ---- 1プレイ -----------------------------------------------------
/**
 * @param bet         1スピンのベット（=「1BET」。totalBet ではなく単一ベット単位）
 * @param oddsCarry   フリーゲーム用に持ち越すオッズ状態（無ければ新規）
 */
export function play(bet: number, oddsCarry?: Record<string, number>): DropResult {
  const board = randomBoard();
  const initial = board.grid;
  const initialFrozen = board.frozen;
  const streams: DSym[][] = Array.from({ length: COLS }, () =>
    Array.from({ length: PREVIEW_ROWS + 4 }, () => pick())
  );
  const initialPreview = previewOf(streams);
  const initialWild = wildChargesOf(initial);
  const oddsIdx = oddsCarry ? { ...oddsCarry } : freshOdds();
  const oddsStart = { ...oddsIdx };

  let grid = cloneGrid(initial);
  let charges = wildChargesOf(initial);
  let frozen = initialFrozen.map((c) => c.slice());
  const steps: CascadeStep[] = [];
  let chain = 0, total = 0;
  const MAX_CHAIN = 30;

  while (chain < MAX_CHAIN) {
    // --- ライン判定（氷は不参加。オッズは「現在値で支払い → その後上昇」） ---
    const lineWins: LineWin[] = [];
    for (let li = 0; li < LINES.length; li++) {
      const cells = LINES[li];
      const sym = lineSymbol(grid, frozen, cells);
      if (sym === null) continue;
      const odds = oddsValue(oddsIdx, sym);
      const pay = bet * odds;
      lineWins.push({ line: li, symbol: sym, odds, pay, cells: cells.map(([c, r]) => [c, r]) });
    }
    // --- コネクト判定（氷は不参加） ---
    const connectWins = findConnects(grid, frozen).map((w) => ({ ...w, pay: bet * w.pay }))
      .filter((w) => w.pay > 0 || w.count >= 3);
    if (lineWins.length === 0 && connectWins.length === 0) break;
    chain++;

    for (const w of lineWins) raiseOdds(oddsIdx, w.symbol);

    // 役に使われたセル
    const winCells = new Set<string>();
    for (const w of lineWins) for (const [c, r] of w.cells) winCells.add(`${c},${r}`);
    for (const w of connectWins) for (const [c, r] of w.cells) winCells.add(`${c},${r}`);

    // --- 氷を溶かす：役セルに隣接する氷 → このステップ末で解凍（次カスケードから有効） ---
    frozen = frozen.map((col) => col.slice());
    const melted: Array<[number, number]> = [];
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      if (!frozen[c][r]) continue;
      if (neighbors(c, r).some(([nc, nr]) => winCells.has(`${nc},${nr}`))) {
        frozen[c][r] = false; melted.push([c, r]);
      }
    }

    // --- 消去：役セル（氷は役に入らないので対象外）。wild5は減算で生存 ---
    charges = charges.map((col) => col.slice());
    const cleared: Array<[number, number]> = [];
    for (const key of winCells) {
      const [c, r] = key.split(",").map(Number);
      if (grid[c][r] === "wild" && charges[c][r] > 1) charges[c][r] -= 1;
      else cleared.push([c, r]);
    }

    const stepWin =
      lineWins.reduce((s, w) => s + w.pay, 0) +
      connectWins.reduce((s, w) => s + w.pay, 0);
    total += stepWin;

    const { grid: after, charges: chAfter, frozen: fzAfter, from } =
      collapse(grid, charges, frozen, cleared, streams);
    steps.push({
      chain, lineWins, connectWins, comboMult: 0, comboPay: 0,
      cleared, stepWin, gridAfter: after, wildAfter: chAfter,
      frozenAfter: fzAfter, melted,
      oddsAfter: { ...oddsIdx }, from, previewAfter: previewOf(streams),
    });
    grid = after; charges = chAfter; frozen = fzAfter;
  }

  // コンボボーナスは連鎖終了時に1回（4連鎖以上で BET×倍率）
  const cMult = comboMult(chain);
  const comboPay = cMult > 0 ? bet * cMult : 0;
  total += comboPay;

  return {
    initial, initialWild, initialFrozen, initialPreview, oddsStart,
    steps, totalWin: total, maxChain: chain,
    comboMult: cMult, comboPay,
  };
}
