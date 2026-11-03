// ===== バグ報告フォーム ===============================================
// ヘッダーの「🐞 報告」から開くオーバーレイ。送信先は RTDB `bugreports/<id>`。
// GitHub Actions（.github/workflows/bugreports.yml）が定期的に取りに行き、
// GitHub Issue に変換する（クライアントに GitHub のトークンは持たせない）。
//
// 虚偽報告／いたずら対策（第1段階）:
//  - 自由記述に加え、バージョン・画面状態・直近のJSエラーを「自動で」添付する。
//    後段のトリアージは自由記述より自動データを重く見る。
//  - RTDB ルールで「書き込み専用・作成のみ・文字数上限・1端末60秒に1件」を強制。
//    （docs/rtdb-rules.json の bugreports / bugreport_rl）
//  - プレイヤー名など個人情報は送らない。
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import type { Sfx } from "../audio/sfx";
import { evPatch, SV_TIME } from "../event/api";
import { getItem, setItem } from "../game/storage";
import { BOOT_AT, recentErrors } from "../diag";

export type BugCategory = "freeze" | "display" | "medal" | "sound" | "other";

const CATEGORIES: { id: BugCategory; label: string }[] = [
  { id: "freeze", label: "うごかない・とまった" },
  { id: "display", label: "がめんが へん" },
  { id: "medal", label: "メダルが へん" },
  { id: "sound", label: "おとが へん" },
  { id: "other", label: "そのほか" },
];

/** RTDB ルールと揃えること（docs/rtdb-rules.json） */
export const TEXT_MIN = 5;
export const TEXT_MAX = 1000;
export const STEPS_MAX = 500;
const CTX_MAX = 4000;
const ERRS_MAX = 6000;
/** 1端末あたりの送信間隔（ルールは 60 秒。時計ずれを見てクライアントは少し長め） */
const COOLDOWN_MS = 65_000;

const DEVICE_KEY = "triple-slot.device";
const LAST_SENT_KEY = "triple-slot.bugreport.last";

/** 報告時点のゲーム状態（main.ts から渡す。個人情報は入れない） */
export interface GameSnapshot {
  mode: string;
  credits: number;
  bet: number;
  inRush: boolean;
  inEvent: boolean;
  busy: boolean;
  autoPlay: boolean;
}

/** RTDB に書く1件ぶん（ルールの hasChildren と一致させる） */
export interface BugReportDoc {
  v: 1;
  cat: BugCategory;
  text: string;
  steps: string;
  device: string;
  at: typeof SV_TIME;
  /** JSON 文字列（端末・バージョン・ゲーム状態） */
  ctx: string;
  /** JSON 文字列（直近のJSエラー） */
  errs: string;
}

function randomId(len: number): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  const buf = new Uint8Array(len);
  try {
    crypto.getRandomValues(buf);
  } catch {
    for (let i = 0; i < len; i++) buf[i] = (Math.random() * 256) | 0;
  }
  return Array.from(buf, (b) => abc[b % abc.length]).join("");
}

/** 端末ごとの匿名ID（レート制限と重複集計用。個人とは結びつかない乱数） */
function deviceId(): string {
  const cur = getItem(DEVICE_KEY);
  if (cur && /^[a-z0-9]{8,24}$/.test(cur)) return cur;
  const id = randomId(16);
  setItem(DEVICE_KEY, id);
  return id;
}

