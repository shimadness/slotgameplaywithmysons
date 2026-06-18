// ===== ゲーム状態（プレイヤー別 クレジット / ベット / RUSH / 設定） ===
import { LINE_COUNT } from "./paylines";
import { DEFAULT_SETTEI, SETTEI_RTP } from "./drop";

export const LINE_BETS = [1, 2, 3, 5, 10] as const;
export type LineBet = (typeof LINE_BETS)[number];

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

interface PlayerSave {
  credits: number;
  lineBetIndex: number;
  settei: number;
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
  lineBetIndex = 0; // LINE_BETS のインデックス
  settei = DEFAULT_SETTEI; // ペイアウト率の設定（1〜6）

  // 名前（3人分。プレイヤーごとに保存）
  names: Record<PlayerId, string> = { ...DEFAULT_NAMES };

  // RUSH（フリースピン）関連 — 一時状態（保存しない／プレイヤー切替でリセット）
  freeSpins = 0;
  freeSpinsTotal = 0;
  rushMultiplier = 1;
  inRush = false;

  lastWin = 0;

  /** まだ誰も選んでいない（初回）なら true */
  firstRun = false;

  constructor() {
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

  get totalBet(): number {
    return this.lineBet * LINE_COUNT;
  }

  cycleLineBet(): void {
    this.lineBetIndex = (this.lineBetIndex + 1) % LINE_BETS.length;
    this.save();
  }

  setMaxBet(): void {
    this.lineBetIndex = LINE_BETS.length - 1;
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
    return this.credits >= this.totalBet;
  }

  /** スピン開始時のベット消費（RUSH中は無料） */
  placeBet(): void {
    if (this.inRush) {
      this.freeSpins = Math.max(0, this.freeSpins - 1);
    } else {
      this.credits -= this.totalBet;
    }
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
  }
}
