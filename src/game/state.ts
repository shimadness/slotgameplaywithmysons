// ===== ゲーム状態（プレイヤー別 クレジット / ベット / RUSH / 設定） ===
import { DEFAULT_SETTEI, SETTEI_RTP } from "./drop";

// ベット段（× FIVE_REEL_UNIT がクレジットの TOTAL BET）。
// 最大 500×20 = 10000（DROP の上限と揃える＝ランキング動線）。
export const LINE_BETS = [1, 2, 3, 5, 10, 20, 50, 100, 200, 500] as const;
export type LineBet = (typeof LINE_BETS)[number];

// 5リール（TENGU KING化）の単一ベット単位。配当は小数倍率(0.05刻み)なので、
// 「ベット段 × この単位」をクレジットベットにすると払い出しが整数になる。
// RTPはベット非依存（pay×bet と cost×bet で相殺）なので額面のみに作用する。
const FIVE_REEL_UNIT = 20;

// DROP モードのベット。5リールと同じ「BET▲で巡回 / MAX」式のプリセット段。
export const DROP_BET_MIN = 0;
export const DROP_BET_MAX = 10000;
/** DROPのベット段（BET▲で次の段へ巡回）。 */
export const DROP_BETS = [10, 50, 100, 500, 1000, 5000, 10000] as const;
const DROP_BET_DEFAULT = 100;
/** 任意値を「その値以下の最大プリセット」に丸める（旧セーブ値の吸着用）。 */
function snapDropBet(v: number): number {
  const found = [...DROP_BETS].reverse().find((p) => p <= v);
  return found ?? DROP_BETS[0];
}

// --- プレイヤー（3人分の別々のセーブ）-------------------------------
export const PLAYER_IDS = ["p1", "p2", "p3"] as const;
export type PlayerId = (typeof PLAYER_IDS)[number];
const DEFAULT_NAMES: Record<PlayerId, string> = {
  p1: "プレイヤー1",
  p2: "プレイヤー2",
  p3: "プレイヤー3",
};
const START_CREDITS = 3000;

const SAVE_PREFIX = "triple-slot.save."; // + playerId
const META_KEY = "triple-slot.meta"; // 名前 + 直近プレイヤー
const DU_KEY = "triple-slot.du"; // ダブルアップ ON/OFF（キャビネット共通）
const MODE_KEY = "triple-slot.mode"; // 現在モード（drop/slot）。リロード復帰用

interface PlayerSave {
  credits: number;
  lineBetIndex: number;
  settei: number;
  dropBet: number;
}
interface MetaSave {
  names: Record<PlayerId, string>;
  current: PlayerId | null;
}

export interface PlayerSummary {
  id: PlayerId;
  name: string;
  credits: number;
}

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage 不可環境は無視 */
  }
}

export class GameState {
  // 現在のプレイヤーの状態
  playerId: PlayerId = "p1";
  credits = START_CREDITS;
  lineBetIndex = 0; // LINE_BETS のインデックス（5リール用）
  dropBet = DROP_BET_DEFAULT; // DROPモードの単一ベット（DROP_BETS のいずれか）
  settei = DEFAULT_SETTEI; // （旧）ペイアウト率設定。DROPは固定配当化で未使用、5リール用に残置
  /** 現在モード（drop / slot）。**保存**する＝WebViewがリロードされても元のモードに復帰
      （iPhone SE等で AUTO+演出の負荷でWebViewが再読込→DROPに戻る不具合の対策）。 */
  mode: "drop" | "slot" = "drop";

  // 名前（3人分。プレイヤーごとに保存）
  names: Record<PlayerId, string> = { ...DEFAULT_NAMES };

  // RUSH（フリースピン）関連 — 一時状態（保存しない／プレイヤー切替でリセット）
  freeSpins = 0;
  freeSpinsTotal = 0;
  rushMultiplier = 1;
  inRush = false;

  lastWin = 0;

  /** ダブルアップ ON/OFF（キャビネット共通設定・保存）。OFFなら勝利を自動COLLECT。 */
  duEnabled = true;

  /** まだ誰も選んでいない（初回）なら true */
  firstRun = false;

