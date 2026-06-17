// ===== リール盤面の描画 & 回転アニメーション ========================
import type { SymbolId } from "../game/symbols";
import { sym } from "../game/symbols";
import { REELS, ROWS } from "../game/paylines";

const CELL = 96; // セル高さ(px)。CSS の --cell と一致させること。

interface ReelAnim {
  from: number;
  to: number;
  start: number;
  duration: number;
  stopped: boolean;
}

export interface SpinCallbacks {
  onReelStop?: (reel: number) => void;
  onReachStart?: () => void;
  onAllStopped?: () => void;
}

// より長い余韻でヌルッと止まる
function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

export class Board {
  readonly el: HTMLElement;
  private strips: SymbolId[][];
  private stripEls: HTMLElement[] = [];
  private reelEls: HTMLElement[] = [];
  private pos: number[]; // 各リールの現在位置（セル単位・上段基準）
  private prevPos: number[]; // 前フレーム位置（モーションブラー用）
  private stops: number[]; // 直近の停止インデックス
  private anims: ReelAnim[] = [];
  private rafId = 0;

  constructor(strips: SymbolId[][]) {
    this.strips = strips;
    this.pos = new Array(REELS).fill(0);
    this.prevPos = new Array(REELS).fill(0);
    this.stops = new Array(REELS).fill(0);
    this.el = document.createElement("div");
    this.el.className = "reels";
    this.build();
  }

  private build(): void {
    for (let reel = 0; reel < REELS; reel++) {
      const reelEl = document.createElement("div");
      reelEl.className = "reel";
      reelEl.style.height = `${CELL * ROWS}px`;

      const strip = document.createElement("div");
      strip.className = "reel-strip";

      // 帯を2連結して継ぎ目でも途切れないようにする
      const L = this.strips[reel].length;
      for (let k = 0; k < 2; k++) {
        for (let i = 0; i < L; i++) {
          strip.appendChild(this.makeCell(this.strips[reel][i]));
        }
      }
      reelEl.appendChild(strip);
      this.el.appendChild(reelEl);
      this.stripEls.push(strip);
      this.reelEls.push(reelEl);
    }
    this.render();
  }

  private makeCell(id: SymbolId): HTMLElement {
    const d = sym(id);
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.sym = id;
    cell.style.height = `${CELL}px`;
    cell.style.setProperty("--sym-color", d.color);
    const g = document.createElement("span");
    g.className = "glyph";
    g.textContent = d.glyph;
    cell.appendChild(g);
    return cell;
  }

  private render(): void {
    for (let reel = 0; reel < REELS; reel++) {
      const L = this.strips[reel].length;
      const mod = ((this.pos[reel] % L) + L) % L;
      this.stripEls[reel].style.transform = `translateY(${-mod * CELL}px)`;
      // 速度（セル/フレーム）からモーションブラー量 0〜1 を算出
      const speed = Math.abs(this.pos[reel] - this.prevPos[reel]);
      const mb = Math.min(1, speed / 1.9);
      this.stripEls[reel].style.setProperty("--mb", mb.toFixed(3));
      this.prevPos[reel] = this.pos[reel];
    }
  }

  private clearBlur(): void {
    for (const s of this.stripEls) s.style.setProperty("--mb", "0");
  }

  /**
   * 表示中の (reel,row) に対応する DOM セルを返す（当たり演出用）。
   */
  cellAt(reel: number, row: number): HTMLElement {
    const L = this.strips[reel].length;
    const idx = (this.stops[reel] + row) % L;
    return this.stripEls[reel].children[idx] as HTMLElement;
  }

  clearHighlights(): void {
    this.el.querySelectorAll(".cell.win, .cell.dim").forEach((c) => {
      c.classList.remove("win", "dim");
    });
    this.reelEls.forEach((r) => r.classList.remove("reach"));
  }

  /**
   * stops に向けてリールを回し、停止までを Promise で返す。
   * @param reach true なら最終リールを引き伸ばしてリーチ演出。
   */
  spin(stops: number[], reach: boolean, cb: SpinCallbacks = {}): Promise<void> {
    cancelAnimationFrame(this.rafId);
    this.clearHighlights();
    const now = performance.now();
    this.anims = [];

    for (let reel = 0; reel < REELS; reel++) {
      const L = this.strips[reel].length;
      const from = this.pos[reel];
      const minSpin = 22 + reel * 6 + (reach && reel === REELS - 1 ? L : 0);
      let to = Math.round(from) + minSpin;
      const rem = (((stops[reel] - (to % L)) % L) + L) % L;
      to += rem;
      const duration =
        850 + reel * 270 + (reach && reel === REELS - 1 ? 1500 : 0);
      this.anims.push({ from, to, start: now, duration, stopped: false });
    }
    this.stops = stops.slice();

    let reachFired = false;
    return new Promise<void>((resolve) => {
      const tick = (t: number) => {
        let allStopped = true;
        for (let reel = 0; reel < REELS; reel++) {
          const a = this.anims[reel];
          if (a.stopped) continue;
          const raw = (t - a.start) / a.duration;
          if (raw >= 1) {
            this.pos[reel] = a.to;
            a.stopped = true;
            cb.onReelStop?.(reel);
            // 4番目(index 3)停止時にリーチ発動
            if (reach && reel === REELS - 2 && !reachFired) {
              reachFired = true;
              this.reelEls[REELS - 1].classList.add("reach");
              cb.onReachStart?.();
            }
          } else {
            const e = easeOutQuart(Math.max(0, raw));
            this.pos[reel] = a.from + (a.to - a.from) * e;
            allStopped = false;
          }
        }
        this.render();
        if (!allStopped) {
          this.rafId = requestAnimationFrame(tick);
        } else {
          this.reelEls[REELS - 1].classList.remove("reach");
          this.clearBlur();
          cb.onAllStopped?.();
          resolve();
        }
      };
      this.rafId = requestAnimationFrame(tick);
    });
  }
}
