// ===== HUD（クレジット / ベット / 操作ボタン） ======================
import type { GameState } from "../game/state";

export interface HudHandlers {
  onSpin: () => void;
  onBet: () => void;
  onMaxBet: () => void;
  onToggleMute: () => void;
  onToggleAuto: () => void;
  onRefill: () => void;
}

export class Hud {
  readonly el: HTMLElement;
  private creditsEl!: HTMLElement;
  private betEl!: HTMLElement;
  private totalBetEl!: HTMLElement;
  private winEl!: HTMLElement;
  private freeEl!: HTMLElement;
  private spinBtn!: HTMLButtonElement;
  private betBtn!: HTMLButtonElement;
  private maxBtn!: HTMLButtonElement;
  private muteBtn!: HTMLButtonElement;
  private autoBtn!: HTMLButtonElement;
  private refillBtn!: HTMLButtonElement;

  constructor(private state: GameState, private h: HudHandlers) {
    this.el = document.createElement("div");
    this.el.className = "hud";
    this.el.innerHTML = `
      <div class="meters">
        <div class="meter"><span class="meter-label">CREDIT</span><span class="meter-val" data-credit>0</span></div>
        <div class="meter"><span class="meter-label">BET / LINE</span><span class="meter-val" data-bet>0</span></div>
        <div class="meter"><span class="meter-label">TOTAL BET</span><span class="meter-val" data-total>0</span></div>
        <div class="meter win"><span class="meter-label">WIN</span><span class="meter-val" data-win>0</span></div>
        <div class="meter free hidden" data-free-wrap><span class="meter-label">FREE SPIN</span><span class="meter-val" data-free>0</span></div>
      </div>
      <div class="controls">
        <button class="btn" data-bet-btn>BET ▲</button>
        <button class="btn" data-max-btn>MAX BET</button>
        <button class="btn primary" data-spin-btn>SPIN</button>
        <button class="btn" data-auto-btn>AUTO</button>
        <button class="btn ghost" data-mute-btn>🔊</button>
        <button class="btn ghost hidden" data-refill-btn>+1000</button>
      </div>`;

    this.creditsEl = this.q("[data-credit]");
    this.betEl = this.q("[data-bet]");
    this.totalBetEl = this.q("[data-total]");
    this.winEl = this.q("[data-win]");
    this.freeEl = this.q("[data-free]");
    this.spinBtn = this.q("[data-spin-btn]");
    this.betBtn = this.q("[data-bet-btn]");
    this.maxBtn = this.q("[data-max-btn]");
    this.muteBtn = this.q("[data-mute-btn]");
    this.autoBtn = this.q("[data-auto-btn]");
    this.refillBtn = this.q("[data-refill-btn]");

    this.spinBtn.addEventListener("click", () => this.h.onSpin());
    this.betBtn.addEventListener("click", () => this.h.onBet());
    this.maxBtn.addEventListener("click", () => this.h.onMaxBet());
    this.muteBtn.addEventListener("click", () => this.h.onToggleMute());
    this.autoBtn.addEventListener("click", () => this.h.onToggleAuto());
    this.refillBtn.addEventListener("click", () => this.h.onRefill());

    this.update();
  }

  private q<T extends HTMLElement>(sel: string): T {
    return this.el.querySelector(sel) as T;
  }

  setMuted(m: boolean): void {
    this.muteBtn.textContent = m ? "🔇" : "🔊";
  }

  setAuto(on: boolean): void {
    this.autoBtn.classList.toggle("active", on);
    this.autoBtn.textContent = on ? "AUTO ●" : "AUTO";
  }

  /** スピン中などのボタン無効化 */
  setBusy(busy: boolean): void {
    this.spinBtn.disabled = busy;
    this.betBtn.disabled = busy || this.state.inRush;
    this.maxBtn.disabled = busy || this.state.inRush;
    this.spinBtn.textContent = this.state.inRush ? "RUSH SPIN" : busy ? "SPINNING" : "SPIN";
  }

  /** 勝利金額をカウントアップ表示 */
  animateWin(amount: number): void {
    const start = performance.now();
    const dur = Math.min(900, 300 + amount * 2);
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      this.winEl.textContent = Math.floor(amount * k).toLocaleString();
      if (k < 1) requestAnimationFrame(tick);
      else this.update();
    };
    requestAnimationFrame(tick);
  }

  update(): void {
    this.creditsEl.textContent = Math.floor(this.state.credits).toLocaleString();
    this.betEl.textContent = this.state.lineBet.toLocaleString();
    this.totalBetEl.textContent = this.state.totalBet.toLocaleString();
    this.winEl.textContent = Math.floor(this.state.lastWin).toLocaleString();

    const freeWrap = this.q("[data-free-wrap]");
    if (this.state.inRush) {
      freeWrap.classList.remove("hidden");
      this.freeEl.textContent = String(this.state.freeSpins);
    } else {
      freeWrap.classList.add("hidden");
    }

    const broke = this.state.credits < this.state.totalBet && !this.state.inRush;
    this.refillBtn.classList.toggle("hidden", !broke);
    this.el.classList.toggle("rush-mode", this.state.inRush);
  }
}
