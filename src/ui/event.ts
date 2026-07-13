// ===== 大会モード UI =====================================================
// 「15分で だれが いちばん かせげるか」タイムアタック大会。
//   - あいことば（コード）で同じ大会に集合。作った人がホスト。
//   - 全員同じ初期メダル・同じ制限時間。終了時の所持メダルで勝負。
//   - 観戦ページ(watch.html?e=CODE)にライブ順位と速報が流れる。
// UX方針: 説明文より視覚（巨大コード・カウントダウン・発光タイマー）。
import type { GameState } from "../game/state";
import type { Sfx } from "../audio/sfx";
import {
  COUNTDOWN_MS,
  GRACE_MS,
  EventClient,
  endAtOf,
  randomCode,
  sanitizeCode,
  type EventMeta,
  type EventPlayer,
  type EventSnap,
  type FeedItem,
} from "../event/client";
import { serverNow } from "../event/api";

/** 全員共通の初期メダル */
export const EVENT_SEED = 1000;
/** 一度きりの復活ボーナス */
const RESCUE_AMOUNT = 300;
/** これ以上の獲得は速報フィードに流す */
const BIGWIN_FEED = 5000;
/** 選べる制限時間（分） */
const DURATIONS_MIN = [5, 10, 15];
const DEFAULT_MIN = 15;

type Phase = "idle" | "lobby" | "countdown" | "playing" | "ended" | "ceremony";

export interface EventDeps {
  state: GameState;
  sfx: Sfx;
  /** メインループがスピン/精算中か（busyフラグ） */
  isBusy: () => boolean;
  /** 大会開始時（AUTO解除・⚡ON・HUD更新など） */
  onEnter: () => void;
  /** 大会終了・通常復帰時 */
  onExit: () => void;
  /** HUDの数字を更新（復活ボーナス反映用） */
  refreshHud: () => void;
  /** 紙吹雪 */
  burst: (n: number) => void;
}

const FEED_TEXT: Record<FeedItem["t"], (name: string, amt?: number) => string> = {
  join: (n) => `🙌 ${n} が参戦！`,
  rush: (n) => `🔥 ${n} セブンラッシュ突入！`,
  tengu: (n) => `👺 ${n} 天狗フリー突入！`,
  bigwin: (n, a) => `💰 ${n} +${(a ?? 0).toLocaleString()}`,
  broke: (n) => `💀 ${n} 破産…`,
  revive: (n) => `♻️ ${n} 復活！`,
  final: (n, a) => `🏁 ${n} 確定 ${(a ?? 0).toLocaleString()}`,
};

export class EventUI {
  /** モーダル群（参加・ロビー・表彰式）を載せるオーバーレイ */
  readonly el: HTMLElement;
  /** ヘッダー下に挿す残り時間バー */
  readonly timerBar: HTMLElement;
  private toastsEl: HTMLElement;
  private rescueBtn: HTMLButtonElement;

  private phase: Phase = "idle";
  private client: EventClient | null = null;
  private isHost = false;
  private meta: EventMeta | null = null;
  private endAt = 0;

  private tickIv = 0;
  private pollIv = 0;
  private spins = 0;
  private finalized = false;
  private brokeReported = false;
  private lastSent = { credits: NaN, spins: -1 };
  private heartbeatSkip = 0;
  private seenFeed = new Set<string>();
  private feedPrimed = false;
  private lastBeepSec = -1;