  constructor() {
    const du = readJSON<boolean>(DU_KEY);
    this.duEnabled = typeof du === "boolean" ? du : true;
    const m = readJSON<string>(MODE_KEY);
    if (m === "drop" || m === "slot") this.mode = m;
    const meta = readJSON<MetaSave>(META_KEY);
    if (meta?.names) this.names = { ...DEFAULT_NAMES, ...meta.names };
    if (meta?.current && PLAYER_IDS.includes(meta.current)) {
      this.playerId = meta.current;
    } else {
      this.firstRun = true; // 初回はプレイヤー選択を出す
    }
    this.loadPlayer(this.playerId);
  }

  // --- プレイヤー -----------------------------------------------------
  get playerName(): string {
    return this.names[this.playerId];
  }

  /** 3人分の一覧（選択画面用。各自の残高も覗く） */
  allPlayers(): PlayerSummary[] {
    return PLAYER_IDS.map((id) => ({
      id,
      name: this.names[id],
      credits: this.peekCredits(id),
    }));
  }

  /** 指定プレイヤーの保存残高を覗く（未プレイなら初期値） */
  peekCredits(id: PlayerId): number {
    const s = readJSON<PlayerSave>(SAVE_PREFIX + id);
    return typeof s?.credits === "number" ? s.credits : START_CREDITS;
  }

  /** プレイヤーを切り替えてその人のデータを読み込む */
  switchPlayer(id: PlayerId): void {
    if (!PLAYER_IDS.includes(id)) return;
    this.playerId = id;
    this.firstRun = false;
    // RUSH等の一時状態はリセット
    this.inRush = false;
    this.freeSpins = 0;
    this.freeSpinsTotal = 0;
    this.rushMultiplier = 1;
    this.lastWin = 0;
    this.loadPlayer(id);
    this.saveMeta();
  }

  /** ダブルアップ ON/OFF を切替（保存）。 */
  setDuEnabled(on: boolean): void {
    this.duEnabled = on;
    writeJSON(DU_KEY, on);
  }

  /** 現在モードを切替（保存）。リロードされても復帰できるようにする。 */
  setMode(m: "drop" | "slot"): void {
    this.mode = m;
    writeJSON(MODE_KEY, m);
  }

  /** 名前変更 */
  setName(id: PlayerId, name: string): void {
    const trimmed = name.trim().slice(0, 12) || DEFAULT_NAMES[id];
    this.names[id] = trimmed;
    this.saveMeta();
  }

  // --- ベット / 設定 --------------------------------------------------
  get lineBet(): number {
    return LINE_BETS[this.lineBetIndex];
  }

  /** そのモードの配当倍率に使う「BET」単位（DROP=dropBet / 5リール=lineBet）。 */
  get bet(): number {
    return this.mode === "drop" ? this.dropBet : this.lineBet;
  }

  get totalBet(): number {
    // DROPは「1BET=全ライン有効」の単一ベット（dropBet そのもの）。
    // 5リールは単一ベット（ベット段 × FIVE_REEL_UNIT クレジット）。
    return this.mode === "drop" ? this.dropBet : this.lineBet * FIVE_REEL_UNIT;
  }

  cycleLineBet(): void {
    this.lineBetIndex = (this.lineBetIndex + 1) % LINE_BETS.length;
    this.save();
  }

  setMaxBet(): void {
    // 「いま張れる最大の段」を選ぶ（所持で買えない段は選ばない＝canSpinで弾かれない）。
    // どの段も買えない（所持 < 最小TOTAL BET）場合は最小段（index 0）。
    let idx = 0;
    for (let i = 0; i < LINE_BETS.length; i++) {
      if (LINE_BETS[i] * FIVE_REEL_UNIT <= this.credits) idx = i;
    }
    this.lineBetIndex = idx;
    this.save();
  }

  /** DROPベットを次のプリセット段へ巡回（5リールのBET▲と同方式）。 */
  cycleDropBet(): void {
    const next = DROP_BETS.find((v) => v > this.dropBet);
    this.dropBet = next ?? DROP_BETS[0];
    this.save();
  }

  /** DROPベットを「いま張れる最大のプリセット段」にする（買えなければ最小段）。 */
  setDropMaxBet(): void {
    const affordable = [...DROP_BETS].reverse().find((v) => v <= this.credits);
    this.dropBet = affordable ?? DROP_BETS[0];
    this.save();
  }

