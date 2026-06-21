// ===== 3×3 DROP 盤面（本家準拠：8ライン＋コネクト＋オッズ表示） =====
// dropEngine の DropResult を受け取り、回転→連鎖カスケードを描画する。
import {
  COLS, ROWS, PREVIEW_ROWS, WILD_USES, BASE_SYMS, ODDS_LADDER,
  DSYMBOLS, neighbors, randomDropSymbol, SEVEN_RUSH_GAMES,
  type DSym, type DGrid, type CascadeStep, type DropResult,
} from "../game/dropEngine";

const DCELL = 116; // フォールバック高さ(px)。CSS --dcell 上限と一致。
const GAP = 8;
const FALL_BASE_MS = 320;
const SQUASH_MS = 140;
const MAX_DROP_MS = Math.round(FALL_BASE_MS * Math.sqrt(ROWS + 1) + SQUASH_MS);

const REACH_SPIN_MS = 2200; // リーチ時、最終列をゆっくり長く回す時間

export interface DropCallbacks {
  onStep?: (step: CascadeStep) => void;
  onReelStop?: (col: number) => void;
  onAllReelsStopped?: () => void;
  /** 他の列が止まり、最終列だけがリーチ状態で回り始めた時に1回 */
  onReach?: () => void;
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
  private oddsNext: Record<string, HTMLElement> = {}; // 「次の倍率」プレビュー

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

    // 左カラム（プレビュー＋グリッド）＋ 右カラム（オッズ縦並び）を横並びに
    const mainRow = document.createElement("div");
    mainRow.className = "drop-main-row";
    const leftCol = document.createElement("div");
    leftCol.className = "drop-left";
    leftCol.appendChild(previews);

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
    leftCol.appendChild(wrap);

