// ===== シンボル定義 ===============================================
// すべてオリジナルの「夜空 × ジェム」テーマ。グリフは絵文字で表現。
// pay[n] = n個揃い時の配当倍率（ラインベット1枚あたり）。

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

export interface SymbolDef {
  id: SymbolId;
  glyph: string;
  name: string;
  /** テーマカラー（発光やハイライトに使用） */
  color: string;
  /** 揃い配当（ラインベット倍率）。3〜5個。 */
  pay: { 3: number; 4: number; 5: number };
  /** リール上の出現重み（大きいほど出やすい） */
  weight: number;
  /** 高配当シンボルか（リーチ演出の判定に使用） */
  premium?: boolean;
}

export const WILD: SymbolId = "wild";
export const SCATTER: SymbolId = "scatter";

export const SYMBOLS: Record<SymbolId, SymbolDef> = {
  drop: {
    id: "drop",
    glyph: "💧",
    name: "ドロップ",
    color: "#4fc3ff",
    pay: { 3: 5, 4: 15, 5: 50 },
    weight: 30,
  },
  bgem: {
    id: "bgem",
    glyph: "🔷",
    name: "ブルージェム",
    color: "#5b8cff",
    pay: { 3: 5, 4: 20, 5: 60 },
    weight: 26,
  },
  ggem: {
    id: "ggem",
    glyph: "💚",
    name: "グリーンジェム",
    color: "#3ddc84",
    pay: { 3: 8, 4: 25, 5: 80 },
    weight: 24,
  },
  pgem: {
    id: "pgem",
    glyph: "🔮",
    name: "パープルジェム",
    color: "#b06bff",
    pay: { 3: 10, 4: 30, 5: 100 },
    weight: 22,
  },
  bell: {
    id: "bell",
    glyph: "🔔",
    name: "ベル",
    color: "#ffd24a",
    pay: { 3: 15, 4: 50, 5: 150 },
    weight: 16,
  },
  cherry: {
    id: "cherry",
    glyph: "🍒",
    name: "チェリー",
    color: "#ff5c7a",
    pay: { 3: 20, 4: 60, 5: 200 },
    weight: 14,
  },
  star: {
    id: "star",
    glyph: "⭐",
    name: "スター",
    color: "#ffe14a",
    pay: { 3: 30, 4: 100, 5: 400 },
    weight: 9,
    premium: true,
  },
  seven: {
    id: "seven",
    glyph: "7️⃣",
    name: "セブン",
    color: "#ff3b6b",
    pay: { 3: 50, 4: 200, 5: 888 },
    weight: 5,
    premium: true,
  },
  wild: {
    id: "wild",
    glyph: "✨",
    name: "ワイルドファイブ",
    color: "#fff27a",
    pay: { 3: 50, 4: 250, 5: 1000 },
    weight: 4,
    premium: true,
  },
  scatter: {
    id: "scatter",
    glyph: "🌟",
    name: "RUSHスキャッター",
    color: "#ffb000",
    // スキャッター配当はトータルベット倍率で別計算（paylines.ts）。
    pay: { 3: 2, 4: 10, 5: 50 },
    weight: 5,
  },
};

export const ALL_SYMBOL_IDS = Object.keys(SYMBOLS) as SymbolId[];

export function sym(id: SymbolId): SymbolDef {
  return SYMBOLS[id];
}
