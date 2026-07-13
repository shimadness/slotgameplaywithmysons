// ===== 大会（15分タイムアタック）クライアント ==========================
// RTDB 構造:
//   events/<CODE>/meta    { status, createdAt, startAt?, durationMs, seed, host }
//   events/<CODE>/players/<pid> { name, credits, spins, st, done?, at }
//   events/<CODE>/feed/<pushId> { t, name, amt?, at }
// あいことば(CODE)が同じ端末どうしが同じ大会に入る。作った人がホスト。
import { evDelete, evGet, evPatch, evPost, serverNow, SV_TIME } from "./api";

export type EventStatus = "lobby" | "running" | "done";

export interface EventMeta {
  status: EventStatus;
  createdAt: number;
  /** ホストがスタートを押したサーバー時刻。カウントダウン3秒後に競技開始。 */
  startAt?: number;
  durationMs: number;
  /** 全員共通の初期メダル */
  seed: number;
  host: string;
  /** ホストが途中で中断したら true（全クライアントが検知して離脱）。 */
  aborted?: boolean;
}

export interface EventPlayer {
  name: string;
  credits: number;
  spins: number;
  /** alive=通常 / revived=復活済み / broke=破産 */
  st: "alive" | "revived" | "broke";
  done?: boolean;
  at?: number;
}

export type FeedType = "join" | "rush" | "tengu" | "bigwin" | "broke" | "revive" | "final";
export interface FeedItem {
  t: FeedType;
  name: string;
  amt?: number;
  at: number;
}

export interface EventSnap {
  meta?: EventMeta;
  players?: Record<string, EventPlayer>;
  feed?: Record<string, FeedItem>;
}

/** スタート合図から競技開始までのカウントダウン（全端末共通） */
export const COUNTDOWN_MS = 3000;
/** タイムアップ後、遅れて確定する人（ラッシュ消化中など）を待つ猶予 */
export const GRACE_MS = 8000;

export const EV_LOCAL_KEY = "triple-slot.event";

export interface EventLocal {
  code: string;
  pid: string;
  name: string;
}

export function sanitizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

/**
 * 「もう終わったも同然」の大会か（＝あいことばを作り直してよい）。
 * 終了後10分過ぎた running / 24時間放置の lobby は再利用可能とみなす。
 */
export function isStaleMeta(meta: EventMeta): boolean {
  const now = serverNow();
  return (
    (meta.status === "running" &&
      !!meta.startAt &&
      now > meta.startAt + COUNTDOWN_MS + meta.durationMs + 10 * 60_000) ||
    (meta.status === "lobby" && now - (meta.createdAt ?? 0) > 24 * 60 * 60_000)
  );
}

export function randomCode(): string {
  // 紛らわしい文字（0/O, 1/I）を除いた4文字
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[(Math.random() * chars.length) | 0];
  return s;
}

export class EventClient {
  constructor(
    readonly code: string,
    readonly pid: string,
    public name: string
  ) {}

  // --- ローカル保存（リロード復帰用） ---------------------------------
  static local(): EventLocal | null {
    try {
      const raw = localStorage.getItem(EV_LOCAL_KEY);
      const v = raw ? (JSON.parse(raw) as EventLocal) : null;
      return v && v.code && v.pid ? v : null;
    } catch {
      return null;
    }
  }
  saveLocal(): void {
    try {
      localStorage.setItem(
        EV_LOCAL_KEY,
        JSON.stringify({ code: this.code, pid: this.pid, name: this.name })
      );
    } catch { /* ignore */ }
  }
  static clearLocal(): void {
    try {
      localStorage.removeItem(EV_LOCAL_KEY);
    } catch { /* ignore */ }
  }

  private path(sub = ""): string {
    return `events/${this.code}${sub}`;
  }

