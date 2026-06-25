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

  constructor(private root: HTMLElement, private board: Board) {
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
  }

  /** 全画面ビューポート基準でバッファを合わせる（zoom非対象なので暴走しない）。 */
  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === 0 || h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 当たりセルを順番にハイライト表示 */
  showWins(ev: SpinEvaluation): void {
    if (ev.total <= 0) return;
    const winCells = new Set<string>();
    for (const w of ev.lineWins) for (const [r, c] of w.cells) winCells.add(`${r},${c}`);
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

  /** 紙吹雪/きらめきを噴射 */
  burst(count = 80, colors?: string[]): void {
    // canvas 自身の現在サイズ基準で発射（描画バッファの論理座標と一致＝位置ズレ防止）
    const r = this.canvas.getBoundingClientRect();
    const palette =
      colors ?? ["#ffe14a", "#ff5c7a", "#4fc3ff", "#3ddc84", "#b06bff", "#fff"];
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: r.width / 2 + (Math.random() - 0.5) * r.width * 0.6,
        y: r.height * 0.45,
        vx: (Math.random() - 0.5) * 7,
        vy: -Math.random() * 9 - 3,
        life: 1,
        size: 4 + Math.random() * 6,
        color: palette[(Math.random() * palette.length) | 0],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
      });
    }
    this.startLoop();
  }

  /** 当たりシンボルに応じた色できらめき */
  sparkleForWins(ev: SpinEvaluation): void {
    const colors = new Set<string>();
    for (const w of ev.lineWins) colors.add(sym(w.symbol).color);
    if (ev.scatter) colors.add(sym("scatter").color);
    this.burst(ev.total > 0 ? 60 : 0, [...colors, "#fff"]);
  }

  private startLoop(): void {
    if (this.rafId) return;
    const step = () => {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.particles = this.particles.filter((p) => p.life > 0);
      for (const p of this.particles) {
        p.vy += 0.32; // 重力
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.life -= 0.012;
        this.ctx.save();
        this.ctx.globalAlpha = Math.max(0, p.life);
        this.ctx.translate(p.x, p.y);
        this.ctx.rotate(p.rot);
        this.ctx.fillStyle = p.color;
        this.ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        this.ctx.restore();
      }
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
