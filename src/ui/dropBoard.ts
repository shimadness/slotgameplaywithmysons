// ===== 3×3 DROP 盤面（本家準拠：8ライン＋コネクト＋オッズ表示） =====
// dropEngine の DropResult を受け取り、回転→連鎖カスケードを描画する。
import {
  COLS, ROWS, PREVIEW_ROWS, WILD_USES, BASE_SYMS, ODDS_LADDER,
  DSYMBOLS, neighbors, randomDropSymbol,
  type DSym, type DGrid, type CascadeStep, type DropResult,
} from "../game/dropEngine";

const DCELL = 116; // フォールバック高さ(px)。CSS --dcell 上限と一致。
const GAP = 8;
const FALL_BASE_MS = 320;
const SQUASH_MS = 140;
const MAX_DROP_MS = Math.round(FALL_BASE_MS * Math.sqrt(ROWS + 1) + SQUASH_MS);

export interface DropCallbacks {
  onStep?: (step: CascadeStep) => void;
  onReelStop?: (col: number) => void;
  onAllReelsStopped?: () => void;
}

function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function easeOutCubic(t: number): number { return 1 - Math.pow(1 - t, 3); }
function dsym(id: DSym) { return DSYMBOLS[id]; }

export class DropBoard {
  readonly el: HTMLElement;
  private cells: HTMLElement[][] = [];
  private glyphs: HTMLElement[][] = [];
  private badges: HTMLElement[][] = [];
  private previewCells: HTMLElement[][] = [];
  private previewGlyphs: HTMLElement[][] = [];
  private previewBadges: HTMLElement[][] = [];
  private oddsRows: Record<string, HTMLElement> = {};

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "drop-stack";

    // NEXT プレビュー管
    const previews = document.createElement("div");
    previews.className = "drop-previews";
    for (let c = 0; c < COLS; c++) {
      const tube = document.createElement("div");
      tube.className = "ptube";
      for (let idx = PREVIEW_ROWS - 1; idx >= 0; idx--) {
        const cell = document.createElement("div");
        cell.className = "ptube-cell";
        if (idx === 0) cell.classList.add("next");
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

    // グリッド＋道レイヤー
    const wrap = document.createElement("div");
    wrap.className = "drop-grid-wrap";
    wrap.appendChild(this.buildRoads());
    const grid = document.createElement("div");
    grid.className = "drop-grid";
    for (let r = 0; r < ROWS; r++)
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
    wrap.appendChild(grid);
    this.el.appendChild(wrap);

    // オッズ表示（11シンボルの現在オッズ。役成立で上昇する様子を見せる）
    this.el.appendChild(this.buildOddsPanel());
  }

  // --- オッズパネル --------------------------------------------------
  private buildOddsPanel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "odds-panel";
    for (const id of [...BASE_SYMS].reverse()) {
      const row = document.createElement("div");
      row.className = "odds-row";
      row.style.setProperty("--sym-color", dsym(id).color);
      const g = document.createElement("span");
      g.className = "odds-glyph glyph";
      g.textContent = dsym(id).glyph;
      const v = document.createElement("span");
      v.className = "odds-val";
      v.textContent = "×" + dsym(id).lineOdds;
      row.appendChild(g);
      row.appendChild(v);
      panel.appendChild(row);
      this.oddsRows[id] = v;
    }
    return panel;
  }
  /** odds は dropEngine の oddsAfter（シンボル→階段インデックス） */
  setOdds(odds: Record<string, number>, flash?: Set<string>): void {
    for (const id of BASE_SYMS) {
      const idx = odds[id] ?? 0;
      const el = this.oddsRows[id];
      if (!el) continue;
      el.textContent = "×" + ODDS_LADDER[idx];
      if (flash?.has(id)) {
        el.parentElement?.classList.remove("up");
        void el.parentElement?.offsetWidth; // reflow でアニメ再start
        el.parentElement?.classList.add("up");
      }
    }
  }

