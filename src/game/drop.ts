// ===== 3×3 ドロップ連鎖エンジン（パズル × スロット） =================
// 3×3・組み合わせ配当・連鎖(ドロップ)のオリジナル実装。各列は「ストリーム供給」式で、
// 次に落ちてくるシンボルを先読み表示（NEXTプレビュー）できる。
// 揃ったら消え、上から落ちて再判定 → 連鎖。
import type { SymbolId } from "./symbols";
import { SYMBOLS } from "./symbols";

export const COLS = 3;
export const ROWS = 3;
/** 各列の上に見せる「次に落ちてくる」シンボル数 */
export const PREVIEW_ROWS = 1;

/** ドロップモードで使うシンボル（スキャッターは使わない） */
const DROP_SYMBOLS: SymbolId[] = [
  "drop",
  "bgem",
  "ggem",
  "pgem",
  "bell",
  "cherry",
  "star",
  "seven",
  "wild",
];

/** クラスター1セルあたりの基礎配当（ラインBET倍率） */
const CLUSTER_VALUE: Record<string, number> = {
  drop: 1,
  bgem: 2,
  ggem: 2,
  pgem: 3,
  bell: 4,
  cherry: 6,
  star: 10,
  seven: 20,
  wild: 40, // ワイルドは接続役で実際は未使用（cl.symbol は常に土台シンボル）
};

/** ワイルドファイブ＝消えずに最大この回数まで使える代用ワイルド */
export const WILD_USES = 5;

/** 連鎖数 → 倍率ラダー（1連鎖目=1倍。深い連鎖の爆発を少し抑制） */
const CHAIN_MULT = [1, 2, 3, 4, 6, 9, 14];

/** この連鎖数以上に到達すると RUSH 突入（高めにして突入をレアに） */
export const RUSH_CHAIN = 6;
export const RUSH_PLAYS = 6;
export const RUSH_MULTIPLIER = 2;
/** 1回のRUSHで付与できる総フリースピン数の上限（上乗せ暴走の抑制） */
export const RUSH_MAX_SPINS = 24;

// ===== ペイアウト率（RTP）制御 =======================================
// ゲーセンの「設定」のように、目標RTPを設計値として持つ。
// 実際の配当 = 素の配当 × payoutScale。payoutScale は
//   目標RTP ÷ RAW_RTP（スケール1.0時に実測した素のRTP）。
/** 設定（1〜6）→ 目標ペイアウト率 */
export const SETTEI_RTP: Record<number, number> = {
  1: 0.90,
  2: 0.92,
  3: 0.94,
  4: 0.95,
  5: 0.96,
  6: 0.97,
};
export const DEFAULT_SETTEI = 4; // 既定=95%
/** 構造（配当・RUSH）固定で実測・較正した「素のRTP」基準値。
 *  scale=1.0 の素RTP≈747%（共有ワイルド導入で上昇）。丸め下限の影響込みで
 *  操作点(設定4)が約95%になるよう較正（測定はRUSH由来で±3%程度ばらつく）。
 *  構造を変えたら `npm run rtp` で再計測して更新する。 */
export const RAW_RTP = 7.6;
/** 設定 → 配当スケール係数 */
export function payoutScaleFor(settei: number): number {
  const target = SETTEI_RTP[settei] ?? SETTEI_RTP[DEFAULT_SETTEI];
  return target / RAW_RTP;
}

/** grid[col][row]、row 0 = 最上段 */
export type DGrid = SymbolId[][];

export interface Cluster {
  symbol: SymbolId;
  cells: Array<[number, number]>; // [col,row]
  size: number;
  amount: number;
}