    mainRow.appendChild(leftCol);
    // 右カラム：オッズ表示（役成立で上昇）＋ 下にセブンラッシュのルール
    const rightCol = document.createElement("div");
    rightCol.className = "drop-right";
    rightCol.appendChild(this.buildOddsPanel());
    rightCol.appendChild(this.buildRushRule());
    mainRow.appendChild(rightCol);
    this.el.appendChild(mainRow);
  }

  // --- セブンラッシュのルール（オッズ列の下の空きスペースに簡潔に） ----
  private buildRushRule(): HTMLElement {
    const box = document.createElement("div");
    box.className = "drop-rush-rule";
    // 電光掲示板風に1行で横スクロール。シームレスループ用に同じ文を2つ並べる。
    const text = `7️⃣ <b>セブンラッシュ</b> ― 7️⃣が3つそろうと<b>${SEVEN_RUSH_GAMES}ゲーム</b>突入！“7”が大量に出て<b>高配当</b>のチャンス！`;
    box.innerHTML = `<div class="rr-track"><span class="rr-seg">${text}</span><span class="rr-seg" aria-hidden="true">${text}</span></div>`;
    return box;
  }

  // --- オッズパネル --------------------------------------------------
  private buildOddsPanel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "odds-panel";
    // gold7（固定×1000・激レア）を最上段に
    panel.appendChild(this.buildOddsRow("gold7", true));
    // 以降は弱→強の逆順（red7 が上）。各行に「次の倍率」プレビューを表示
    for (const id of [...BASE_SYMS].reverse()) panel.appendChild(this.buildOddsRow(id, false));
    return panel;
  }
  private buildOddsRow(id: DSym, fixed: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "odds-row";
    if (id === "bar" || id === "bar2" || id === "bar3" || id === "blue7" || id === "red7" || id === "gold7")
      row.classList.add("is-text");
    row.style.setProperty("--sym-color", dsym(id).color);
    const g = document.createElement("span");
    g.className = "odds-glyph glyph";
    g.textContent = dsym(id).glyph;
    // クリップ窓＋縦ロール（だるま落とし風に ×N が上から降って入れ替わる）
    // 右側に [現在オッズ] を上、[次の倍率] を下に縦積み（横幅を増やさない）
    const right = document.createElement("span");
    right.className = "odds-right";
    const v = document.createElement("span");
    v.className = "odds-val";
    const track = document.createElement("span");
    track.className = "odds-roll";
    track.textContent = "×" + dsym(id).lineOdds;
    track.dataset.v = track.textContent;
    v.appendChild(track);
    const next = document.createElement("span");
    next.className = "odds-next";
    if (fixed) {
      next.textContent = "固定";
      next.classList.add("is-fixed");
    } else {
      const startIdx = ODDS_LADDER.indexOf(dsym(id).lineOdds);
      next.textContent = this.nextOddsText(startIdx);
      this.oddsNext[id] = next;
    }
    right.appendChild(v);
    right.appendChild(next);
    row.appendChild(g);
    row.appendChild(right);
    this.oddsRows[id] = track;
    return row;
  }
  /** 現在の階段インデックスから「次に上がる倍率」テキスト（上限なら MAX）。 */
  private nextOddsText(curIdx: number): string {
    const max = ODDS_LADDER.length - 1;
    return curIdx >= max ? "MAX" : "↑×" + ODDS_LADDER[curIdx + 1];
  }
  /** odds は dropEngine の oddsAfter（シンボル→階段インデックス）。上昇時はだるま落とし風ロール。 */
  setOdds(odds: Record<string, number>): void {
    for (const id of BASE_SYMS) {
      const idx = odds[id] ?? 0;
      const track = this.oddsRows[id];
      if (!track) continue;
      const nextEl = this.oddsNext[id]; // 「次の倍率」プレビューも追従
      if (nextEl) nextEl.textContent = this.nextOddsText(idx);
      const newNum = ODDS_LADDER[idx];
      const newText = "×" + newNum;
      const cur = track.dataset.v || track.textContent;
      if (cur === newText) continue;
      const oldNum = parseInt((cur || "×0").slice(1)) || 0;
      const row = track.closest(".odds-row") as HTMLElement | null;
      if (newNum > oldNum) {
        // 新しい×Nを上に積み、旧を下に。track を下げて新を窓に降ろす＝上から降ってくる演出。
        track.innerHTML =
          `<span class="roll-line">${newText}</span><span class="roll-line">${cur}</span>`;
        track.animate(
          [{ transform: "translateY(-50%)" }, { transform: "translateY(0)" }],
          { duration: 380, easing: "cubic-bezier(0.34,1.5,0.5,1)" }
        );
        row?.classList.remove("up");
        void row?.offsetWidth;
        row?.classList.add("up");
        const settle = newText;
        setTimeout(() => { track.textContent = settle; track.dataset.v = settle; }, 370);
      } else {
        track.textContent = newText;
        track.dataset.v = newText;
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
  private paintCell(c: number, r: number, id: DSym, fromOffsetPx?: number, wildLeft = 0, frozen = false): void {
    const d = dsym(id);
    const cell = this.cells[c][r];
    const glyph = this.glyphs[c][r];
    cell.dataset.sym = id;
    cell.classList.remove("match", "line-match", "clearing", "melting");
    cell.classList.toggle("wild5", wildLeft > 0 && !frozen);
    cell.classList.toggle("is-frozen", frozen);
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
      this.cells[c][r].classList.toggle("is-text", id === "bar" || id === "bar2" || id === "bar3" || id === "blue7" || id === "red7" || id === "gold7");
      this.cells[c][r].classList.remove("is-frozen");
      this.setBadge(this.badges[c][r], 0);
      this.cells[c][r].classList.remove("wild5");
    }
    this.applyBlur(c, blur);
  }

  setGrid(grid: DGrid, from?: number[][], wild?: number[][], frozen?: boolean[][]): void {
    this.clearRoads();
    for (let c = 0; c < COLS; c++)
      for (let r = 0; r < ROWS; r++) {
        const off = from ? (from[c][r] - r) * this.pitch() : undefined;
        this.paintCell(c, r, grid[c][r], off, wild ? wild[c][r] : 0, frozen ? frozen[c][r] : false);
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
  private spinIn(initial: DGrid, initialWild: number[][], initialFrozen: boolean[][], cb: DropCallbacks): Promise<void> {
    const reachCol = COLS - 1;
    // リーチ＝最終列で完成するラインの「既知2セル」が揃っている＝最後の枠次第
    const reach = this.detectReach(initial, initialFrozen);
    const start = performance.now();
    const dur = (c: number) => (c === reachCol && reach ? REACH_SPIN_MS : 620 + c * 240);
    const stopped = [false, false, false];
    const lastSwap = [0, 0, 0];
    let reachAnnounced = false;
    return new Promise<void>((resolve) => {
      const tick = (t: number) => {
        // 他の列が止まり、最終列だけ回っている瞬間にリーチ告知＋発光
        if (reach && !reachAnnounced && !stopped[reachCol] &&
            stopped.slice(0, reachCol).every(Boolean)) {
          reachAnnounced = true;
          for (let r = 0; r < ROWS; r++) this.cells[reachCol][r].classList.add("reach-spin");
          cb.onReach?.();
        }
        let all = true;
        for (let c = 0; c < COLS; c++) {
          if (stopped[c]) continue;
          const p = (t - start) / dur(c);
          if (p >= 1) {
            stopped[c] = true;
            for (let r = 0; r < ROWS; r++) this.paintCell(c, r, initial[c][r], undefined, initialWild[c][r], initialFrozen[c][r]);
            if (c === reachCol) for (let r = 0; r < ROWS; r++) this.cells[c][r].classList.remove("reach-spin");
            cb.onReelStop?.(c);
          } else {
            all = false;
            const blur = 1 - easeOutCubic(p);
            // リーチ中の最終列は終盤ほど切り替えを遅く＝ゆっくり回って見える
            const isReachCol = reach && c === reachCol;
            const swapMs = isReachCol ? 45 + (1 - blur) * 240 : 45;
            if (t - lastSwap[c] > swapMs) { lastSwap[c] = t; this.spinFrame(c, blur); }
            else this.applyBlur(c, blur);
          }
        }
        if (all) { cb.onAllReelsStopped?.(); resolve(); }
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  /** リーチ判定：最終列(col2)で完成するライン(横3・斜め2)の既知2セルが揃うか。 */
  private detectReach(g: DGrid, fz: boolean[][]): boolean {
    const pairs: Array<[[number, number], [number, number]]> = [];
    for (let r = 0; r < ROWS; r++) pairs.push([[0, r], [1, r]]); // 横3本（保留=(2,r)）
    pairs.push([[0, 0], [1, 1]]); // 斜め＼（保留=(2,2)）
    pairs.push([[1, 1], [0, 2]]); // 斜め／（保留=(2,0)）
    return pairs.some(([a, b]) => this.cellsMatch(g, fz, a, b));
  }
  private cellsMatch(g: DGrid, fz: boolean[][], a: [number, number], b: [number, number]): boolean {
    const [ac, ar] = a, [bc, br] = b;
    if (fz[ac][ar] || fz[bc][br]) return false;          // 氷は役に使えない
    const sa = g[ac][ar], sb = g[bc][br];
    if (sa === "rush7" || sb === "rush7") return false;  // スキャッターは役に不参加
    if (sa === "wild" || sb === "wild") return true;     // ワイルドは何にでも一致
    return sa === sb;
  }

  // --- 役ハイライト（ライン＋コネクト） ------------------------------
  private highlight(step: CascadeStep): void {
    // ライン役：セルを光らせる＋「揃った瞬間」の回転＋浮き出し演出（ラインのみ）
    for (const w of step.lineWins) {
      const color = dsym(w.symbol).color;
      for (const [c, r] of w.cells) {
        this.cells[c][r].classList.add("match", "line-match");
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
    this.renderPreview(result.initialPreview); // 開始時点でNEXTに次の出目を表示（従来の動き）
    await this.spinIn(result.initial, result.initialWild, result.initialFrozen, cb);
    await wait(220);

    for (const step of result.steps) {
      // ライン成立時だけ「少しスロー」で揃ったマスを見せる（落下/消去は通常速度のまま）
      const lineHit = step.lineWins.length > 0;

      this.highlight(step);
      // 隣接の役で溶ける氷をパキッと演出
      for (const [c, r] of step.melted) this.cells[c][r].classList.add("melting");
      cb.onStep?.(step);
      await wait(lineHit ? 780 : 560); // 揃った瞬間のみ少しため（回転＋浮き出し演出を見せる）
      this.setOdds(step.oddsAfter); // 上昇ぶんがだるま落とし風にロール
      this.markClearing(step);
      await wait(300);
      this.setGrid(step.gridAfter, step.from, step.wildAfter, step.frozenAfter);
      this.renderPreview(step.previewAfter, true);
      await wait(MAX_DROP_MS + 120);
    }
  }
}
