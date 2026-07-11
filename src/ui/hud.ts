// ===== HUD（クレジット / ベット / 操作ボタン） ======================
import type { GameState } from "../game/state";

export interface HudHandlers {
  onSpin: () => void;
  onBet: () => void;
  onMaxBet: () => void;
  onAddBet: (n: number) => void; // DROP: 1/10/100/1000 BET 加算
  onDropMax: () => void; // DROP: 張れる最大（所持ぶん・上限10000）
  onClearBet: () => void; // DROP: ベットを最小に戻す
  onToggleMute: () => void;
  onToggleAuto: () => void;
  onToggleDu: () => void; // ダブルアップ ON/OFF
  onRefill: () => void;
}

export class Hud {
  readonly el: HTMLElement;
  private creditsEl!: HTMLElement;
  private betEl!: HTMLElement;
  private betMeter!: HTMLElement;
  private totalBetEl!: HTMLElement;
  private winEl!: HTMLElement;
  private freeEl!: HTMLElement;
  private spinBtn!: HTMLButtonElement;
  private betBtn!: HTMLButtonElement;
  private maxBtn!: HTMLButtonElement;
  private slotBetGroup!: HTMLElement;
  private dropBetGroup!: HTMLElement;
  private addBtns: HTMLButtonElement[] = [];
  private dropMaxBtn!: HTMLButtonElement;
  private clearBtn!: HTMLButtonElement;
  private muteBtn!: HTMLButtonElement;
  private autoBtn!: HTMLButtonElement;
  private duBtn!: HTMLButtonElement;
  private refillBtn!: HTMLButtonElement;

  constructor(private state: GameState, private h: HudHandlers) {
    this.el = document.createElement("div");
    this.el.className = "hud";
    this.el.innerHTML = `
      <div class="meters">
        <div class="meter"><span class="meter-label">メダル</span><span class="meter-val" data-credit>0</span></div>
        <div class="meter" data-bet-meter><span class="meter-label">BET / LINE</span><span class="meter-val" data-bet>0</span></div>
        <div class="meter"><span class="meter-label">TOTAL BET</span><span class="meter-val" data-total>0</span></div>
        <div class="meter win"><span class="meter-label">WIN</span><span class="meter-val" data-win>0</span></div>
        <div class="meter free hidden" data-free-wrap><span class="meter-label">FREE SPIN</span><span class="meter-val" data-free>0</span></div>
      </div>
      <div class="controls">
        <div class="bet-group" data-slot-bet>
          <button class="btn" data-bet-btn>BET ▲</button>
          <button class="btn" data-max-btn>MAX BET</button>
        </div>
        <div class="bet-group drop" data-drop-bet>
          <button class="btn" data-add="1">1<small>BET</small></button>
          <button class="btn" data-add="10">10<small>BET</small></button>
          <button class="btn" data-add="100">100<small>BET</small></button>
          <button class="btn" data-add="1000">1000<small>BET</small></button>
          <button class="btn gold" data-drop-max>MAX</button>
          <button class="btn ghost" data-clear-btn>クリア</button>
        </div>
        <button class="btn primary" data-spin-btn>SPIN</button>
        <button class="btn" data-du-btn>ダブル ON</button>
        <button class="btn" data-auto-btn>AUTO</button>
        <button class="btn ghost" data-mute-btn>🔊</button>
        <button class="btn ghost hidden" data-refill-btn>+1000</button>
      </div>`;

    this.creditsEl = this.q("[data-credit]");
    this.betEl = this.q("[data-bet]");
    this.betMeter = this.q("[data-bet-meter]");
    this.totalBetEl = this.q("[data-total]");
    this.winEl = this.q("[data-win]");
    this.freeEl = this.q("[data-free]");
    this.spinBtn = this.q("[data-spin-btn]");
    this.betBtn = this.q("[data-bet-btn]");
    this.maxBtn = this.q("[data-max-btn]");
    this.slotBetGroup = this.q("[data-slot-bet]");
    this.dropBetGroup = this.q("[data-drop-bet]");
    this.addBtns = [...this.el.querySelectorAll<HTMLButtonElement>("[data-add]")];
    this.dropMaxBtn = this.q("[data-drop-max]");
    this.clearBtn = this.q("[data-clear-btn]");
    this.muteBtn = this.q("[data-mute-btn]");
    this.autoBtn = this.q("[data-auto-btn]");
    this.duBtn = this.q("[data-du-btn]");
    this.refillBtn = this.q("[data-refill-btn]");

    this.spinBtn.addEventListener("click", () => this.h.onSpin());
    this.betBtn.addEventListener("click", () => this.h.onBet());
    this.maxBtn.addEventListener("click", () => this.h.onMaxBet());
    this.addBtns.forEach((b) =>
      b.addEventListener("click", () => this.h.onAddBet(Number(b.dataset.add)))
    );
    this.dropMaxBtn.addEventListener("click", () => this.h.onDropMax());
    this.clearBtn.addEventListener("click", () => this.h.onClearBet());
    this.muteBtn.addEventListener("click", () => this.h.onToggleMute());
    this.autoBtn.addEventListener("click", () => this.h.onToggleAuto());
    this.duBtn.addEventListener("click", () => this.h.onToggleDu());
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

  /** ダブルアップ ON/OFF のボタン表示を更新（OFF=勝利を自動COLLECT）。 */
  setDu(on: boolean): void {
    this.duBtn.classList.toggle("active", on);
    this.duBtn.classList.toggle("ghost", !on);
    this.duBtn.textContent = on ? "ダブル ON" : "ダブル OFF";
  }

  private busy = false;

  /** スピン中などのボタン無効化 */
  setBusy(busy: boolean): void {
    this.busy = busy;
    const lock = busy || this.state.inRush; // RUSH中はベット変更不可
    this.betBtn.disabled = lock;
    this.maxBtn.disabled = lock;
    this.addBtns.forEach((b) => (b.disabled = lock));
    this.dropMaxBtn.disabled = lock;
    this.clearBtn.disabled = lock;
    this.spinBtn.textContent = this.state.inRush ? "RUSH SPIN" : busy ? "SPINNING" : "SPIN";
    this.refreshSpin();
  }

  /** SPINボタンの有効/無効を更新（スピン中 or ベット0なら不可）。 */
  private refreshSpin(): void {
    const noBet = !this.state.inRush && this.state.totalBet < 1;
    this.spinBtn.disabled = this.busy || noBet;
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
    // ベットUIは両モード共通の BET▲ / MAX BET（DROPも巡回式プリセットに統一）。
    this.slotBetGroup.classList.remove("hidden");
    this.dropBetGroup.classList.add("hidden");
    // 両モードとも単一ベット（5リールは段×20＝TOTAL BET）なので「BET / LINE」メーターは隠す
    this.betMeter.classList.add("hidden");

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

    // 大会中は +1000 救済を出さない（復活は大会UI側の一度きりボーナスのみ）
    const broke =
      this.state.credits < this.state.totalBet && !this.state.inRush && !this.state.inEvent;
    this.refillBtn.classList.toggle("hidden", !broke);
    this.el.classList.toggle("rush-mode", this.state.inRush);
    this.refreshSpin(); // ベット変更でSPINの有効/無効を更新
  }
}