export interface CascadeStep {
  chain: number; // 1始まりの連鎖番号
  multiplier: number;
  clusters: Cluster[];
  cleared: Array<[number, number]>;
  stepWin: number;
  /** 落下後のグリッド（次ステップの入力） */
  gridAfter: DGrid;
  /** wildAfter[col][row] = ワイルドファイブの残り回数（0=非ワイルド） */
  wildAfter: number[][];
  /** from[col][finalRow] = 落下元の行（負値＝上のプレビューから落下） */
  from: number[][];
  /** このステップの落下・補充後に見せる NEXT プレビュー */
  previewAfter: SymbolId[][];
}

export interface DropResult {
  initial: DGrid;
  /** 初期グリッドのワイルドファイブ残り回数（0=非ワイルド） */
  initialWild: number[][];
  /** 初期状態で各列の上に見せる NEXT プレビュー [col][idx]（idx0=最も手前） */
  initialPreview: SymbolId[][];
  steps: CascadeStep[];
  totalWin: number;
  maxChain: number;
  triggeredRush: boolean;
}

function weightedPool(): SymbolId[] {
  const pool: SymbolId[] = [];
  for (const id of DROP_SYMBOLS) {
    const w = id === "wild" ? 2 : SYMBOLS[id].weight; // ワイルドファイブはレア（少し下げる）
    for (let i = 0; i < w; i++) pool.push(id);
  }
  return pool;
}
const POOL = weightedPool();

function pick(): SymbolId {
  return POOL[(Math.random() * POOL.length) | 0];
}

/** UI のリール回転演出で使う、ドロップ用のランダムシンボル */
export function randomDropSymbol(): SymbolId {
  return pick();
}

function randomGrid(): DGrid {
  const g: DGrid = [];
  for (let c = 0; c < COLS; c++) {
    const col: SymbolId[] = [];
    for (let r = 0; r < ROWS; r++) col.push(pick());
    g.push(col);
  }
  return g;
}

function cloneGrid(g: DGrid): DGrid {
  return g.map((col) => col.slice());
}

/** グリッドから初期ワイルド残り回数を作る（ワイルド=WILD_USES、他=0） */
function wildChargesOf(g: DGrid): number[][] {
  return g.map((col) => col.map((id) => (id === "wild" ? WILD_USES : 0)));
}

const CENTER_C = (COLS - 1) / 2;
const CENTER_R = (ROWS - 1) / 2;
const isCenter = (c: number, r: number) => c === CENTER_C && r === CENTER_R;

/**
 * 「道」で繋がる隣接セルを返す（判定・道の描画の単一の真実源）。
 * - タテ・ヨコ（直交）は常に接続。
 * - ナナメは **中央マスに接続する場合のみ** 有効（角↔中央）。
 *   列・行の中央どうし（例: 2-4, 2-6, 4-8, 6-8）の斜めは繋がない＝繋がりすぎ防止。
 */
export function neighbors(c: number, r: number): Array<[number, number]> {
  const dirs: Array<[number, number, boolean]> = [
    [1, 0, false], [-1, 0, false], [0, 1, false], [0, -1, false], // 直交
    [1, 1, true], [1, -1, true], [-1, 1, true], [-1, -1, true], // 斜め
  ];
  const out: Array<[number, number]> = [];
  for (const [dc, dr, diag] of dirs) {
    const nc = c + dc;
    const nr = r + dr;
    if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
    if (diag && !isCenter(c, r) && !isCenter(nc, nr)) continue; // 中央絡みの斜めだけ
    out.push([nc, nr]);
  }
  return out;
}