/** RTDB のキー。時刻順に並ぶよう先頭を時刻(36進)にする。 */
function reportId(): string {
  return Date.now().toString(36) + randomId(8);
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** JSON 化して上限に収める（収まらなければ配列の古い方から削る） */
function fitJson(value: unknown, max: number): string {
  let json = JSON.stringify(value);
  if (json.length <= max) return json;
  if (Array.isArray(value)) {
    const arr = [...value];
    while (arr.length > 0 && json.length > max) {
      arr.shift();
      json = JSON.stringify(arr);
    }
    return json.length <= max ? json : "[]";
  }
  return clip(json, max);
}

async function collectContext(game: GameSnapshot): Promise<Record<string, unknown>> {
  const platform = Capacitor.getPlatform();
  let native: { version: string; build: string } | null = null;
  if (platform === "ios" || platform === "android") {
    try {
      const info = await App.getInfo();
      native = { version: info.version, build: info.build };
    } catch {
      /* 取れなくても続行 */
    }
  }
  return {
    app: __APP_VERSION__,
    sha: __BUILD_SHA__,
    platform,
    native,
    page: location.pathname.split("/").pop() || "index.html",
    standalone: window.matchMedia?.("(display-mode: standalone)").matches === true,
    ua: clip(navigator.userAgent, 300),
    lang: navigator.language,
    screen: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
    online: navigator.onLine,
    uptimeSec: Math.round((Date.now() - BOOT_AT) / 1000),
    game,
  };
}

/** 送信本体。成功で true（オフライン・ルール拒否などは false）。 */
export async function submitBugReport(
  cat: BugCategory,
  text: string,
  steps: string,
  game: GameSnapshot
): Promise<boolean> {
  const device = deviceId();
  const doc: BugReportDoc = {
    v: 1,
    cat,
    text: clip(text.trim(), TEXT_MAX),
    steps: clip(steps.trim(), STEPS_MAX),
    device,
    at: SV_TIME,
    ctx: fitJson(await collectContext(game), CTX_MAX),
    errs: fitJson(recentErrors(), ERRS_MAX),
  };
  // 報告本体とレート制限の印を「1回の書き込み」で入れる（ルール側で両方そろって
  // いることを確認する＝60秒以内の連投はサーバーが拒否する）。
  const res = await evPatch<unknown>("", {
    [`bugreports/${reportId()}`]: doc,
    [`bugreport_rl/${device}`]: { at: SV_TIME },
  });
  return res !== null;
}

function cooldownLeftSec(): number {
  const last = Number(getItem(LAST_SENT_KEY));
  if (!Number.isFinite(last) || last <= 0) return 0;
  return Math.max(0, Math.ceil((last + COOLDOWN_MS - Date.now()) / 1000));
}

// ---- UI -----------------------------------------------------------------
export class BugReportUI {
  readonly el: HTMLElement;
  private cat: BugCategory | null = null;
  private sending = false;

  constructor(
    private sfx: Sfx,
    private snapshot: () => GameSnapshot
  ) {
    this.el = document.createElement("div");
    this.el.className = "ev-overlay bug-overlay hidden";
    this.el.addEventListener("click", (e) => {
      if (e.target === this.el) this.close();
    });
  }

  open(): void {
    this.sfx.resume();
    this.sfx.ui();
    this.cat = null;
    this.renderForm();
    this.el.classList.remove("hidden");
    this.el.scrollTop = 0;
  }

  close(): void {
    this.el.classList.add("hidden");
  }

  private renderForm(): void {
    const chips = CATEGORIES.map(
      (c) => `<button type="button" class="ev-dur bug-cat" data-cat="${c.id}">${c.label}</button>`
    ).join("");
    this.el.innerHTML = `
      <div class="ev-panel bug-panel">
        <h2>🐞 バグを おしえて</h2>
        <p class="ev-sub">おかしな ところが あったら おしえてね。<br>
          <b>「あたりが すくない」は バグじゃないよ</b>（かくりつは きまってるよ）</p>
        <div class="bug-label">どんな こと？</div>
        <div class="ev-durs bug-cats">${chips}</div>
        <div class="bug-label">なにが おきた？ <span class="bug-req">ひっす</span></div>
        <textarea class="ev-input bug-text" data-text rows="4" maxlength="${TEXT_MAX}"
          placeholder="れい：ラッシュの とちゅうで がめんが とまった"></textarea>
        <div class="bug-label">そのまえに なにを してた？</div>
        <textarea class="ev-input bug-text small" data-steps rows="2" maxlength="${STEPS_MAX}"
          placeholder="れい：5リールで オートを まわしてた"></textarea>
        <p class="bug-fine">バージョン・がめんの じょうたい・エラーの きろくが いっしょに おくられます（なまえは おくりません）。<br>
          ほうこくは だれでも みられる ばしょに のるので、<b>なまえや じゅうしょは かかないでね</b>。</p>
        <p class="ev-note" data-note></p>
        <div class="ev-actions">
          <button class="btn ghost" data-close>やめる</button>
          <button class="btn primary" data-send disabled>おくる</button>
        </div>
      </div>`;

    const text = this.el.querySelector("[data-text]") as HTMLTextAreaElement;
    const steps = this.el.querySelector("[data-steps]") as HTMLTextAreaElement;
    const send = this.el.querySelector("[data-send]") as HTMLButtonElement;
    const refresh = (): void => {
      send.disabled = this.sending || !this.cat || text.value.trim().length < TEXT_MIN;
    };

    this.el.querySelectorAll<HTMLButtonElement>("[data-cat]").forEach((b) =>
      b.addEventListener("click", () => {
        this.sfx.ui();
        this.cat = b.dataset.cat as BugCategory;
        this.el
          .querySelectorAll("[data-cat]")
          .forEach((x) => x.classList.toggle("active", x === b));
        refresh();
      })
    );
    text.addEventListener("input", refresh);
    this.el.querySelector("[data-close]")!.addEventListener("click", () => {
      this.sfx.ui();
      this.close();
    });
    send.addEventListener("click", () => void this.send(text.value, steps.value));
  }

  private note(msg: string): void {
    (this.el.querySelector("[data-note]") as HTMLElement).textContent = msg;
  }

  private async send(text: string, steps: string): Promise<void> {
    if (this.sending || !this.cat) return;
    const wait = cooldownLeftSec();
    if (wait > 0) {
      this.sfx.deny();
      this.note(`つづけて おくれないよ。あと ${wait}びょう まってね`);
      return;
    }
    this.sending = true;
    const btn = this.el.querySelector("[data-send]") as HTMLButtonElement;
    btn.disabled = true;
    this.note("おくっています…");
    const ok = await submitBugReport(this.cat, text, steps, this.snapshot());
    this.sending = false;
    if (!ok) {
      btn.disabled = false;
      this.sfx.deny();
      this.note("おくれなかった… インターネットに つながってるか みて、すこし まってから もういちど");
      return;
    }
    setItem(LAST_SENT_KEY, String(Date.now()));
    this.sfx.bonus();
    this.renderThanks();
  }

  private renderThanks(): void {
    this.el.innerHTML = `
      <div class="ev-panel bug-panel">
        <h2>ありがとう！</h2>
        <p class="ev-sub">ほうこくを うけとったよ。しらべて なおすね。</p>
        <div class="ev-actions"><button class="btn primary" data-close>とじる</button></div>
      </div>`;
    this.el.querySelector("[data-close]")!.addEventListener("click", () => {
      this.sfx.ui();
      this.close();
    });
  }
}