  constructor(private deps: EventDeps) {
    this.el = document.createElement("div");
    this.el.className = "ev-overlay hidden";

    this.timerBar = document.createElement("div");
    this.timerBar.className = "ev-timer hidden";
    this.timerBar.innerHTML = `
      <span class="ev-timer-flag">🏁</span>
      <div class="ev-timer-track"><div class="ev-timer-fill" data-fill></div></div>
      <b class="ev-clock" data-clock>--:--</b>
      <button class="ev-quit" data-quit title="中断／退出">⏹</button>`;
    this.timerBar
      .querySelector("[data-quit]")!
      .addEventListener("click", () => this.onQuitClicked());

    this.toastsEl = document.createElement("div");
    this.toastsEl.className = "ev-toasts";
    document.body.appendChild(this.toastsEl);

    this.rescueBtn = document.createElement("button");
    this.rescueBtn.className = "btn gold ev-rescue hidden";
    this.rescueBtn.innerHTML = `♻️ ふっかつ <b>+${RESCUE_AMOUNT}</b>`;
    this.rescueBtn.addEventListener("click", () => this.doRescue());
    document.body.appendChild(this.rescueBtn);
  }

  // ================= 公開 API（main.ts から呼ぶ） =====================
  get active(): boolean {
    return this.phase !== "idle";
  }

  /** スピンを止めるべきか。RUSH消化はタイムアップ後も許可（駆け込みドラマ）。 */
  blocksSpin(): boolean {
    switch (this.phase) {
      case "lobby":
      case "countdown":
      case "ceremony":
        return true;
      case "ended":
        return !this.deps.state.inRush;
      case "playing":
        return this.endAt > 0 && serverNow() >= this.endAt && !this.deps.state.inRush;
      default:
        return false;
    }
  }

  /** ラッシュ突入の速報（kind: "rush"=セブンラッシュ / "tengu"=天狗フリー） */
  notifyRush(kind: "rush" | "tengu"): void {
    if (!this.active || !this.client) return;
    void this.client.feed(kind);
  }

  /** 大きな獲得の速報（しきい値未満は流さない） */
  notifyWin(amount: number): void {
    if (!this.active || !this.client || amount < BIGWIN_FEED) return;
    void this.client.feed("bigwin", amount);
  }

  /** 1スピンサイクル完了ごとに呼ぶ（スピン数カウント＋即時スコア送信） */
  onSpinCycleEnd(): void {
    if (this.phase !== "playing" && this.phase !== "ended") return;
    this.spins++;
    void this.sendHeartbeat(true);
  }

  /**
   * いま確定したスコアを即座に送信（スピン数は増やさない）。
   * ラッシュ後ダブルアップの最終値など「スピン境界でない確定」で、
   * 自分/他プレイヤー/観戦モニターの表示を素早く一致させるために使う。
   */
  reportScoreNow(): void {
    if (this.phase !== "playing" && this.phase !== "ended") return;
    void this.sendHeartbeat(true);
  }

  /** 🎪ボタン: 参加モーダルを開く */
  openJoin(defaultName: string): void {
    if (this.active) return;
    this.renderJoin(defaultName);
  }

  /** 起動時: リロード前の大会があれば復帰する */
  async maybeResume(): Promise<void> {
    const local = EventClient.local();
    if (!local) return;
    const client = new EventClient(local.code, local.pid, local.name);
    const snap = await client.snap();
    const meta = snap?.meta;
    if (!meta || meta.status === "done") {
      EventClient.clearLocal();
      try {
        localStorage.removeItem(`triple-slot.event.save.${local.code}.${local.pid}`);
      } catch { /* ignore */ }
      return;
    }
    this.client = client;
    this.isHost = meta.host === local.pid;
    this.meta = meta;
    if (meta.status === "lobby") {
      // ロビーに戻る（自分の参加枠を立て直す）
      await client.createOrJoin({ durationMs: meta.durationMs, seed: meta.seed });
      this.enterLobby();
    } else if (meta.startAt) {
      // 進行中 or 集計待ち → 大会ウォレットを復元して合流
      this.beginPlaying(meta);
    }
  }