/** クラスターを検出（道の接続規則 = neighbors()。ワイルドは隣接ベースに同化） */
function findClusters(g: DGrid): Cluster[] {
  interface Cand {
    base: SymbolId;
    cells: Array<[number, number]>;
  }
  const cands: Cand[] = [];

  const bases = new Set<SymbolId>();
  for (let c = 0; c < COLS; c++)
    for (let r = 0; r < ROWS; r++) {
      const s = g[c][r];
      if (s !== "wild") bases.add(s);
    }

  for (const base of bases) {
    const matches = (c: number, r: number) =>
      g[c][r] === base || g[c][r] === "wild";
    const seen = Array.from({ length: COLS }, () => new Array(ROWS).fill(false));
    for (let c = 0; c < COLS; c++)
      for (let r = 0; r < ROWS; r++) {
        if (seen[c][r] || !matches(c, r)) continue;
        const comp: Array<[number, number]> = [];
        const stack: Array<[number, number]> = [[c, r]];
        seen[c][r] = true;
        while (stack.length) {
          const [cc, rr] = stack.pop()!;
          comp.push([cc, rr]);
          // 「道」で繋がる隣接のみ伝播（直交＋中央絡みの斜め）
          for (const [nc, nr] of neighbors(cc, rr)) {
            if (!seen[nc][nr] && matches(nc, nr)) {
              seen[nc][nr] = true;
              stack.push([nc, nr]);
            }
          }
        }
        if (comp.length >= 3) cands.push({ base, cells: comp });
      }
  }

  // 価値の高いクラスターから貪欲にセルを確定する。
  // ワイルドファイブは「消えずに最大5回使える代用」なので、1つのワイルドが
  // 複数のクラスター（別シンボル）を同時に成立させてよい＝独占クレームしない。
  // 一方、土台シンボルのセルは二重取りを防ぐため1クラスターに確定する。
  cands.sort(
    (a, b) =>
      CLUSTER_VALUE[b.base] * b.cells.length -
      CLUSTER_VALUE[a.base] * a.cells.length
  );
  const claimed = new Set<string>(); // 土台シンボルのセルのみ確定（ワイルドは含めない）
  const clusters: Cluster[] = [];
  for (const cand of cands) {
    // ワイルドは常に共有可、土台セルは未確定のものだけ使える
    const free = cand.cells.filter(
      ([c, r]) => g[c][r] === "wild" || !claimed.has(`${c},${r}`)
    );
    const hasBase = free.some(([c, r]) => g[c][r] === cand.base);
    if (free.length >= 3 && hasBase) {
      for (const [c, r] of free)
        if (g[c][r] !== "wild") claimed.add(`${c},${r}`); // 土台のみ確定
      clusters.push({ symbol: cand.base, cells: free, size: free.length, amount: 0 });
    }
  }
  return clusters;
}

/**
 * 消去後に重力で落とし、上から（各列のストリームから）補充。
 * ストリーム先頭が「次に落ちる手前」のシンボル。
 */
function collapse(
  g: DGrid,
  ch: number[][],
  cleared: Array<[number, number]>,
  streams: SymbolId[][]
): { grid: DGrid; charges: number[][]; from: number[][] } {
  const clearedSet = new Set(cleared.map(([c, r]) => `${c},${r}`));
  const out: DGrid = [];
  const outCh: number[][] = [];
  const from: number[][] = [];

  for (let c = 0; c < COLS; c++) {
    // 消えなかったセル（生き残ったワイルドファイブは残り回数を保持して落下）
    const survivors: Array<{ sym: SymbolId; charge: number; row: number }> = [];
    for (let r = 0; r < ROWS; r++) {
      if (!clearedSet.has(`${c},${r}`))
        survivors.push({ sym: g[c][r], charge: ch[c][r], row: r });
    }
    const spawnCount = ROWS - survivors.length;
    // ストリーム先頭から spawnCount 個取り出す（taken[0] = 最も手前）
    const taken = streams[c].splice(0, spawnCount);
    while (streams[c].length < PREVIEW_ROWS + 3) streams[c].push(pick());

    const col: SymbolId[] = new Array(ROWS);
    const colCh: number[] = new Array(ROWS);
    const colFrom: number[] = new Array(ROWS);
    // 手前(taken[0])ほど低い行に着地。上側ほど後から来たシンボル。
    for (let j = 0; j < spawnCount; j++) {
      const row = spawnCount - 1 - j;
      col[row] = taken[j];
      colCh[row] = taken[j] === "wild" ? WILD_USES : 0; // 新規ワイルドは5回ぶん
      colFrom[row] = row - spawnCount; // 負値（プレビュー域から落下）
    }
    for (let i = 0; i < survivors.length; i++) {
      const finalRow = spawnCount + i;
      col[finalRow] = survivors[i].sym;
      colCh[finalRow] = survivors[i].charge;
      colFrom[finalRow] = survivors[i].row;
    }
    out.push(col);
    outCh.push(colCh);
    from.push(colFrom);
  }
  return { grid: out, charges: outCh, from };
}

