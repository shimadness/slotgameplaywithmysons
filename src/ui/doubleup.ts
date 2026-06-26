// ===== ダブルアップ UI（DOUBLE UP CHALLENGE オーバーレイ）===========
// 勝利後に表示。ディーラーより強い目を3箇所から当てれば配当2倍。
// COLLECT / 半分（セーブ）/ 全部 を選択。価値が UPPER_CAP 超で強制 COLLECT。
// 3リール全揃いでスペシャルボーナス→強制終了。
//   const du = new DoubleUp(sfx);  app.appendChild(du.el);
//   const final = await du.start(win, lineBet);  state.addWin(final);
import type { Sfx } from "../audio/sfx";
import {
  DU_LADDER,
  SPECIAL_BONUS,
  rank,
  beatsDealer,
  dealRound,
  isSpecial,
  duGlyph,
  duColor,
  type DURound,
} from "../game/doubleup";
import type { DSym } from "../game/dropEngine";

type Phase = "bet" | "pick" | "reveal";

export class DoubleUp {
  el: HTMLElement;
  private sfx: Sfx;

  // 状態
  private atRisk = 0; // 賭けにさらしている価値（COLLECT WIN の中身）
  private save = 0; // セーブ（ロック済みで負けても残る）
  private lineBet = 1;
  private round: DURound = dealRound();
  private phase: Phase = "bet";
  private resolveGame: ((amount: number) => void) | null = null;
  private spinTimers: number[] = [];

  // DOM 参照
  private dealerGlyph!: HTMLElement;
  private gaugeFill!: HTMLElement;
  private reelEls: HTMLElement[] = [];
  private selectBtns: HTMLButtonElement[] = [];
  private collectVal!: HTMLElement;
  private nextVal!: HTMLElement;
  private saveVal!: HTMLElement;
  private btnCollect!: HTMLButtonElement;
  private btnHalf!: HTMLButtonElement;
  private btnFull!: HTMLButtonElement;
  private msgEl!: HTMLElement;

  constructor(sfx: Sfx) {
    this.sfx = sfx;
    this.el = document.createElement("div");
    this.el.className = "du-overlay hidden";
    this.el.innerHTML = this.template();
    this.cacheDom();
    this.bind();
  }

  // ---- 公開: 勝負開始（最終獲得額を resolve）------------------------
  start(win: number, lineBet: number): Promise<number> {
    this.atRisk = win;
    this.save = 0;
    this.lineBet = lineBet;
    this.el.classList.remove("hidden");
    this.msg("");
    this.beginRound();
    return new Promise<number>((resolve) => {
      this.resolveGame = resolve;
    });
  }

  // ---- 1ラウンド開始（ベット選択→ディーラー決定→3択）-------------
  private beginRound(): void {
    this.clearSpin();
    this.round = dealRound();
    this.phase = "bet";

    // ディーラーもプレイヤーリールも伏せる（ベット選択後にディーラーが決まる）
    this.faceDown(this.dealerGlyph);
    this.gaugeFill.style.width = "0%";
    this.reelEls.forEach((r) => {
      r.classList.remove("revealed", "win", "lose");
      this.faceDown(r.querySelector(".du-reel-glyph") as HTMLElement);
    });
    this.selectBtns.forEach((b) => (b.disabled = true));

    this.updateMeters();
    this.setBetButtons(true);
    this.msg(""); // 説明文は出さない（ボタンを見て操作できるUIにする）
  }

  private setBetButtons(enabled: boolean): void {
    const canHalf = Math.floor(this.atRisk / 2) >= 1; // WIN=1（価値1）は半分不可
    this.btnCollect.disabled = !enabled;
    this.btnFull.disabled = !enabled || this.atRisk <= 0;
    this.btnHalf.disabled = !enabled || !canHalf;
  }

  private updateMeters(): void {
    this.collectVal.textContent = (this.atRisk + this.save).toLocaleString();
    this.nextVal.textContent = (this.atRisk * 2 + this.save).toLocaleString();
    this.saveVal.textContent = this.save.toLocaleString();
  }

  // ---- ベット選択 ---------------------------------------------------
  private onCollect(): void {
    this.sfx.ui();
    this.finish(this.atRisk + this.save);
  }
  private onHalf(): void {
    this.sfx.ui();
    const half = Math.floor(this.atRisk / 2);
    this.save += half;
    this.atRisk -= half; // 残り半分を勝負にさらす
    this.startDealer();
  }
  private onFull(): void {
    this.sfx.ui();
    this.startDealer(); // atRisk 全部を勝負（save はロックのまま安全）
  }

