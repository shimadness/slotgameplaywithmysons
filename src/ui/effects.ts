// ===== 当たり演出（ハイライト / ポップ / RUSH / パーティクル） =======
import type { Board } from "./board";
import type { SpinEvaluation } from "../game/paylines";
import { sym } from "../game/symbols";

export class Effects {
  private layer: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private rafId = 0;
  /** 花火を「ゲーム枠の中」だけに収めるためのクリップ基準（キャビネット）。 */
  private frame: HTMLElement | null = null;
  /** ネイティブ(スマホ実機)は常に軽量化：canvas dpr↓・パーティクル数↓で負荷を下げる。 */
  private nativeLite = document.documentElement.classList.contains("native-app");
  private lite = this.nativeLite;

  /** ⚡軽量モードの手動切替（ネイティブは常時ON扱い）。 */
  setLite(on: boolean): void {
    this.lite = on || this.nativeLite;
    this.resize();
  }

  constructor(private root: HTMLElement, private board: Board) {
    this.frame = this.root.closest(".cabinet") as HTMLElement | null;
    this.layer = document.createElement("div");
    this.layer.className = "fx-layer";
    this.root.appendChild(this.layer);
    // パーティクルcanvasは fit-scaler の zoom 対象外にするため body直下・全画面fixed に置く
    // （machine内に置くと zoom と canvasバッファがズレて、紙吹雪が変な位置に残って見えた）。
    this.canvas = document.createElement("canvas");
    this.canvas.className = "fx-canvas";
    this.canvas.style.cssText =
      "position:fixed;inset:0;width:100vw;height:100vh;z-index:10;pointer-events:none;";
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    // タブが非アクティブになると requestAnimationFrame が止まり、パーティクルが
    // 画面に「凍結」して残る。隠れたら確実に全消去する（戻ったら綺麗な状態）。
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.clearParticles();
    });
  }

  /** パーティクルとループを完全停止してキャンバスを消去する。 */
  clearParticles(): void {
    this.particles = [];
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** 全画面ビューポート基準でバッファを合わせる（zoom非対象なので暴走しない）。 */
  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === 0 || h === 0) return;
    // ネイティブは dpr=1 に抑える（パーティクルは小さな四角なので画質影響ほぼ無し／塗り面積1/4）
    const dpr = this.lite ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 当たりセルを順番にハイライト表示 */
  showWins(ev: SpinEvaluation): void {
    if (ev.total <= 0) return;
    const winCells = new Set<string>();
    for (const w of ev.wins) for (const [r, c] of w.cells) winCells.add(`${r},${c}`);
    if (ev.scatter) for (const [r, c] of ev.scatter.cells) winCells.add(`${r},${c}`);

    // 当たり以外を少し暗く
    for (let reel = 0; reel < 5; reel++) {
      for (let row = 0; row < 3; row++) {
        const cell = this.board.cellAt(reel, row);
        if (!winCells.has(`${reel},${row}`)) cell.classList.add("dim");
      }
    }
    for (const key of winCells) {
      const [r, c] = key.split(",").map(Number);
      this.board.cellAt(r, c).classList.add("win");
    }
  }

  /** 勝利金額ポップ */
  popWin(amount: number, big: boolean): void {
    const pop = document.createElement("div");
    pop.className = "win-pop" + (big ? " big" : "");
    pop.textContent = `WIN  ${amount.toLocaleString()}`;
    this.layer.appendChild(pop);
    setTimeout(() => pop.remove(), big ? 2600 : 1600);
  }

  /** 連鎖ポップ（○連鎖! +金額） */
  popChain(chain: number, amount: number): void {
    const p = document.createElement("div");
    p.className = "chain-pop";
    p.innerHTML = `<span class="chain-n">${chain}</span><span class="chain-x">連鎖</span><span class="chain-amt">+${amount.toLocaleString()}</span>`;
    this.layer.appendChild(p);
    setTimeout(() => p.remove(), 950);
  }

  /** RUSH 突入バナー */
  rushBanner(spins: number, multiplier: number): Promise<void> {
    return new Promise((resolve) => {
      const b = document.createElement("div");
      b.className = "rush-banner";
      b.innerHTML = `<div class="rush-title">RUSH!!</div>
        <div class="rush-sub">FREE SPIN ×${spins}　配当 ×${multiplier}</div>`;
      this.layer.appendChild(b);
      this.burst(140);
      setTimeout(() => {
        b.classList.add("out");
        setTimeout(() => {
          b.remove();
          resolve();
        }, 500);
      }, 2200);
    });
  }

  /**
   * ワイルド花火（TENGU KING 名物）。盤面の各ワイルドで花火を上げ、×N バッジを出す。
   * 配当は §2.4 で確定済み（演出は結果表示のみ）。baseWin>0 のときだけ呼ぶ。
   * ※実アセット（Lottie/動画）に差し替える場合もこのフックを使う（§6.5）。
   */
  async wildShow(ev: SpinEvaluation): Promise<void> {
    for (const wm of ev.wildMults) {
      const [reel, row] = wm.cell;
      const cell = this.board.cellAt(reel, row);
      cell.classList.add("wild-fire");
      const badge = document.createElement("div");
      badge.className = "wild-mult-badge";
      badge.textContent = `×${wm.mult}`;
      cell.appendChild(badge);
      const r = cell.getBoundingClientRect();
      this.burstAt(r.left + r.width / 2, r.top + r.height / 2, 44, [
        "#ffd24a",
        "#ff5c3a",
        "#ffcf33",
        "#fff",
      ]);
      await this.wait(460);
    }
  }

  /**
   * 天狗フリーゲーム突入オーバーレイ（突入ムービーのプレースホルダ／§6.5）。
   * 実装後はここを Lottie/動画に差し替える。
   */
  freeGameIntro(spins: number): Promise<void> {
    return new Promise((resolve) => {
      const o = document.createElement("div");
      o.className = "free-intro";
      o.innerHTML = `<div class="free-intro-inner">
          <div class="fi-tengu">👺</div>
          <div class="fi-title">天狗フリーゲーム</div>
          <div class="fi-sub">FREE SPIN ×${spins}</div>
        </div>`;
      this.layer.appendChild(o);
      this.burst(160, ["#ffd24a", "#e23b3b", "#ffcf33", "#fff"]);
      setTimeout(() => {
        o.classList.add("out");
        setTimeout(() => {
          o.remove();
          resolve();
        }, 500);
      }, 2100);
    });
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  banner(text: string, ms = 1800): Promise<void> {
    return new Promise((resolve) => {
      const b = document.createElement("div");
      b.className = "mini-banner";
      b.textContent = text;
      this.layer.appendChild(b);
      setTimeout(() => {
        b.classList.add("out");
        setTimeout(() => {
          b.remove();
          resolve();
        }, 400);
      }, ms);
    });
  }

  /** 紙吹雪/きらめきを噴射（ゲーム枠の中央付近から。枠外へは step() でクリップ） */
  burst(count = 80, colors?: string[]): void {
    // キャビネット（無ければ全画面）の中央付近から発射＝余白に飛び散らない
    const r = (this.frame ?? this.canvas).getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height * 0.42;
    const palette =
      colors ?? ["#ffe14a", "#ff5c7a", "#4fc3ff", "#3ddc84", "#b06bff", "#fff"];
    const n = this.lite ? Math.ceil(count * 0.5) : count; // ネイティブは粒を半減
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x: cx + (Math.random() - 0.5) * r.width * 0.5,
        y: cy,
        vx: (Math.random() - 0.5) * 6,
        vy: -Math.random() * 8 - 3,
        life: 1,
        size: 4 + Math.random() * 6,
        color: palette[(Math.random() * palette.length) | 0],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
      });
    }
    this.startLoop();
  }

  /** 指定座標（ビューポート基準px）で放射状に花火を噴射 */
  burstAt(cx: number, cy: number, count = 36, colors?: string[]): void {
    const palette = colors ?? ["#ffd24a", "#ff5c3a", "#fff", "#ffe9a8"];
    const n = this.lite ? Math.ceil(count * 0.5) : count; // ネイティブは粒を半減
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 6;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 2,
        life: 1,
        size: 3 + Math.random() * 5,
        color: palette[(Math.random() * palette.length) | 0],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
      });
    }
    this.startLoop();
  }

  /** 当たりシンボルに応じた色できらめき */
  sparkleForWins(ev: SpinEvaluation): void {
    const colors = new Set<string>();
    for (const w of ev.wins) colors.add(sym(w.symbol).color);
    if (ev.scatter) colors.add(sym("scatter").color);
    this.burst(ev.total > 0 ? 60 : 0, [...colors, "#fff"]);
  }

  private startLoop(): void {
    if (this.rafId) return;
    const step = () => {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.particles = this.particles.filter((p) => p.life > 0);
      // 描画はゲーム枠（キャビネット）内にクリップ＝余白には一切出さない
      this.ctx.save();
      const fr = this.frame?.getBoundingClientRect();
      if (fr) {
        this.ctx.beginPath();
        this.ctx.rect(fr.left, fr.top, fr.width, fr.height);
        this.ctx.clip();
      }
      for (const p of this.particles) {
        p.vy += 0.32; // 重力
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.life -= 0.02; // 減衰を速めて残留を抑える（約0.8秒で消える）
        this.ctx.save();
        this.ctx.globalAlpha = Math.max(0, p.life);
        this.ctx.translate(p.x, p.y);
        this.ctx.rotate(p.rot);
        this.ctx.fillStyle = p.color;
        this.ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        this.ctx.restore();
      }
      this.ctx.restore();
      if (this.particles.length > 0) {
        this.rafId = requestAnimationFrame(step);
      } else {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.rafId = 0;
      }
    };
    this.rafId = requestAnimationFrame(step);
  }
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  color: string;
  rot: number;
  vr: number;
}