function previewOf(streams: SymbolId[][]): SymbolId[][] {
  return streams.map((s) => s.slice(0, PREVIEW_ROWS));
}

/**
 * 1プレイぶんの連鎖シーケンスを丸ごと計算する。
 * UI はこの steps を順番にアニメーションするだけでよい。
 */
export function play(
  lineBet: number,
  rushMultiplier = 1,
  payoutScale = 1
): DropResult {
  const initial = randomGrid();
  // 各列のストリーム（次に落ちてくる供給列）
  const streams: SymbolId[][] = Array.from({ length: COLS }, () =>
    Array.from({ length: PREVIEW_ROWS + 4 }, () => pick())
  );
  const initialPreview = previewOf(streams);
  const initialWild = wildChargesOf(initial);

  let grid = cloneGrid(initial);
  let charges = wildChargesOf(initial);
  const steps: CascadeStep[] = [];
  let chain = 0;
  let total = 0;
  const MAX_CHAIN = 12;

  while (chain < MAX_CHAIN) {
    const clusters = findClusters(grid);
    if (clusters.length === 0) break;
    chain++;
    const mult = CHAIN_MULT[Math.min(chain - 1, CHAIN_MULT.length - 1)];

    // 前ステップに保存した wildAfter を壊さないよう、作業用にコピーしてから減算する
    charges = charges.map((col) => col.slice());
    const cleared: Array<[number, number]> = [];
    let stepWin = 0;
    // 配当はクラスター毎に加算（共有ワイルドは両クラスターの配当に寄与する）
    for (const cl of clusters) {
      const raw =
        CLUSTER_VALUE[cl.symbol] * cl.size * mult * lineBet * rushMultiplier;
      // ペイアウト率（設定）を反映。最低1（有効クラスターが0配当にならないように）
      const amt = Math.max(1, Math.round(raw * payoutScale));
      cl.amount = amt;
      stepWin += amt;
    }
    // セルの消去／ワイルド減算は「セル単位で1回だけ」処理する。
    // （共有ワイルドが複数クラスターに跨っても、減算は1回・消去も1回）
    const processed = new Set<string>();
    for (const cl of clusters) {
      for (const [c, r] of cl.cells) {
        const key = `${c},${r}`;
        if (processed.has(key)) continue;
        processed.add(key);
        if (grid[c][r] === "wild" && charges[c][r] > 1) {
          // ワイルドファイブ：消えずに残り回数を1減らして生存（下へ落ちる）
          charges[c][r] -= 1;
        } else {
          // 通常シンボル、または残り1のワイルド（5回使い切り）→ 消去
          cleared.push([c, r]);
        }
      }
    }
    total += stepWin;

    const { grid: after, charges: chAfter, from } = collapse(
      grid,
      charges,
      cleared,
      streams
    );
    steps.push({
      chain,
      multiplier: mult,
      clusters,
      cleared,
      gridAfter: after,
      wildAfter: chAfter,
      from,
      previewAfter: previewOf(streams),
      stepWin,
    });
    grid = after;
    charges = chAfter;
  }

  return {
    initial,
    initialWild,
    initialPreview,
    steps,
    totalWin: total,
    maxChain: chain,
    triggeredRush: chain >= RUSH_CHAIN,
  };
}
