// ===== 3×3 ドロップ盤面（NEXTプレビュー / リール回転 / 連鎖演出） =====
import { sym, type SymbolId } from "../game/symbols";
import {
  COLS,
  ROWS,
  PREVIEW_ROWS,
  WILD_USES,
  neighbors,
  randomDropSymbol,
  type CascadeStep,
  type DGrid,
  type DropResult,
} from "../game/drop";

const DCELL = 116; // ドロップセルの高さ(px)のフォールバック。CSS の --dcell 上限と一致。
const GAP = 8; // セル間ギャップ(px)。CSS の --dgap と一致。
// ぷよぷよ風：重力で加速しながら、落下距離に応じた時間で落ちる（距離∝t²）。
const FALL_BASE_MS = 320; // 1セルぶん落下の基準時間
const SQUASH_MS = 140; // 着地時の潰れ＆復帰
const MAX_DROP_MS = Math.round(FALL_BASE_MS * Math.sqrt(ROWS + 1) + SQUASH_MS);

export interface DropCallbacks {
  onStep?: (step: CascadeStep) => void;
  onReelStop?: (col: number) => void;
  onAllReelsStopped?: () => void;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export class DropBoard {
  readonly el: HTMLElement; // ラッパー（プレビュー＋グリッド）
  private cells: HTMLElement[][] = [];
  private glyphs: HTMLElement[][] = [];
  private badges: HTMLElement[][] = []; // ワイルドファイブ残り回数バッジ
  private previewCells: HTMLElement[][] = []; // [col][idx] idx0=最も手前(下)
  private previewGlyphs: HTMLElement[][] = [];
  private previewBadges: HTMLElement[][] = [];

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "drop-stack";

    // NEXT プレビュー管（各列の上）
    const previews = document.createElement("div");
    previews.className = "drop-previews";
    for (let c = 0; c < COLS; c++) {
      const tube = document.createElement("div");
      tube.className = "ptube";
      // idx が大きいほど上（奥）。表示は上から idx 高→低 の順で並べる。
      for (let idx = PREVIEW_ROWS - 1; idx >= 0; idx--) {
        const cell = document.createElement("div");
        cell.className = "ptube-cell";
        if (idx === 0) cell.classList.add("next"); // 最も手前
        const g = document.createElement("span");
        g.className = "glyph";
        cell.appendChild(g);
        const badge = document.createElement("span");
        badge.className = "wild-count";
        cell.appendChild(badge);
        tube.appendChild(cell);
        (this.previewCells[c] ??= [])[idx] = cell;
        (this.previewGlyphs[c] ??= [])[idx] = g;
        (this.previewBadges[c] ??= [])[idx] = badge;
      }
      previews.appendChild(tube);
    }
    this.el.appendChild(previews);

    // 3×3 グリッド（背面に「道」レイヤーを重ねる）
    const wrap = document.createElement("div");
    wrap.className = "drop-grid-wrap";
    wrap.appendChild(this.buildRoads());

    const grid = document.createElement("div");
    grid.className = "drop-grid";
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement("div");
        cell.className = "dcell";
        const g = document.createElement("span");
        g.className = "glyph";
        cell.appendChild(g);
        const badge = document.createElement("span");
        badge.className = "wild-count";
        cell.appendChild(badge);
        grid.appendChild(cell);
        (this.cells[c] ??= [])[r] = cell;
        (this.glyphs[c] ??= [])[r] = g;
        (this.badges[c] ??= [])[r] = badge;
      }
    }
    wrap.appendChild(grid);
    this.el.appendChild(wrap);
  }

  // --- 「道」レイヤー（セル間の通路。揃った繋がりを点灯して見せる） ------
  private roads = new Map<string, SVGLineElement>();

  /** 1行ぶんの送り量(px)。CSS の --dcell が画面幅で可変なので実寸から測る。 */
  private pitch(): number {
    const h = this.cells[0]?.[0]?.offsetHeight || DCELL;
    return h + GAP;
  }

  /** 同一クラスター内の隣接(8方向)を結ぶ通路を生成 */
  private buildRoads(): SVGSVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const W = COLS * DCELL + (COLS - 1) * GAP;
    const H = ROWS * DCELL + (ROWS - 1) * GAP;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "drop-roads");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    const cx = (c: number) => c * (DCELL + GAP) + DCELL / 2;
    const cy = (r: number) => r * (DCELL + GAP) + DCELL / 2;
    // 接続規則は neighbors() に一元化（中央絡みでない斜めは道を張らない）
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        for (const [nc, nr] of neighbors(c, r)) {
          const key = this.roadKey(c, r, nc, nr);
          if (this.roads.has(key)) continue; // 重複辺はスキップ
          const line = document.createElementNS(NS, "line");
          line.setAttribute("x1", String(cx(c)));
          line.setAttribute("y1", String(cy(r)));
          line.setAttribute("x2", String(cx(nc)));
          line.setAttribute("y2", String(cy(nr)));
          svg.appendChild(line);
          this.roads.set(key, line);
        }
    return svg;
  }

  private roadKey(c1: number, r1: number, c2: number, r2: number): string {
    const a = c1 * ROWS + r1;
    const b = c2 * ROWS + r2;
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }

  private clearRoads(): void {
    for (const line of this.roads.values()) {
      line.classList.remove("lit");
      line.style.removeProperty("--road-color");
    }
  }

  /** ワイルドファイブの残り回数バッジを更新（0なら非表示） */
  private setBadge(badge: HTMLElement, wildLeft: number): void {
    if (wildLeft > 0) {
      badge.textContent = String(wildLeft);
      badge.classList.add("show");
    } else {
      badge.textContent = "";
      badge.classList.remove("show");
    }
  }

  // --- セル描画 -------------------------------------------------------
  private paintCell(
    c: number,
    r: number,
    id: SymbolId,
    fromOffsetPx?: number,
    wildLeft = 0
  ): void {
    const d = sym(id);
    const cell = this.cells[c][r];
    const glyph = this.glyphs[c][r];
    cell.dataset.sym = id;
    cell.classList.remove("match", "clearing");
    cell.classList.toggle("wild5", wildLeft > 0);
    cell.style.setProperty("--sym-color", d.color);
    glyph.textContent = d.glyph;
    glyph.style.opacity = "1";
    glyph.style.transition = "none";
    glyph.style.transform = "translateY(0)";
    this.setBadge(this.badges[c][r], wildLeft);
    if (fromOffsetPx !== undefined && fromOffsetPx !== 0) {
      // ぷよぷよ風：重力で「だんだん速く」落ち、着地でグニャッと潰れて戻る。
      // 落下距離(セル数)に応じて時間が伸びる（自由落下: 距離 ∝ t² → t ∝ √距離）。
      const cells = Math.abs(fromOffsetPx) / this.pitch();
      const fallMs = Math.round(FALL_BASE_MS * Math.sqrt(cells));
      const totalMs = fallMs + SQUASH_MS;
      const land = fallMs / totalMs; // 着地した瞬間の進捗
      glyph.animate(
        [
          // 落下開始：上から、加速イージングで terminal velocity まで
          { transform: `translateY(${fromOffsetPx}px) scaleX(1) scaleY(1)`,
            easing: "cubic-bezier(0.45, 0, 0.85, 0.6)" },
          // 着地の瞬間（最高速で接地）
          { transform: "translateY(0px) scaleX(1) scaleY(1)", offset: land,
            easing: "ease-out" },
          // 接地直後：横に潰れて縦が縮む（スカッシュ）
          { transform: "translateY(0px) scaleX(1.22) scaleY(0.74)",
            offset: land + (1 - land) * 0.4, easing: "ease-in-out" },
          // バネのように元に戻る
          { transform: "translateY(0px) scaleX(1) scaleY(1)" },
        ],
        { duration: totalMs, fill: "backwards" }
      );
      // ワイルドの残回数バッジは絶対配置なので、グリフと一緒に落とさないと
      // 「落下中はバッジだけ着地セルに先に出る」＝非ワイルドに5が出て見える。
      // グリフと同じ縦移動でバッジも追従させる。
      if (wildLeft > 0) {
        const badge = this.badges[c][r];
        badge.animate(
          [
            { transform: `translateY(${fromOffsetPx}px)`,
              easing: "cubic-bezier(0.45, 0, 0.85, 0.6)" },
            { transform: "translateY(0px)", offset: land },
            { transform: "translateY(0px)" },
          ],
          { duration: totalMs, fill: "backwards" }
        );
      }
    }
  }

  /** 回転中の縦伸び＋にじみを適用 */
  private applyBlur(c: number, blur: number): void {
    for (let r = 0; r < ROWS; r++) {
      const glyph = this.glyphs[c][r];
      glyph.style.transition = "none";
      glyph.style.transform = `scaleY(${(1 + blur * 0.95).toFixed(3)})`;
      glyph.style.opacity = (1 - blur * 0.35).toFixed(3);
    }
  }

  /** 回転中の1フレーム描画（ランダムシンボル差し替え＋ブラー） */
  private spinFrame(c: number, blur: number): void {
    for (let r = 0; r < ROWS; r++) {
      const id = randomDropSymbol();
      const d = sym(id);
      this.cells[c][r].dataset.sym = id;
      this.cells[c][r].style.setProperty("--sym-color", d.color);
      this.glyphs[c][r].textContent = d.glyph;
      this.setBadge(this.badges[c][r], 0); // 回転中はバッジ非表示
      this.cells[c][r].classList.remove("wild5");
    }
    this.applyBlur(c, blur);
  }

  setGrid(grid: DGrid, from?: number[][], wild?: number[][]): void {
    this.clearRoads();
    for (let c = 0; c < COLS; c++)
      for (let r = 0; r < ROWS; r++) {
        const off = from ? (from[c][r] - r) * this.pitch() : undefined;
        this.paintCell(c, r, grid[c][r], off, wild ? wild[c][r] : 0);
      }
  }

  renderPreview(preview: SymbolId[][], animate = false): void {
    for (let c = 0; c < COLS; c++)
      for (let idx = 0; idx < PREVIEW_ROWS; idx++) {
        const id = preview[c][idx];
        const d = sym(id);
        const cell = this.previewCells[c][idx];
        const glyph = this.previewGlyphs[c][idx];
        const changed = cell.dataset.sym !== id;
        cell.dataset.sym = id;
        cell.style.setProperty("--sym-color", d.color);
        glyph.textContent = d.glyph;
        // ワイルドファイブは入ってくる時点で5回ぶん（予備でも表示）
        cell.classList.toggle("wild5", id === "wild");
        this.setBadge(this.previewBadges[c][idx], id === "wild" ? WILD_USES : 0);
        // 新しい予備が「上から予備枠へ」落ちてくる（急に現れない）
        if (animate && changed) {
          glyph.animate(
            [
              { transform: `translateY(${-this.pitch()}px)`, opacity: "0.3",
                easing: "cubic-bezier(0.45, 0, 0.85, 0.6)" },
              { transform: "translateY(0px)", opacity: "1" },
            ],
            { duration: FALL_BASE_MS + 40, fill: "backwards" }
          );
        }
      }
  }

  // --- リール回転（スピンイン） ----------------------------------------
  private spinIn(initial: DGrid, initialWild: number[][], cb: DropCallbacks): Promise<void> {
    const start = performance.now();
    const dur = (c: number) => 620 + c * 240;
    const stopped = [false, false, false];
    const lastSwap = [0, 0, 0];

    return new Promise<void>((resolve) => {
      const tick = (t: number) => {
        let all = true;
        for (let c = 0; c < COLS; c++) {
          if (stopped[c]) continue;
          const p = (t - start) / dur(c);
          if (p >= 1) {
            stopped[c] = true;
            for (let r = 0; r < ROWS; r++)
              this.paintCell(c, r, initial[c][r], undefined, initialWild[c][r]);
            cb.onReelStop?.(c);
          } else {
            all = false;
            const blur = 1 - easeOutCubic(p); // 強→0
            if (t - lastSwap[c] > 45) {
              lastSwap[c] = t;
              this.spinFrame(c, blur);
            } else {
              this.applyBlur(c, blur);
            }
          }
        }
        if (all) {
          cb.onAllReelsStopped?.();
          resolve();
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  }

  private highlight(step: CascadeStep): void {
    for (const cl of step.clusters) {
      const color = sym(cl.symbol).color;
      const inCluster = new Set(cl.cells.map(([c, r]) => c * ROWS + r));
      for (const [c, r] of cl.cells) {
        this.cells[c][r].classList.add("match");
        // 同クラスターの隣へ伸びる「道」を点灯し、繋がりを見える化
        for (const [nc, nr] of neighbors(c, r)) {
          if (!inCluster.has(nc * ROWS + nr)) continue;
          const line = this.roads.get(this.roadKey(c, r, nc, nr));
          if (line) {
            line.classList.add("lit");
            line.style.setProperty("--road-color", color);
          }
        }
      }
    }
  }
  private markClearing(step: CascadeStep): void {
    for (const [c, r] of step.cleared) this.cells[c][r].classList.add("clearing");
  }

  /** 1プレイ全体をアニメーション（回転 → 連鎖カスケード） */
  async run(result: DropResult, cb: DropCallbacks = {}): Promise<void> {
    this.renderPreview(result.initialPreview);
    await this.spinIn(result.initial, result.initialWild, cb);
    await wait(220);

    for (const step of result.steps) {
      this.highlight(step);
      cb.onStep?.(step);
      await wait(560);
      this.markClearing(step);
      await wait(300);
      this.setGrid(step.gridAfter, step.from, step.wildAfter);
      this.renderPreview(step.previewAfter, true); // 新しい予備が上から枠へ落ちてくる
      // 落下が完全に着地＆スカッシュ復帰するまで待つ（最長落下ぶん＋余韻）
      await wait(MAX_DROP_MS + 120);
    }
  }
}