  // ================= 参加モーダル =====================================
  private renderJoin(defaultName: string): void {
    this.showPanel(`
      <div class="ev-panel ev-join">
        <h2 class="ev-title">👑 メダル王決定戦</h2>
        <p class="ev-sub">15分で メダルを いちばん 稼いだ人が優勝！<br />おなじ <b>あいことば</b> で あつまろう</p>
        <input class="ev-input" data-name type="text" maxlength="12"
               placeholder="なまえ" value="${escapeHtml(defaultName)}" />
        <input class="ev-input ev-code-input" data-code type="text" maxlength="8"
               placeholder="あいことば（みんなで そろえる）" autocapitalize="characters" />
        <div class="ev-durs" data-durs>
          ${DURATIONS_MIN.map(
            (m) =>
              `<button class="ev-dur${m === DEFAULT_MIN ? " active" : ""}" data-min="${m}">${m}ふん</button>`
          ).join("")}
        </div>
        <div class="ev-actions">
          <button class="btn primary" data-entry>エントリー</button>
          <button class="btn ghost" data-close>とじる</button>
        </div>
        <p class="ev-note" data-status></p>
      </div>`);

    const nameIn = this.el.querySelector<HTMLInputElement>("[data-name]")!;
    const codeIn = this.el.querySelector<HTMLInputElement>("[data-code]")!;
    const status = this.el.querySelector<HTMLElement>("[data-status]")!;
    const dursBox = this.el.querySelector<HTMLElement>("[data-durs]")!;
    const entryBtn = this.el.querySelector<HTMLButtonElement>("[data-entry]")!;
    let durationMin = DEFAULT_MIN;

    // あいことばを入力すると「既にその大会があるか」を先読みして表示を切り替える。
    // 既存があれば時間ピッカーを隠し「参加（○ふん）」に＝別ゲーム化の誤解を防ぐ。
    let peekTimer = 0;
    const refreshRoomHint = async (): Promise<void> => {
      const code = sanitizeCode(codeIn.value);
      const room = code ? await EventClient.peekLive(code) : null;
      if (sanitizeCode(codeIn.value) !== code) return; // 入力が変わっていたら破棄
      if (room) {
        dursBox.style.display = "none";
        const mm = Math.round(room.durationMs / 60_000);
        const label = room.status === "running" ? "開催中" : "受付中";
        status.textContent = `この あいことば の大会に参加（${mm}ふん・${label}）`;
        entryBtn.textContent = "参加する";
      } else {
        dursBox.style.display = "";
        status.textContent = "";
        entryBtn.textContent = "エントリー";
      }
    };
    codeIn.addEventListener("input", () => {
      codeIn.value = sanitizeCode(codeIn.value);
      clearTimeout(peekTimer);
      peekTimer = window.setTimeout(() => void refreshRoomHint(), 400);
    });
    this.el.querySelectorAll<HTMLButtonElement>(".ev-dur").forEach((b) =>
      b.addEventListener("click", () => {
        durationMin = Number(b.dataset.min);
        this.el
          .querySelectorAll(".ev-dur")
          .forEach((x) => x.classList.toggle("active", x === b));
      })
    );
    this.el.querySelector("[data-close]")!.addEventListener("click", () => this.hidePanel());
    this.el.querySelector<HTMLButtonElement>("[data-entry]")!.addEventListener("click", async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const name = (nameIn.value.trim() || "ゲスト").slice(0, 12);
      const code = sanitizeCode(codeIn.value) || randomCode();
      btn.disabled = true;
      status.textContent = "つなぎちゅう…";

      // 同じコードに入り直す時は前回の pid を使う（自分の枠を増やさない）
      const prev = EventClient.local();
      const pid =
        prev && prev.code === code ? prev.pid : "p" + Math.random().toString(36).slice(2, 9);
      const client = new EventClient(code, pid, name);
      const r = await client.createOrJoin({
        durationMs: durationMin * 60_000,
        seed: EVENT_SEED,
      });
      if (!r.ok || !r.meta) {
        status.textContent = "つながらなかった… もういちど ためしてね";
        btn.disabled = false;
        return;
      }
      this.client = client;
      this.isHost = r.isHost;
      this.meta = r.meta;
      client.saveLocal();
      this.deps.sfx.bonus();
      if (r.meta.status === "running" && r.meta.startAt) {
        this.beginPlaying(r.meta); // 途中参加
      } else {
        this.enterLobby();
      }
    });
  }

  // ================= ロビー ===========================================
  private enterLobby(): void {
    this.phase = "lobby";
    const code = this.client!.code;
    const watchUrl = new URL("watch.html", location.href);
    watchUrl.search = `?e=${code}`;
    this.showPanel(`
      <div class="ev-panel ev-lobby">
        <p class="ev-sub">あいことば</p>
        <div class="ev-code">${escapeHtml(code)}</div>
        <p class="ev-watch">📺 観戦・実況モニター<br /><span class="ev-watch-url">${escapeHtml(
          watchUrl.href
        )}</span></p>
        <div class="ev-players" data-players></div>
        ${
          this.isHost
            ? `<button class="btn gold ev-start" data-start>▶ スタート</button>`
            : `<p class="ev-waiting">スタートを まってるよ…</p>`
        }
        <button class="btn ghost" data-leave>やめる</button>
      </div>`);
    this.el.querySelector("[data-leave]")!.addEventListener("click", async () => {
      await this.client?.leave();
      this.hidePanel();
      this.stopLoops();
      this.phase = "idle";
      this.client = null;
    });
    this.el.querySelector<HTMLButtonElement>("[data-start]")?.addEventListener("click", async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      b.disabled = true;
      const ok = await this.client!.start();
      if (!ok) b.disabled = false;
      // 開始検知はポーリング側（全員同じ経路）に任せる
    });
    this.startLoops();
    void this.poll();
  }

  private renderLobbyPlayers(players: Record<string, EventPlayer>): void {
    const box = this.el.querySelector<HTMLElement>("[data-players]");
    if (!box) return;
    const list = Object.entries(players);
    box.innerHTML = list
      .map(
        ([pid, p]) =>
          `<span class="ev-chip${pid === this.client?.pid ? " me" : ""}">${
            pid === this.meta?.host ? "👑 " : ""
          }${escapeHtml(p.name)}</span>`
      )
      .join("");
  }

  // ================= カウントダウン → 競技開始 ========================
  private startCountdown(meta: EventMeta): void {
    if (this.phase === "countdown") return;
    this.phase = "countdown";
    this.meta = meta;
    this.showPanel(`<div class="ev-go" data-go>3</div>`);
    const goEl = this.el.querySelector<HTMLElement>("[data-go]")!;
    let shown = 99;
    const iv = setInterval(() => {
      const remain = meta.startAt! + COUNTDOWN_MS - serverNow();
      const n = Math.ceil(remain / 1000);
      if (n > 0 && n !== shown) {
        shown = n;
        goEl.textContent = String(n);
        goEl.classList.remove("pop");
        void goEl.offsetWidth; // アニメ再発火
        goEl.classList.add("pop");
        this.deps.sfx.ui();
      }
      if (remain <= 0) {
        clearInterval(iv);
        goEl.textContent = "GO!";
        goEl.classList.add("go");
        this.deps.sfx.bonus();
        this.deps.burst(120);
        setTimeout(() => this.beginPlaying(meta), 700);
      }
    }, 80);
  }

  private beginPlaying(meta: EventMeta): void {
    if (this.phase === "playing" || this.phase === "ended") return;
    this.meta = meta;
    this.endAt = endAtOf(meta) ?? 0;
    this.spins = 0;
    this.finalized = false;
    this.brokeReported = false;
    this.deps.state.beginEvent(this.client!.code, this.client!.pid, meta.seed);
    this.deps.onEnter();
    this.phase = "playing";
    this.hidePanel();
    this.timerBar.classList.remove("hidden");
    this.startLoops();
  }

  // ================= ループ（タイマー / ポーリング） ==================
  private startLoops(): void {
    if (!this.tickIv) this.tickIv = window.setInterval(() => this.tick(), 250);
    if (!this.pollIv) this.pollIv = window.setInterval(() => void this.poll(), 2500);
  }
  private stopLoops(): void {
    clearInterval(this.tickIv);
    clearInterval(this.pollIv);
    this.tickIv = this.pollIv = 0;
  }

  private tick(): void {
    if (this.phase === "playing") {
      const rem = Math.max(0, this.endAt - serverNow());
      this.paintTimer(rem);
      this.checkBroke();
      if (rem <= 0) {
        this.phase = "ended";
        this.showTimeUp();
      }
    } else if (this.phase === "ended") {
      this.paintTimer(0);
      if (!this.finalized && !this.deps.isBusy() && !this.deps.state.inRush) {
        void this.finalize();
      }
    }
  }

  private paintTimer(rem: number): void {
    const clock = this.timerBar.querySelector<HTMLElement>("[data-clock]")!;
    const fill = this.timerBar.querySelector<HTMLElement>("[data-fill]")!;
    if (rem <= 0) {
      clock.textContent = "TIME UP";
      fill.style.width = "0%";
      this.timerBar.classList.add("up");
      return;
    }
    const sec = Math.ceil(rem / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    clock.textContent = `${mm}:${ss}`;
    const total = this.meta?.durationMs ?? 1;
    fill.style.width = `${Math.min(100, (rem / total) * 100)}%`;
    this.timerBar.classList.toggle("warn", rem <= 60_000);
    this.timerBar.classList.toggle("crit", rem <= 10_000);
    // ラスト10秒は毎秒ピッ
    if (rem <= 10_000 && sec !== this.lastBeepSec) {
      this.lastBeepSec = sec;
      this.deps.sfx.ui();
    }
  }

  private showTimeUp(): void {
    const o = document.createElement("div");
    o.className = "ev-timeup";
    o.innerHTML = `<div class="ev-timeup-inner">🏁 TIME UP!</div>`;
    document.body.appendChild(o);
    this.deps.sfx.winBig();
    setTimeout(() => o.remove(), 2200);
  }

  private async poll(): Promise<void> {
    if (!this.client) return;
    const snap = await this.client.snap();
    if (!snap) return;
    this.meta = snap.meta ?? this.meta;

    // ホストが中断したら全端末が離脱（ロビー含む）。
    if (snap.meta?.aborted) {
      this.gracefulExit("⏹ ホストが大会を中断しました");
      return;
    }

    if (this.phase === "lobby") {
      if (snap.players) this.renderLobbyPlayers(snap.players);
      if (snap.meta?.status === "running" && snap.meta.startAt) {
        // 開始直後（カウントダウン内）なら3,2,1演出。大幅に過ぎていたら即合流。
        if (serverNow() < snap.meta.startAt + COUNTDOWN_MS) this.startCountdown(snap.meta);
        else this.beginPlaying(snap.meta);
      }
      this.consumeFeed(snap, true);
      return;
    }
    if (this.phase === "playing" || this.phase === "ended") {
      await this.sendHeartbeat(false);
      this.consumeFeed(snap, false);
    }
  }

  private async sendHeartbeat(force: boolean): Promise<void> {
    if (!this.client) return;
    const credits = Math.floor(this.deps.state.credits);
    const changed = credits !== this.lastSent.credits || this.spins !== this.lastSent.spins;
    this.heartbeatSkip++;
    if (!force && !changed && this.heartbeatSkip < 4) return;
    this.heartbeatSkip = 0;
    this.lastSent = { credits, spins: this.spins };
    await this.client.report({ credits, spins: this.spins, st: this.playerStatus() });
  }

  private playerStatus(): EventPlayer["st"] {
    if (this.brokeReported) return "broke";
    if (this.deps.state.eventRevived) return "revived";
    return "alive";
  }

  // ---- 速報トースト ---------------------------------------------------
  private consumeFeed(snap: EventSnap, lobbyOnlyJoin: boolean): void {
    const feed = snap.feed;
    if (!feed) return;
    const items = Object.entries(feed).sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
    if (!this.feedPrimed) {
      // 参加/復帰直後は過去ログを再生しない
      items.forEach(([k]) => this.seenFeed.add(k));
      this.feedPrimed = true;
      return;
    }
    for (const [key, item] of items) {
      if (this.seenFeed.has(key)) continue;
      this.seenFeed.add(key);
      if (item.name === this.client?.name) continue; // 自分の速報は出さない
      if (lobbyOnlyJoin && item.t !== "join") continue;
      this.toast(FEED_TEXT[item.t]?.(item.name, item.amt) ?? "");
    }
  }

  private toast(text: string): void {
    if (!text) return;
    const t = document.createElement("div");
    t.className = "ev-toast";
    t.textContent = text;
    this.toastsEl.appendChild(t);
    // 溜まりすぎ防止
    while (this.toastsEl.children.length > 4) this.toastsEl.firstElementChild?.remove();
    setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => t.remove(), 400);
    }, 4200);
  }

  // ---- 破産・復活 ------------------------------------------------------
  private checkBroke(): void {
    const s = this.deps.state;
    if (this.deps.isBusy() || s.inRush) return;
    const broke = s.credits < 10; // 最小ベット(DROP 10 / 5リール 20)を張れない
    if (broke && !s.eventRevived) {
      this.rescueBtn.classList.remove("hidden");
    } else {
      this.rescueBtn.classList.add("hidden");
      if (broke && s.eventRevived && !this.brokeReported) {
        this.brokeReported = true;
        void this.client?.feed("broke");
        void this.sendHeartbeat(true);
      }
      if (!broke) this.brokeReported = false;
    }
  }

  private doRescue(): void {
    const s = this.deps.state;
    if (s.eventRevived || !this.active) return;
    s.reviveEvent(RESCUE_AMOUNT);
    this.rescueBtn.classList.add("hidden");
    this.deps.sfx.bonus();
    this.deps.burst(60);
    this.deps.refreshHud();
    void this.client?.feed("revive");
    void this.sendHeartbeat(true);
  }

  // ---- 確定 → 表彰式 ---------------------------------------------------
  private async finalize(): Promise<void> {
    if (this.finalized || !this.client) return;
    this.finalized = true;
    const final = Math.floor(this.deps.state.credits);
    await this.client.report({
      credits: final,
      spins: this.spins,
      st: this.playerStatus(),
      done: true,
    });
    void this.client.feed("final", final);
    // 遅れて確定する人（ラッシュ駆け込み）を待ってから発表
    const waitMs = Math.max(this.endAt + GRACE_MS - serverNow(), 1500);
    this.showPanel(`<div class="ev-panel ev-counting"><div class="ev-counting-spin">🏁</div>集計中…</div>`);
    this.phase = "ceremony";
    setTimeout(() => void this.showCeremony(), waitMs);
  }

  private async showCeremony(): Promise<void> {
    const snap = await this.client?.snap();
    const players = snap?.players ?? {};
    const standings = Object.entries(players)
      .map(([pid, p]) => ({ pid, ...p }))
      .sort((a, b) => b.credits - a.credits || (a.at ?? 0) - (b.at ?? 0));

    const badge = (p: EventPlayer) =>
      p.st === "broke" ? " 💀" : p.st === "revived" ? " ♻️" : "";
    const pod = (i: number) => {
      const p = standings[i];
      if (!p) return `<div class="ev-pod empty"></div>`;
      return `<div class="ev-pod pod${i + 1} veil" data-pod="${i}">
        <div class="ev-pod-rank">${["🥇", "🥈", "🥉"][i]}</div>
        <div class="ev-pod-name">${escapeHtml(p.name)}${badge(p)}</div>
        <div class="ev-pod-score">${p.credits.toLocaleString()}</div>
        <div class="ev-pod-veil">?</div>
      </div>`;
    };
    const rest = standings
      .slice(3)
      .map(
        (p, i) => `<li class="ev-final-row${p.pid === this.client?.pid ? " me" : ""}">
          <span>${i + 4}</span><span>${escapeHtml(p.name)}${badge(p)}</span>
          <b>${p.credits.toLocaleString()}</b></li>`
      )
      .join("");

    this.showPanel(`
      <div class="ev-panel ev-podium">
        <h2>🏁 けっか はっぴょう</h2>
        <div class="ev-podium-stage">${pod(1)}${pod(0)}${pod(2)}</div>
        ${rest ? `<ol class="ev-final-list">${rest}</ol>` : ""}
        <button class="btn primary hidden" data-end>おわる</button>
      </div>`);

    const reveal = (i: number) => {
      const el = this.el.querySelector<HTMLElement>(`[data-pod="${i}"]`);
      el?.classList.remove("veil");
      if (i === 0) {
        this.deps.sfx.winBig();
        this.deps.burst(160);
      } else {
        this.deps.sfx.reelStop();
      }
    };
    // 3位 → 2位 → （タメ）→ 1位
    setTimeout(() => reveal(2), 900);
    setTimeout(() => reveal(1), 1900);
    setTimeout(() => this.deps.sfx.reach(), 2700);
    setTimeout(() => reveal(0), 3600);
    setTimeout(() => {
      this.el.querySelector("[data-end]")?.classList.remove("hidden");
    }, 4400);
    this.el.querySelector("[data-end]")!.addEventListener("click", () => void this.exit());
  }

  private async exit(): Promise<void> {
    if (this.isHost) await this.client?.markDone();
    this.teardown();
  }

  /** 大会からの離脱に共通の後片付け（通常終了・中断・退出で共用）。 */
  private teardown(): void {
    EventClient.clearLocal();
    this.stopLoops();
    this.hidePanel();
    this.timerBar.classList.add("hidden");
    this.timerBar.classList.remove("up", "warn", "crit");
    this.rescueBtn.classList.add("hidden");
    this.phase = "idle";
    this.client = null;
    this.meta = null;
    this.seenFeed.clear();
    this.feedPrimed = false;
    this.deps.state.endEvent();
    this.deps.onExit();
  }

  // ---- 中断／退出 -----------------------------------------------------
  /** タイマーバーの ⏹ ボタン：ホスト＝全員中断 / 参加者＝自分だけ退出。 */
  private onQuitClicked(): void {
    if (this.phase !== "playing" && this.phase !== "ended") return;
    const host = this.isHost;
    const q = host
      ? { icon: "⏹ 中断", msg: "大会を 中断しますか？<br />みんなの プレイが 終わります", ok: "中断する", cls: "danger" }
      : { icon: "🚪 退出", msg: "大会から 退出しますか？<br />自分だけ 抜けます（大会は つづきます）", ok: "退出する", cls: "primary" };
    this.showPanel(`
      <div class="ev-panel ev-confirm">
        <h2 class="ev-title">${q.icon}</h2>
        <p class="ev-sub">${q.msg}</p>
        <div class="ev-actions">
          <button class="btn ${q.cls}" data-ok>${q.ok}</button>
          <button class="btn ghost" data-cancel>やめる</button>
        </div>
      </div>`);
    this.el.querySelector("[data-cancel]")!.addEventListener("click", () => this.hidePanel());
    this.el.querySelector("[data-ok]")!.addEventListener("click", () => void this.confirmQuit(host));
  }

  private async confirmQuit(host: boolean): Promise<void> {
    this.deps.sfx.ui();
    if (host) await this.client?.abort();
    else await this.client?.leave();
    const msg = host ? "⏹ 大会を中断しました" : "🚪 大会から退出しました";
    this.teardown();
    this.toast(msg);
  }

  /** 他端末（ホスト）の中断を検知したときの離脱。 */
  private gracefulExit(msg: string): void {
    if (this.phase === "idle") return;
    this.teardown();
    this.toast(msg);
  }

  // ---- パネル表示ユーティリティ ---------------------------------------
  private showPanel(html: string): void {
    this.el.innerHTML = html;
    this.el.classList.remove("hidden");
  }
  private hidePanel(): void {
    this.el.classList.add("hidden");
    this.el.innerHTML = "";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
