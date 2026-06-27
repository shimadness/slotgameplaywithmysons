// ===== シンボル定義（和・天狗テーマ / TENGU KING 化） =================
// 「左詰め全リール方式」。pay[n] = n個そろい時の配当倍率（1スピンベット倍率）。
// ★配当は 2個そろいから発生（pay[2] を新設）。
// docs/TENGU_KING_DESIGN.md 参照。

export type SymbolId =
  | "drop"
  | "bgem"
  | "ggem"
  | "pgem"
  | "bell"
  | "cherry"
  | "star"
  | "seven"
  | "wild"
  | "scatter";

/** そろい数→配当倍率（2〜5個）。ワイルド/天狗は揃い配当を持たない＝空。 */
export type PayTable = Partial<Record<2 | 3 | 4 | 5, number>>;

export interface SymbolDef {
  id: SymbolId;
  glyph: string;
  name: string;
  /** テーマカラー（発光やハイライトに使用） */
  color: string;
  /** 揃い配当（1スピンベット倍率）。2〜5個。 */
  pay: PayTable;
  /** リール上の出現重み（大きいほど出やすい） */
  weight: number;
  /** 高配当シンボルか（リーチ演出の判定に使用） */
  premium?: boolean;
}

export const WILD: SymbolId = "wild";
export const SCATTER: SymbolId = "scatter";

export const SYMBOLS: Record<SymbolId, SymbolDef> = {
  // ----- 弱 -----（pay は1スピンベット倍率。0.05刻み・×20で整数。RTP≈96%調整済み）
  // ※ワイルド花火はフリー中だけ。通常はこの素の配当のみ。
  drop: {
    id: "drop",
    glyph: "🪙",
    name: "小判",
    color: "#e7b94a",
    pay: { 2: 0.1, 3: 0.4, 4: 1.1, 5: 4.0 },
    weight: 30,
  },
  bgem: {
    id: "bgem",
    glyph: "🪭",
    name: "扇",
    color: "#d8556a",
    pay: { 2: 0.1, 3: 0.4, 4: 1.6, 5: 4.8 },
    weight: 26,
  },
  ggem: {
    id: "ggem",
    glyph: "📜",
    name: "巻物",
    color: "#cbb88a",
    pay: { 2: 0.15, 3: 0.65, 4: 1.9, 5: 6.5 },
    weight: 24,
  },
  // ----- 中 -----
  pgem: {
    id: "pgem",
    glyph: "🍶",
    name: "徳利",
    color: "#7fb6d6",
    pay: { 2: 0.15, 3: 0.8, 4: 2.4, 5: 8.0 },
    weight: 22,
  },
  bell: {
    id: "bell",
    glyph: "🔔",
    name: "鈴",
    color: "#ffd24a",
    pay: { 2: 0.25, 3: 1.1, 4: 4.0, 5: 11 },
    weight: 16,
  },
  cherry: {
    id: "cherry",
    glyph: "🎴",
    name: "だるま",
    color: "#e23b3b",
    pay: { 2: 0.3, 3: 1.6, 4: 4.8, 5: 16 },
    weight: 14,
  },
  // ----- 強 -----
  star: {
    id: "star",
    glyph: "🐱",
    name: "招き猫",
    color: "#f2c14e",
    pay: { 2: 0.4, 3: 2.4, 4: 8.0, 5: 32 },
    weight: 9,
    premium: true,
  },
  seven: {
    id: "seven",
    glyph: "💰",
    name: "千両箱",
    color: "#ffcf33",
    pay: { 2: 0.8, 3: 4.0, 4: 16, 5: 65 },
    weight: 5,
    premium: true,
  },
  // ----- ワイルド（代用＋花火倍率。揃い配当は持たない） -----
  wild: {
    id: "wild",
    glyph: "🔨",
    name: "打ち出の小槌",
    color: "#fff27a",
    pay: {},
    weight: 2, // リール2〜4のみ出現（engine.ts で制御）。希少＝花火を特別に
    premium: true,
  },
  // ----- 天狗（フリーゲーム突入トリガー。揃い配当は持たない・突入はレア） -----
  scatter: {
    id: "scatter",
    glyph: "👺",
    name: "天狗",
    color: "#c0392b",
    pay: {},
    weight: 5, // 突入率の調整つまみ（1/141 ≈ 1/128）（ハーネスで実測して決める）
  },
};

export const ALL_SYMBOL_IDS = Object.keys(SYMBOLS) as SymbolId[];

export function sym(id: SymbolId): SymbolDef {
  return SYMBOLS[id];
}