  // ---- ベット確定 → ディーラーをスピンして決定 --------------------
  private startDealer(): void {
    this.phase = "reveal"; // ディーラー決定中は操作ロック
    this.setBetButtons(false);
    this.updateMeters();
    this.msg("ディーラーの目を きめています…");

    const glyph = this.dealerGlyph;
    const t = window.setInterval(() => {
      this.setGlyph(glyph, DU_LADDER[(Math.random() * DU_LADDER.length) | 0]);
    }, 60);
    this.spinTimers.push(t);
    window.setTimeout(() => {
      clearInterval(t);
      this.setGlyph(glyph, this.round.dealer);
      this.gaugeFill.style.width = `${((rank(this.round.dealer) + 0.5) / DU_LADDER.length) * 100}%`;
      this.sfx.reelStop();
      this.goPick();
    }, 750);
  }

  // ---- 3箇所から選ぶフェーズ ---------------------------------------
  private goPick(): void {
    this.phase = "pick";
    this.msg(""); // 説明文は出さず、光って跳ねる「pickable」リールで「ここを選ぶ」を見せる
    this.selectBtns.forEach((b) => (b.disabled = false));
    this.reelEls.forEach((r) => r.classList.add("pickable"));
  }

  private onPick(index: number): void {
    if (this.phase !== "pick") return;
    this.phase = "reveal";
    this.sfx.reelStop();
    this.selectBtns.forEach((b) => (b.disabled = true));
    this.reelEls.forEach((r) => r.classList.remove("pickable"));
    this.spinAndReveal(index);
  }

  // 3リールを回してから開く（軽い演出）
  private spinAndReveal(picked: number): void {
    const finals = this.round.reels;
    let settled = 0;
    this.reelEls.forEach((r, i) => {
      const glyph = r.querySelector(".du-reel-glyph") as HTMLElement;
      const t = window.setInterval(() => {
        this.setGlyph(glyph, DU_LADDER[(Math.random() * DU_LADDER.length) | 0]);
      }, 60);
      this.spinTimers.push(t);
      window.setTimeout(() => {
        clearInterval(t);
        this.setGlyph(glyph, finals[i]);
        r.classList.add("revealed");
        this.sfx.reelStop();
        if (++settled === 3) window.setTimeout(() => this.settle(picked), 350);
      }, 450 + i * 260);
    });
  }

  // ---- 勝敗判定・精算 ----------------------------------------------
  private settle(picked: number): void {
    // スペシャル（3つ揃い）が最優先
    const special = isSpecial(this.round);
    if (special != null) {
      this.atRisk *= 2;
      const bonus = SPECIAL_BONUS[special] * this.lineBet;
      const total = this.atRisk + this.save + bonus;
      this.reelEls.forEach((r) => r.classList.add("win"));
      this.sfx.bonus();
      this.msg(`★ スペシャルボーナス！ ${duGlyph(special)}×3  +${bonus.toLocaleString()} ★`);
      this.updateMeters();
      window.setTimeout(() => this.finish(total), 1800);
      return;
    }

    // 同じ目（同点）＝引き分け → 賭けはそのままでリトライ
    if (rank(this.round.reels[picked]) === rank(this.round.dealer)) {
      this.reelEls[picked].classList.add("tie");
      this.dealerGlyph.parentElement?.classList.add("tie");
      this.sfx.reelStop();
      this.msg("DRAW… おなじ目！ もう一度！");
      window.setTimeout(() => this.retryRound(), 1300);
      return;
    }

    const won = beatsDealer(this.round, picked);
    this.reelEls[picked].classList.add(won ? "win" : "lose");

    if (won) {
      this.atRisk *= 2;
      this.updateMeters();
      const big = this.atRisk >= 1000;
      big ? this.sfx.winBig() : this.sfx.winSmall();
      // 上限なし：勝てば何度でも続行（COLLECT はユーザーが選ぶ）
      this.msg("WIN！ もう一度いける！");
      window.setTimeout(() => this.beginRound(), 1100);
    } else {
      this.atRisk = 0;
      const total = this.save;
      this.sfx.deny();
      this.updateMeters();
      this.msg(total > 0 ? `LOSE… セーブ ${total.toLocaleString()} を確保` : "LOSE… 残念！");
      window.setTimeout(() => this.finish(total), 1500);
    }
  }

  // 同点リトライ：賭け(atRisk/save)はそのまま、ディーラーを引き直してスピン。
  private retryRound(): void {
    this.clearSpin();
    this.round = dealRound();
    this.dealerGlyph.parentElement?.classList.remove("tie");
    this.faceDown(this.dealerGlyph);
    this.gaugeFill.style.width = "0%";
    this.reelEls.forEach((r) => {
      r.classList.remove("revealed", "win", "lose", "tie", "pickable");
      this.faceDown(r.querySelector(".du-reel-glyph") as HTMLElement);
    });
    this.startDealer(); // ベット選択は飛ばして同じ賭けで再スピン
  }

