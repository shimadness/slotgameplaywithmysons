// ===== 大会 観戦モニター（プロジェクター用の大画面ビュー） ============
// watch.html?e=CODE で開く。1.5秒ポーリングで
// 「巨大タイマー ＋ ライブ順位（バー） ＋ 速報テロップ」を描画する。
import { serverNow } from "../event/api";
import {
  EventClient,
  GRACE_MS,
  endAtOf,
  remainingMs,
  sanitizeCode,
  type EventPlayer,
  type EventSnap,
  type FeedItem,
} from "../event/client";

const ROW_H = 64; // 順位1行の高さ(px) — CSSの .sp-row と一致させる

const FEED_TEXT: Record<FeedItem["t"], (name: string, amt?: number) => string> = {
  join: (n) => `🙌 ${n} 参戦！`,
  rush: (n) => `🔥 ${n} セブンラッシュ突入！`,
  tengu: (n) => `👺 ${n} 天狗フリー突入！`,
  bigwin: (n, a) => `💰 ${n} +${(a ?? 0).toLocaleString()}`,
  broke: (n) => `💀 ${n} 破産…`,
  revive: (n) => `♻️ ${n} 復活！`,
  final: (n, a) => `🏁 ${n} 確定 ${(a ?? 0).toLocaleString()}`,
};

export function renderSpectator(root: HTMLElement): void {
  const code = sanitizeCode(new URLSearchParams(location.search).get("e") ?? "");
  if (!code) {
    renderCodeEntry(root);
    return;
  }
  new Spectator(root, code).start();
}

function renderCodeEntry(root: HTMLElement): void {
  root.innerHTML = `
    <div class="sp-entry">
      <h1>📺 メダル王決定戦 モニター</h1>
      <input class="sp-entry-input" maxlength="8" placeholder="あいことば" autocapitalize="characters" />
      <button class="sp-entry-btn">ひらく</button>
    </div>`;
  const input = root.querySelector<HTMLInputElement>(".sp-entry-input")!;
  const go = () => {
    const c = sanitizeCode(input.value);
    if (c) location.search = `?e=${c}`;
  };
  input.addEventListener("input", () => (input.value = sanitizeCode(input.value)));
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  root.querySelector(".sp-entry-btn")!.addEventListener("click", go);
  input.focus();
}

type SpPhase = "connect" | "lobby" | "running" | "counting" | "podium" | "aborted";

interface Standing extends EventPlayer {
  pid: string;
}

class Spectator {
  private client: EventClient;
  private snapCache: EventSnap | null = null;
  private phase: SpPhase = "connect";
  private rows = new Map<string, HTMLElement>();
  private seenFeed = new Set<string>();
  private feedPrimed = false;
  private podiumShown = false;
  private podiumRevealDone = false; // 3→2→1のリベール演出が完了したか
  private podiumSig = ""; // 表彰式に描いた順位の署名（遅れて確定した値で再描画するため）
  private confetti: Confetti | null = null;

  // DOM
  private clockEl!: HTMLElement;
  private boardEl!: HTMLElement;
  private tickerEl!: HTMLElement;
  private stageEl!: HTMLElement;

  constructor(private root: HTMLElement, private code: string) {
    this.client = new EventClient(code, "watch", "観戦");
  }

  start(): void {
    this.root.innerHTML = `
      <div class="sp">
        <header class="sp-head">
          <div class="sp-title">👑 メダル王決定戦</div>
          <div class="sp-code">🎪 ${this.code}</div>
        </header>
        <div class="sp-clock" data-clock>--:--</div>
        <div class="sp-stage" data-stage></div>
        <div class="sp-ticker" data-ticker></div>
      </div>`;
    this.clockEl = this.root.querySelector("[data-clock]")!;
    this.stageEl = this.root.querySelector("[data-stage]")!;
    this.tickerEl = this.root.querySelector("[data-ticker]")!;
    this.boardEl = document.createElement("div");
    this.boardEl.className = "sp-rows";

    void this.poll();
    setInterval(() => void this.poll(), 1500);
    setInterval(() => this.tickClock(), 250);
  }

  private standings(): Standing[] {
    const players = this.snapCache?.players ?? {};
    return Object.entries(players)
      .map(([pid, p]) => ({ pid, ...p }))
      .sort((a, b) => b.credits - a.credits || (a.at ?? 0) - (b.at ?? 0));
  }

