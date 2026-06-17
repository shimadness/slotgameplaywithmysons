// ===== ゲーム状態（クレジット / ベット / RUSH / 設定） ===============
import { LINE_COUNT } from "./paylines";
import { DEFAULT_SETTEI, SETTEI_RTP } from "./drop";

export const LINE_BETS = [1, 2, 3, 5, 10] as const;
export type LineBet = (typeof LINE_BETS)[number];

const STORAGE_KEY = "twinkle-drop-rush.save";

export interface SaveData {
  credits: number;
  lineBetIndex: number;
  settei?: number;
}

export class GameState {
  credits = 1000;
  lineBetIndex = 0; // LINE_BETS のインデックス
  settei = DEFAULT_SETTEI; // ペイアウト率の設定（1〜6）

  // RUSH（フリースピン）関連
  freeSpins = 0;
  freeSpinsTotal = 0;
  rushMultiplier = 1;
  inRush = false;

  // 直近のスピン収支
  lastWin = 0;

  constructor() {
    this.load();
  }

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

  save(): void {
    try {
      const data: SaveData = {
        credits: this.credits,
        lineBetIndex: this.lineBetIndex,
        settei: this.settei,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* localStorage 不可環境は無視 */
    }
  }

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as SaveData;
      if (typeof data.credits === "number") this.credits = data.credits;
      if (typeof data.lineBetIndex === "number") {
        this.lineBetIndex = Math.min(
          Math.max(0, data.lineBetIndex),
          LINE_BETS.length - 1
        );
      }
      if (typeof data.settei === "number") {
        this.settei = Math.min(6, Math.max(1, Math.round(data.settei)));
      }
    } catch {
      /* 破損データは無視 */
    }
  }
}