  // --- 参加/作成 -------------------------------------------------------
  /**
   * あいことばの大会が生きていれば参加、無ければ新規作成（＝自分がホスト）。
   * 終了済み(done)の大会コードは上書きして作り直す＝コードを使い回せる。
   */
  async createOrJoin(opts: {
    durationMs: number;
    seed: number;
  }): Promise<{ ok: boolean; isHost: boolean; meta: EventMeta | null }> {
    const meta = await evGet<EventMeta>(this.path("/meta"));
    const live = !!meta && meta.status !== "done" && !isStaleMeta(meta);
    if (live && meta) {
      // 既存の生きた大会に参加。制限時間・初期メダルは**この大会のもの**を採用
      // （参加者が別の時間を選んでも、あいことばが同じなら同じ大会に入る）。
      const joined = await evPatch<EventPlayer>(this.path(`/players/${this.pid}`), {
        name: this.name,
        credits: meta.seed,
        spins: 0,
        st: "alive",
        at: SV_TIME,
      });
      if (joined === null) return { ok: false, isHost: false, meta: null };
      void this.feed("join");
      return { ok: true, isHost: meta.host === this.pid, meta };
    }

    // ここに来る＝大会が無い / done / stale → 新規作成（または作り直し）。
    // done/stale の作り直しは古い参加者・フィードを掃除（新規なら no-op）。
    if (meta) {
      await evDelete(this.path("/players"));
      await evDelete(this.path("/feed"));
    }
    // meta を立てる。**ノード全体の PUT はしない**（＝ほぼ同時に別の人が作っても
    // 相手の参加枠を消さない）。host は last-writer になるが直後の read で収束させる。
    // startAt は必ずクリア（done の作り直しで古い開始時刻が残らないように）。
    const mres = await evPatch(this.path("/meta"), {
      status: "lobby",
      createdAt: SV_TIME,
      startAt: null,
      aborted: null, // 前回の中断フラグを必ずクリア（残ると新規大会が即離脱する）
      durationMs: opts.durationMs,
      seed: opts.seed,
      host: this.pid,
    });
    if (mres === null) return { ok: false, isHost: false, meta: null };
    // 自分の参加枠だけを書く（他人の枠は触らない）。
    await evPatch<EventPlayer>(this.path(`/players/${this.pid}`), {
      name: this.name,
      credits: opts.seed,
      spins: 0,
      st: "alive",
      at: SV_TIME,
    });
    // レース確認: 実際に host になったのは誰かを読み直す。
    const after = await evGet<EventMeta>(this.path("/meta"));
    if (after === null) return { ok: false, isHost: false, meta: null };
    const isHost = after.host === this.pid;
    // 同時作成で相手が host になり初期メダルが違うなら、相手の値に合わせ直す（公平性）。
    if (!isHost && after.seed !== opts.seed) {
      await evPatch(this.path(`/players/${this.pid}`), { credits: after.seed });
    }
    void this.feed("join");
    return { ok: true, isHost, meta: after };
  }

  /**
   * UI用: そのあいことばに「生きた大会」があれば meta を返す（無ければ null）。
   * 参加モーダルで「新規作成か・既存参加か」を先読みして表示を切り替えるのに使う。
   */
  static async peekLive(code: string): Promise<EventMeta | null> {
    const meta = await evGet<EventMeta>(`events/${code}/meta`);
    if (!meta || meta.status === "done" || isStaleMeta(meta)) return null;
    return meta;
  }

  /** ホスト: 大会スタート（サーバー時刻が起点になる） */
  async start(): Promise<boolean> {
    const r = await evPatch(this.path("/meta"), { status: "running", startAt: SV_TIME });
    return r !== null;
  }

  /** ホスト: 大会を閉じる（コード再利用可能に） */
  async markDone(): Promise<void> {
    await evPatch(this.path("/meta"), { status: "done" });
  }

  /** ホスト: 大会を途中で中断（全員離脱＋コード即再利用可）。 */
  async abort(): Promise<void> {
    await evPatch(this.path("/meta"), { status: "done", aborted: true });
  }

  /** ロビーから退出（参加を取り消す） */
  async leave(): Promise<void> {
    await evDelete(this.path(`/players/${this.pid}`));
    EventClient.clearLocal();
  }

  // --- 進行中 ----------------------------------------------------------
  async snap(): Promise<EventSnap | null> {
    return evGet<EventSnap>(this.path());
  }

  /** 自分の現況を送信（ライブリーダーボードの元データ） */
  async report(p: Partial<EventPlayer>): Promise<void> {
    await evPatch(this.path(`/players/${this.pid}`), { ...p, at: SV_TIME });
  }

  /** 速報フィード（観戦画面・他プレイヤーのトーストに流れる） */
  async feed(t: FeedType, amt?: number): Promise<void> {
    const item: Record<string, unknown> = { t, name: this.name, at: SV_TIME };
    if (typeof amt === "number") item.amt = Math.floor(amt);
    await evPost(this.path("/feed"), item);
  }
}

/** 競技の残り時間(ms)。開始前は満タン、負なら終了。 */
export function remainingMs(meta: EventMeta): number {
  if (!meta.startAt) return meta.durationMs;
  return meta.startAt + COUNTDOWN_MS + meta.durationMs - serverNow();
}

/** 競技終了のサーバー時刻。startAt 未設定なら null。 */
export function endAtOf(meta: EventMeta): number | null {
  return meta.startAt ? meta.startAt + COUNTDOWN_MS + meta.durationMs : null;
}