  private async poll(): Promise<void> {
    const snap = await this.client.snap();
    if (!snap?.meta) {
      if (this.phase === "connect") {
        this.stageEl.innerHTML = `<div class="sp-wait">あいことば「${this.code}」の大会は まだ ありません…</div>`;
      }
      return;
    }
    this.snapCache = snap;
    const meta = snap.meta;

    // ホストが中断したら専用表示（表彰式にはしない）。
    if (meta.aborted) {
      if (this.phase !== "aborted") {
        this.phase = "aborted";
        this.clockEl.textContent = "";
        this.clockEl.className = "sp-clock";
        this.stageEl.innerHTML = `<div class="sp-wait">⏹ 大会は中断されました</div>`;
      }
      return;
    }

    // フェーズ決定
    let next: SpPhase;
    if (meta.status === "lobby") next = "lobby";
    else if (meta.status === "done") next = "podium";
    else {
      const rem = remainingMs(meta);
      if (rem > 0) next = "running";
      else {
        const endAt = endAtOf(meta) ?? 0;
        const allDone =
          Object.values(snap.players ?? {}).length > 0 &&
          Object.values(snap.players ?? {}).every((p) => p.done);
        next = allDone || serverNow() > endAt + GRACE_MS + 4000 ? "podium" : "counting";
      }
    }
    if (next !== this.phase) this.enterPhase(next);
    this.paintPhase();
    this.consumeFeed(snap);
  }

  private enterPhase(p: SpPhase): void {
    this.phase = p;
    this.stageEl.innerHTML = "";
    this.rows.clear();
    if (p === "running" || p === "counting") {
      this.stageEl.appendChild(this.boardEl);
      if (p === "counting") {
        const o = document.createElement("div");
        o.className = "sp-counting";
        o.textContent = "🏁 集計中…";
        this.stageEl.appendChild(o);
      }
    }
    if (p === "podium" && !this.podiumShown) {
      this.podiumShown = true;
      this.renderPodium();
    } else if (p === "podium") {
      this.renderPodium(true);
    }
  }

  private paintPhase(): void {
    if (this.phase === "lobby") {
      const names = this.standings()
        .map((s) => `<span class="sp-chip">${esc(s.name)}</span>`)
        .join("");
      this.stageEl.innerHTML = `
        <div class="sp-lobby">
          <div class="sp-lobby-code">${this.code}</div>
          <div class="sp-lobby-sub">エントリー受付中 — ゲームの 🎪 から参加</div>
          <div class="sp-chips">${names || "<span class='sp-chip dim'>まだ だれも いない…</span>"}</div>
        </div>`;
    } else if (this.phase === "running" || this.phase === "counting") {
      this.paintBoard();
    } else if (this.phase === "podium") {
      // リベール演出後に、遅れて確定した値（時間切れ後のラッシュ＋ダブルアップ等）が
      // 届いたら順位を静かに描き直す。演出中は触らない（署名が変わっても待つ）。
      if (this.podiumRevealDone && this.standingsSig() !== this.podiumSig) {
        this.renderPodium(true);
      }
    }
  }

  /** 順位の署名（pid:credits:done を連結）。変化検知用。 */
  private standingsSig(): string {
    return this.standings()
      .map((s) => `${s.pid}:${s.credits}:${s.done ? 1 : 0}`)
      .join(",");
  }

  // ---- ライブ順位（バー＋FLIPアニメ） ---------------------------------
  private paintBoard(): void {
    const list = this.standings();
    const leader = Math.max(1, ...list.map((s) => s.credits));
    this.boardEl.style.height = `${list.length * ROW_H}px`;
    const alive = new Set<string>();
    list.forEach((s, rank) => {
      alive.add(s.pid);
      let row = this.rows.get(s.pid);
      if (!row) {
        row = document.createElement("div");
        row.className = "sp-row";
        row.innerHTML = `
          <span class="sp-pos" data-pos></span>
          <span class="sp-name" data-name></span>
          <div class="sp-bar"><div class="sp-bar-fill" data-bar></div></div>
          <b class="sp-score" data-score></b>`;
        this.boardEl.appendChild(row);
        this.rows.set(s.pid, row);
      }
      row.style.transform = `translateY(${rank * ROW_H}px)`;
      row.classList.toggle("first", rank === 0);
      row.classList.toggle("broke", s.st === "broke");
      const badge = s.st === "broke" ? " 💀" : s.st === "revived" ? " ♻️" : "";
      const crown = rank === 0 ? "👑" : ["🥈", "🥉"][rank - 1] ?? String(rank + 1);
      row.querySelector("[data-pos]")!.textContent = crown;
      row.querySelector("[data-name]")!.textContent = s.name + badge + (s.done ? " 🏁" : "");
      row.querySelector<HTMLElement>("[data-bar]")!.style.width =
        `${Math.max(2, (s.credits / leader) * 100)}%`;
      row.querySelector("[data-score]")!.textContent = s.credits.toLocaleString();
    });
    // 消えた参加者（退出）を除去
    for (const [pid, el] of this.rows) {
      if (!alive.has(pid)) {
        el.remove();
        this.rows.delete(pid);
      }
    }
  }