  // --- 道レイヤー（コネクトの隣接を可視化） --------------------------
  private roads = new Map<string, SVGLineElement>();
  private pitch(): number {
    const h = this.cells[0]?.[0]?.offsetHeight || DCELL;
    return h + GAP;
  }
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
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        for (const [nc, nr] of neighbors(c, r)) {
          const key = this.roadKey(c, r, nc, nr);
          if (this.roads.has(key)) continue;
          const line = document.createElementNS(NS, "line");
          line.setAttribute("x1", String(cx(c))); line.setAttribute("y1", String(cy(r)));
          line.setAttribute("x2", String(cx(nc))); line.setAttribute("y2", String(cy(nr)));
          svg.appendChild(line);
          this.roads.set(key, line);
        }
    return svg;
  }
  private roadKey(c1: number, r1: number, c2: number, r2: number): string {
    const a = c1 * ROWS + r1, b = c2 * ROWS + r2;
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }
  private clearRoads(): void {
    for (const line of this.roads.values()) {
      line.classList.remove("lit");
      line.style.removeProperty("--road-color");
    }
  }

  private setBadge(badge: HTMLElement, wildLeft: number): void {
    if (wildLeft > 0) { badge.textContent = String(wildLeft); badge.classList.add("show"); }
    else { badge.textContent = ""; badge.classList.remove("show"); }
  }

  // --- セル描画 ------------------------------------------------------
  private paintCell(c: number, r: number, id: DSym, fromOffsetPx?: number, wildLeft = 0): void {
    const d = dsym(id);
    const cell = this.cells[c][r];
    const glyph = this.glyphs[c][r];
    cell.dataset.sym = id;
    cell.classList.remove("match", "clearing");
    cell.classList.toggle("wild5", wildLeft > 0);
    cell.classList.toggle("is-blank", id === "blank");
    cell.classList.toggle("is-text", id === "bar" || id === "bar2" || id === "bar3" || id === "blue7" || id === "red7" || id === "gold7");
    cell.style.setProperty("--sym-color", d.color);
    glyph.textContent = d.glyph;
    glyph.style.opacity = "1";
    glyph.style.transition = "none";
    glyph.style.transform = "translateY(0)";
    this.setBadge(this.badges[c][r], wildLeft);
    if (fromOffsetPx !== undefined && fromOffsetPx !== 0) {
      const cells = Math.abs(fromOffsetPx) / this.pitch();
      const fallMs = Math.round(FALL_BASE_MS * Math.sqrt(cells));
      const totalMs = fallMs + SQUASH_MS;
      const land = fallMs / totalMs;
      const drop = [
        { transform: `translateY(${fromOffsetPx}px) scaleX(1) scaleY(1)`, easing: "cubic-bezier(0.45,0,0.85,0.6)" },
        { transform: "translateY(0px) scaleX(1) scaleY(1)", offset: land, easing: "ease-out" },
        { transform: "translateY(0px) scaleX(1.22) scaleY(0.74)", offset: land + (1 - land) * 0.4, easing: "ease-in-out" },
        { transform: "translateY(0px) scaleX(1) scaleY(1)" },
      ];
      glyph.animate(drop, { duration: totalMs, fill: "backwards" });
      if (wildLeft > 0) {
        this.badges[c][r].animate(
          [{ transform: `translateY(${fromOffsetPx}px)`, easing: "cubic-bezier(0.45,0,0.85,0.6)" },
           { transform: "translateY(0px)", offset: land }, { transform: "translateY(0px)" }],
          { duration: totalMs, fill: "backwards" });
      }
    }
  }

  private applyBlur(c: number, blur: number): void {
    for (let r = 0; r < ROWS; r++) {
      const glyph = this.glyphs[c][r];
      glyph.style.transition = "none";
      glyph.style.transform = `scaleY(${(1 + blur * 0.95).toFixed(3)})`;
      glyph.style.opacity = (1 - blur * 0.35).toFixed(3);
    }
  }
  private spinFrame(c: number, blur: number): void {
    for (let r = 0; r < ROWS; r++) {
      const id = randomDropSymbol();
      const d = dsym(id);
      this.cells[c][r].dataset.sym = id;
      this.cells[c][r].style.setProperty("--sym-color", d.color);
      this.glyphs[c][r].textContent = d.glyph;
      this.cells[c][r].classList.toggle("is-blank", id === "blank");
      this.cells[c][r].classList.toggle("is-text", id === "bar" || id === "bar2" || id === "bar3" || id === "blue7" || id === "red7" || id === "gold7");
      this.setBadge(this.badges[c][r], 0);
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

  renderPreview(preview: DSym[][], animate = false): void {
    for (let c = 0; c < COLS; c++)
      for (let idx = 0; idx < PREVIEW_ROWS; idx++) {
        const id = preview[c][idx];
        const d = dsym(id);
        const cell = this.previewCells[c][idx];
        const glyph = this.previewGlyphs[c][idx];
        const changed = cell.dataset.sym !== id;
        cell.dataset.sym = id;
        cell.style.setProperty("--sym-color", d.color);
        glyph.textContent = d.glyph;
        cell.classList.toggle("wild5", id === "wild");
        cell.classList.toggle("is-blank", id === "blank");
        cell.classList.toggle("is-text", id === "bar" || id === "bar2" || id === "bar3" || id === "blue7" || id === "red7" || id === "gold7");
        this.setBadge(this.previewBadges[c][idx], id === "wild" ? WILD_USES : 0);
        if (animate && changed) {
          const drop = [
            { transform: `translateY(${-this.pitch()}px)`, opacity: "0.3", easing: "cubic-bezier(0.45,0,0.85,0.6)" },
            { transform: "translateY(0px)", opacity: "1" },
          ];
          const opts = { duration: FALL_BASE_MS + 40, fill: "backwards" as const };
          glyph.animate(drop, opts);
          if (id === "wild") this.previewBadges[c][idx].animate(drop, opts);
        }
      }
  }

  // --- 回転（スピンイン） --------------------------------------------
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
            for (let r = 0; r < ROWS; r++) this.paintCell(c, r, initial[c][r], undefined, initialWild[c][r]);
            cb.onReelStop?.(c);
          } else {
            all = false;
            const blur = 1 - easeOutCubic(p);
            if (t - lastSwap[c] > 45) { lastSwap[c] = t; this.spinFrame(c, blur); }
            else this.applyBlur(c, blur);
          }
        }
        if (all) { cb.onAllReelsStopped?.(); resolve(); }
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // --- 役ハイライト（ライン＋コネクト） ------------------------------
  private highlight(step: CascadeStep): void {
    // ライン役：セルを光らせる
    for (const w of step.lineWins) {
      const color = dsym(w.symbol).color;
      for (const [c, r] of w.cells) {
        this.cells[c][r].classList.add("match");
        this.cells[c][r].style.setProperty("--sym-color", color);
      }
    }
    // コネクト役：セル＋繋がった道を点灯
    for (const w of step.connectWins) {
      const color = dsym(w.symbol).color;
      const inSet = new Set(w.cells.map(([c, r]) => c * ROWS + r));
      for (const [c, r] of w.cells) {
        this.cells[c][r].classList.add("match");
        this.cells[c][r].style.setProperty("--sym-color", color);
        for (const [nc, nr] of neighbors(c, r)) {
          if (!inSet.has(nc * ROWS + nr)) continue;
          const line = this.roads.get(this.roadKey(c, r, nc, nr));
          if (line) { line.classList.add("lit"); line.style.setProperty("--road-color", color); }
        }
      }
    }
  }
  private markClearing(step: CascadeStep): void {
    for (const [c, r] of step.cleared) this.cells[c][r].classList.add("clearing");
  }

  /** 1プレイ全体をアニメーション */
  async run(result: DropResult, cb: DropCallbacks = {}): Promise<void> {
    this.setOdds(result.oddsStart);
    this.renderPreview(result.initialPreview);
    await this.spinIn(result.initial, result.initialWild, cb);
    await wait(220);

    for (const step of result.steps) {
      this.highlight(step);
      cb.onStep?.(step);
      // オッズ上昇したシンボルをフラッシュ
      const flash = new Set(step.lineWins.map((w) => {
        // そのシンボル以上が上がるが、簡易に当該シンボルだけ光らせる
        return w.symbol;
      }));
      await wait(560);
      this.setOdds(step.oddsAfter, flash);
      this.markClearing(step);
      await wait(300);
      this.setGrid(step.gridAfter, step.from, step.wildAfter);
      this.renderPreview(step.previewAfter, true);
      await wait(MAX_DROP_MS + 120);
    }
  }
}