  // ---- 終了 ---------------------------------------------------------
  private finish(amount: number): void {
    this.clearSpin();
    this.el.classList.add("hidden");
    const r = this.resolveGame;
    this.resolveGame = null;
    if (r) r(Math.max(0, Math.round(amount)));
  }

  // ---- ヘルパ -------------------------------------------------------
  private setGlyph(el: HTMLElement, s: DSym): void {
    el.textContent = duGlyph(s);
    el.style.color = duColor(s);
    // BAR/BAR²/BAR³ は横長なのでセルに収まるよう縮小クラスを付与
    el.classList.toggle("is-bar", s === "bar" || s === "bar2" || s === "bar3");
  }
  /** セルを伏せ状態（?）にする。 */
  private faceDown(el: HTMLElement): void {
    el.textContent = "?";
    el.style.color = "#9fb0d0";
    el.classList.remove("is-bar");
  }
  private msg(text: string): void {
    this.msgEl.textContent = text;
  }
  private clearSpin(): void {
    this.spinTimers.forEach((t) => clearInterval(t));
    this.spinTimers = [];
  }

  // ---- DOM ----------------------------------------------------------
  private template(): string {
    const bonusRows = ([...DU_LADDER].reverse())
      .map(
        (s) =>
          `<div class="du-bonus-row"><span class="du-bonus-sym" style="color:${duColor(
            s
          )}">${duGlyph(s)}×3</span><span class="du-bonus-pay">×${SPECIAL_BONUS[s]}</span></div>`
      )
      .join("");
    return `
      <div class="du-panel">
        <h2 class="du-title">DOUBLE UP <span>CHALLENGE</span></h2>
        <div class="du-meters">
          <div class="du-meter"><label>COLLECT WIN</label><b data-collect>0</b></div>
          <div class="du-meter next"><label>NEXT WIN</label><b data-next>0</b></div>
          <div class="du-meter save"><label>SAVE</label><b data-save>0</b></div>
        </div>

        <div class="du-stage">
          <div class="du-dealer">
            <div class="du-label">DEALER</div>
            <div class="du-cell dealer"><span class="du-dealer-glyph"></span></div>
            <div class="du-gauge"><span>LOW</span><div class="du-gauge-bar"><i data-gauge></i></div><span>HIGH</span></div>
          </div>

          <div class="du-reels">
            <div class="du-label">あなたの 3つ から えらぶ</div>
            <div class="du-reel-row">
              ${[0, 1, 2]
                .map(
                  (i) => `
                <div class="du-reel" data-reel="${i}">
                  <div class="du-cell"><span class="du-reel-glyph">?</span></div>
                  <button class="btn du-select" data-select="${i}" disabled>SELECT</button>
                </div>`
                )
                .join("")}
            </div>
          </div>

          <div class="du-bonus">
            <div class="du-label">SPECIAL BONUS</div>
            <div class="du-bonus-list">${bonusRows}</div>
          </div>
        </div>

        <div class="du-msg" data-msg></div>

        <div class="du-actions">
          <button class="btn du-collect" data-collect-btn>COLLECT<small>降りる</small></button>
          <button class="btn du-half" data-half-btn>半分かける<small>セーブ</small></button>
          <button class="btn primary du-full" data-full-btn>全部かける<small>ダブルアップ</small></button>
        </div>
      </div>`;
  }

  private cacheDom(): void {
    const q = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T;
    this.dealerGlyph = q(".du-dealer-glyph");
    this.gaugeFill = q("[data-gauge]");
    this.collectVal = q("[data-collect]");
    this.nextVal = q("[data-next]");
    this.saveVal = q("[data-save]");
    this.btnCollect = q("[data-collect-btn]");
    this.btnHalf = q("[data-half-btn]");
    this.btnFull = q("[data-full-btn]");
    this.msgEl = q("[data-msg]");
    this.reelEls = [...this.el.querySelectorAll<HTMLElement>(".du-reel")];
    this.selectBtns = [...this.el.querySelectorAll<HTMLButtonElement>(".du-select")];
  }

  private bind(): void {
    this.btnCollect.addEventListener("click", () => this.onCollect());
    this.btnHalf.addEventListener("click", () => this.onHalf());
    this.btnFull.addEventListener("click", () => this.onFull());
    this.selectBtns.forEach((b, i) => {
      const pick = () => this.onPick(i);
      b.addEventListener("click", pick);
      this.reelEls[i].querySelector(".du-cell")!.addEventListener("click", () => {
        if (this.phase === "pick") pick();
      });
    });
  }
}