  /** （旧UI用・未使用）DROPベットを n だけ増やす。 */
  addBet(n: number): void {
    this.dropBet = Math.min(DROP_BET_MAX, Math.max(DROP_BET_MIN, this.dropBet + n));
    this.save();
  }

  /** DROPベットを「いま張れる最大」にする（所持メダルぶん・上限 DROP_BET_MAX）。
      所持より多く張ると canSpin が弾くので、affordable な上限に丸める。 */
  betDropMax(): void {
    const affordable = Math.floor(this.credits);
    this.dropBet = Math.min(DROP_BET_MAX, Math.max(DROP_BET_MIN, affordable));
    this.save();
  }

  /** DROPベットを最小（1）に戻す。 */
  clearBet(): void {
    this.dropBet = DROP_BET_MIN;
    this.save();
  }

  /** ペイアウト設定（1〜6）を変更 */
  setSettei(n: number): void {
    this.settei = Math.min(6, Math.max(1, Math.round(n)));
    this.save();
  }

  /** 現在の設定の目標RTP（0〜1） */
  get targetRtp(): number {
    return SETTEI_RTP[this.settei] ?? SETTEI_RTP[DEFAULT_SETTEI];
  }

  // --- スピン収支 -----------------------------------------------------
  canSpin(): boolean {
    if (this.inRush) return this.freeSpins > 0;
    // ベットが1以上 かつ 残高が足りること（DROPは0ベットだとSPIN不可）
    return this.totalBet >= 1 && this.credits >= this.totalBet;
  }

  /** スピン開始時のベット消費（RUSH中は無料） */
  placeBet(): void {
    if (this.inRush) {
      this.freeSpins = Math.max(0, this.freeSpins - 1);
    } else {
      this.credits -= this.totalBet;
    }
    // ベット消費を即永続化。これをしないと addWin 前（スピン演出中／
    // ダブルアップ中）にリロードされるとベットが巻き戻る（タダ回し）。
    this.save();
  }

  addWin(amount: number): void {
    this.lastWin = amount;
    this.credits += amount;
    this.save();
  }

  startRush(spins: number, multiplier: number): void {
    this.inRush = true;
    this.freeSpins += spins;
    this.freeSpinsTotal += spins;
    this.rushMultiplier = multiplier;
    this.save();
  }

  /** RUSH中に再度スキャッターを引いた場合の上乗せ */
  retriggerRush(spins: number): void {
    this.freeSpins += spins;
    this.freeSpinsTotal += spins;
    this.save();
  }

  endRush(): void {
    this.inRush = false;
    this.freeSpins = 0;
    this.freeSpinsTotal = 0;
    this.rushMultiplier = 1;
    this.save();
  }

  /** 残高ゼロ救済 */
  refill(amount = 1000): void {
    this.credits += amount;
    this.save();
  }

  // --- 永続化（プレイヤー別）------------------------------------------
  save(): void {
    const data: PlayerSave = {
      credits: this.credits,
      lineBetIndex: this.lineBetIndex,
      settei: this.settei,
      dropBet: this.dropBet,
    };
    writeJSON(SAVE_PREFIX + this.playerId, data);
  }

  private saveMeta(): void {
    const meta: MetaSave = { names: this.names, current: this.playerId };
    writeJSON(META_KEY, meta);
  }

  private loadPlayer(id: PlayerId): void {
    const s = readJSON<PlayerSave>(SAVE_PREFIX + id);
    this.credits = typeof s?.credits === "number" ? s.credits : START_CREDITS;
    this.lineBetIndex =
      typeof s?.lineBetIndex === "number"
        ? Math.min(Math.max(0, s.lineBetIndex), LINE_BETS.length - 1)
        : 0;
    this.settei =
      typeof s?.settei === "number"
        ? Math.min(6, Math.max(1, Math.round(s.settei)))
        : DEFAULT_SETTEI;
    // 旧セーブの任意値はプリセット段に吸着（BET▲/MAX 巡回式に統一）。
    this.dropBet = snapDropBet(
      typeof s?.dropBet === "number" ? Math.round(s.dropBet) : DROP_BET_DEFAULT
    );
  }
}
