// ===== ランキング UI（祝福モーダル ＋ TOP10 ビューア）=================
//   const ranking = new RankingUI();  app.appendChild(ranking.el);
//   await ranking.maybeCelebrate(mode, score, bet, playerName); // 1ゲーム確定後
//   ranking.openBoard(mode);                                     // 🏆ボタン
import {
  checkRankIn,
  fetchTop,
  submit,
  sanitizeName,
  TOP_N,
  NAME_MAX,
  type RankMode,
  type RankEntry,
} from "../ranking/store";

const MODE_LABEL: Record<RankMode, string> = { drop: "3×3 DROP", slot: "5リール" };

export class RankingUI {
  readonly el: HTMLElement;
  private panel!: HTMLElement;
  private boardMode: RankMode = "drop";
  private highlight: { id?: string; score: number; name: string } | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "rank-overlay hidden";
    this.panel = document.createElement("div");
    this.panel.className = "rank-panel";
    this.el.appendChild(this.panel);
    // 背景クリックで閉じる（ビューア時のみ。祝福モーダルは誤爆防止で無効）。
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el && this.el.dataset.dismissible === "1") this.close();
    });
  }

  private show(): void {
    this.el.classList.remove("hidden");
  }
  private close(): void {
    this.el.classList.add("hidden");
    this.panel.innerHTML = "";
  }

  // ---- 1ゲーム確定後に呼ぶ：ランクインしていれば祝福モーダル ----------
  // onOpen はランクインが確定しモーダルを実際に開く直前に1回呼ばれる
  // （呼び出し側が「裏でゲームを進めない」ロックを張るためのフック）。
  async maybeCelebrate(
    mode: RankMode,
    score: number,
    bet: number,
    defaultName: string,
    onOpen?: () => void
  ): Promise<void> {
    const { rank } = await checkRankIn(mode, score);
    if (rank === null) return; // ランク外：何も出さない（onOpen も呼ばない）
    onOpen?.();
    await this.celebrate(mode, score, bet, rank, sanitizeName(defaultName) || "ゲスト");
  }

  private celebrate(
    mode: RankMode,
    score: number,
    bet: number,
    rank: number,
    defaultName: string
  ): Promise<void> {
    return new Promise((resolve) => {
      this.el.dataset.dismissible = "0";
      this.panel.innerHTML = `
        <div class="rank-celebrate">
          <div class="rank-burst">🎉</div>
          <h2 class="rank-congrats">Congratulations!</h2>
          <p class="rank-sub">${MODE_LABEL[mode]} で <b>${rank}位</b> にランクイン！</p>
          <div class="rank-score">${score.toLocaleString()} <small>メダル</small></div>
          <label class="rank-namelabel">名前を入力して登録</label>
          <input class="rank-name" type="text" maxlength="${NAME_MAX}"
                 value="${escapeHtml(defaultName)}" />
          <div class="rank-actions">
            <button class="btn primary" data-register>ランキングに登録</button>
            <button class="btn ghost" data-skip>登録しない</button>
          </div>
          <p class="rank-note" data-status></p>
        </div>`;
      this.show();

      const input = this.panel.querySelector<HTMLInputElement>(".rank-name")!;
      const status = this.panel.querySelector<HTMLElement>("[data-status]")!;
      const registerBtn = this.panel.querySelector<HTMLButtonElement>("[data-register]")!;
      const skipBtn = this.panel.querySelector<HTMLButtonElement>("[data-skip]")!;
      input.focus();
      input.select();

      const doRegister = async () => {
        const name = sanitizeName(input.value) || "ゲスト";
        registerBtn.disabled = true;
        skipBtn.disabled = true;
        status.textContent = "登録中…";
        const saved = await submit({ name, score, bet, mode });
        this.highlight = { id: saved?.id, score, name };
        if (!saved) status.textContent = "オフラインのため後で同期します（記録は保存済み）";
        // 登録後はランキング一覧（該当モード）を表示して自分の順位を見せる。
        await this.renderBoard(mode);
        resolve();
      };
      const doSkip = () => {
        this.close();
        resolve();
      };

      registerBtn.addEventListener("click", () => void doRegister());
      skipBtn.addEventListener("click", doSkip);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void doRegister();
      });
    });
  }

  // ---- 🏆 ボタン：ランキング閲覧 -------------------------------------
  openBoard(mode: RankMode = "drop"): void {
    this.highlight = null;
    void this.renderBoard(mode);
  }

  private async renderBoard(mode: RankMode): Promise<void> {
    this.boardMode = mode;
    this.el.dataset.dismissible = "1";
    this.show();
    this.panel.innerHTML = `
      <div class="rank-board">
        <div class="rank-head">
          <h2>🏆 ランキング TOP${TOP_N}</h2>
          <button class="rank-x" data-close aria-label="閉じる">✕</button>
        </div>
        <div class="rank-tabs">
          <button class="rank-tab" data-tab="drop">${MODE_LABEL.drop}</button>
          <button class="rank-tab" data-tab="slot">${MODE_LABEL.slot}</button>
        </div>
        <ol class="rank-list" data-list><li class="rank-loading">読み込み中…</li></ol>
      </div>`;
    this.panel.querySelector("[data-close]")!.addEventListener("click", () => this.close());
    this.panel.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
      b.addEventListener("click", () => void this.renderBoard(b.dataset.tab as RankMode))
    );
    this.syncTabs();
    const list = await fetchTop(mode);
    // 描画中にタブが切り替わっていたら破棄
    if (this.boardMode !== mode) return;
    this.paintList(list);
  }

  private syncTabs(): void {
    this.panel.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === this.boardMode)
    );
  }

  private paintList(list: RankEntry[]): void {
    const listEl = this.panel.querySelector<HTMLElement>("[data-list]");
    if (!listEl) return;
    if (list.length === 0) {
      listEl.innerHTML = `<li class="rank-empty">まだ記録がありません。最初の1位を狙おう！</li>`;
      return;
    }
    const medal = (i: number) => (["🥇", "🥈", "🥉"][i] ?? `${i + 1}`);
    listEl.innerHTML = list
      .map((e, i) => {
        const mine =
          this.highlight &&
          ((this.highlight.id && this.highlight.id === e.id) ||
            (!this.highlight.id &&
              this.highlight.score === e.score &&
              this.highlight.name === e.name));
        return `
          <li class="rank-row${mine ? " mine" : ""}${i < 3 ? " top3" : ""}">
            <span class="rank-pos">${medal(i)}</span>
            <span class="rank-name-cell">${escapeHtml(e.name)}</span>
            <span class="rank-score-cell">${e.score.toLocaleString()}</span>
          </li>`;
      })
      .join("");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