  // ---- タイマー --------------------------------------------------------
  private tickClock(): void {
    const meta = this.snapCache?.meta;
    if (!meta || this.phase === "lobby" || this.phase === "podium" || this.phase === "aborted") {
      this.clockEl.textContent = this.phase === "lobby" ? "READY" : "";
      this.clockEl.className = "sp-clock";
      return;
    }
    const rem = Math.max(0, remainingMs(meta));
    if (rem <= 0) {
      this.clockEl.textContent = "TIME UP";
      this.clockEl.className = "sp-clock up";
      return;
    }
    const sec = Math.ceil(rem / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    this.clockEl.textContent = `${mm}:${ss}`;
    this.clockEl.className =
      "sp-clock" + (rem <= 10_000 ? " crit" : rem <= 60_000 ? " warn" : "");
  }

  // ---- 速報テロップ ----------------------------------------------------
  private consumeFeed(snap: EventSnap): void {
    const feed = snap.feed;
    if (!feed) return;
    const items = Object.entries(feed).sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
    if (!this.feedPrimed) {
      items.forEach(([k]) => this.seenFeed.add(k));
      this.feedPrimed = true;
      return;
    }
    for (const [key, item] of items) {
      if (this.seenFeed.has(key)) continue;
      this.seenFeed.add(key);
      const el = document.createElement("span");
      el.className = "sp-feed-item";
      el.textContent = FEED_TEXT[item.t]?.(item.name, item.amt) ?? "";
      this.tickerEl.prepend(el);
      while (this.tickerEl.children.length > 8) this.tickerEl.lastElementChild?.remove();
    }
  }

  // ---- 表彰式 ----------------------------------------------------------
  private renderPodium(instant = false): void {
    const list = this.standings();
    const badge = (p: EventPlayer) =>
      p.st === "broke" ? " 💀" : p.st === "revived" ? " ♻️" : "";
    const pod = (i: number) => {
      const p = list[i];
      if (!p) return `<div class="sp-pod empty"></div>`;
      return `<div class="sp-pod pod${i + 1}${instant ? "" : " veil"}" data-pod="${i}">
        <div class="sp-pod-rank">${["🥇", "🥈", "🥉"][i]}</div>
        <div class="sp-pod-name">${esc(p.name)}${badge(p)}</div>
        <div class="sp-pod-score">${p.credits.toLocaleString()}</div>
        <div class="sp-pod-veil">?</div>
      </div>`;
    };
    const rest = list
      .slice(3)
      .map(
        (p, i) =>
          `<li><span>${i + 4}</span><span>${esc(p.name)}${badge(p)}</span><b>${p.credits.toLocaleString()}</b></li>`
      )
      .join("");
    this.stageEl.innerHTML = `
      <div class="sp-podium">
        <div class="sp-podium-stage">${pod(1)}${pod(0)}${pod(2)}</div>
        ${rest ? `<ol class="sp-final-list">${rest}</ol>` : ""}
      </div>`;
    this.podiumSig = this.standingsSig(); // いま描いた内容を記録
    if (instant) {
      this.podiumRevealDone = true;
      return;
    }
    const reveal = (i: number) =>
      this.stageEl.querySelector(`[data-pod="${i}"]`)?.classList.remove("veil");
    setTimeout(() => reveal(2), 1000);
    setTimeout(() => reveal(1), 2200);
    setTimeout(() => {
      reveal(0);
      this.confetti ??= new Confetti();
      this.confetti.burst(240);
      this.podiumRevealDone = true; // 以後は遅れて届いた確定値で再描画可
    }, 3800);
  }
}

// ---- お祝い紙吹雪（観戦ページ専用の軽量版） ---------------------------
class Confetti {
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private ps: { x: number; y: number; vx: number; vy: number; life: number; size: number; color: string; rot: number; vr: number }[] = [];
  private raf = 0;

  constructor() {
    this.canvas.className = "sp-confetti";
    document.body.appendChild(this.canvas);
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }
  private resize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }
  burst(count: number): void {
    const w = this.canvas.width;
    const colors = ["#ffe14a", "#ff5c7a", "#4fc3ff", "#3ddc84", "#b06bff", "#fff"];
    for (let i = 0; i < count; i++) {
      this.ps.push({
        x: w * (0.2 + Math.random() * 0.6),
        y: this.canvas.height * 0.3,
        vx: (Math.random() - 0.5) * 10,
        vy: -Math.random() * 10 - 4,
        life: 1,
        size: 5 + Math.random() * 7,
        color: colors[(Math.random() * colors.length) | 0],
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
      });
    }
    if (!this.raf) this.loop();
  }
  private loop(): void {
    const step = () => {
      const { ctx, canvas } = this;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      this.ps = this.ps.filter((p) => p.life > 0);
      for (const p of this.ps) {
        p.vy += 0.25;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.life -= 0.008;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      if (this.ps.length > 0) this.raf = requestAnimationFrame(step);
      else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        this.raf = 0;
      }
    };
    this.raf = requestAnimationFrame(step);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
