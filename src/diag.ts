// ===== 診断ログ（バグ報告に自動で添付する客観データ） =================
// 起動直後（boot.ts）に installDiag() を呼び、JS の例外と未処理 Promise を
// リングバッファに溜めておく。バグ報告フォームはこれをそのまま添付する。
//
// 方針:
//  - 自由記述より「自動で拾えた事実」の方が信頼できる（虚偽報告対策の土台）。
//  - 個人情報は持たない（プレイヤー名・入力文字は記録しない）。
//  - 何があってもゲームを止めない（ここで throw しない）。

export interface DiagError {
  /** epoch ms */
  at: number;
  kind: "error" | "rejection";
  msg: string;
  /** "file.js:12:34" 程度（無ければ空） */
  src: string;
  /** スタック先頭数行 */
  stack: string;
}

const MAX_ERRORS = 10;
const errors: DiagError[] = [];
let installed = false;

/** 起動時間（セッション長の目安として報告に載せる） */
export const BOOT_AT = Date.now();

function clip(s: unknown, n: number): string {
  const str = typeof s === "string" ? s : String(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function pushError(e: DiagError): void {
  // 同じエラーの連打（毎フレーム例外など）でバッファが埋まらないよう直前と同一なら捨てる
  const last = errors[errors.length - 1];
  if (last && last.msg === e.msg && last.src === e.src) return;
  errors.push(e);
  if (errors.length > MAX_ERRORS) errors.shift();
}

function stackOf(x: unknown): string {
  const s = (x as { stack?: unknown } | null)?.stack;
  return typeof s === "string" ? clip(s.split("\n").slice(0, 6).join("\n"), 600) : "";
}

export function installDiag(): void {
  if (installed) return;
  installed = true;
  try {
    window.addEventListener("error", (ev) => {
      // 画像等のリソース読み込み失敗（ev.error なし & target が要素）は除外
      if (!(ev instanceof ErrorEvent)) return;
      pushError({
        at: Date.now(),
        kind: "error",
        msg: clip(ev.message, 300),
        src: ev.filename ? clip(`${ev.filename}:${ev.lineno}:${ev.colno}`, 200) : "",
        stack: stackOf(ev.error),
      });
    });
    window.addEventListener("unhandledrejection", (ev) => {
      const r = ev.reason as unknown;
      const msg = r instanceof Error ? r.message : (r as string);
      pushError({
        at: Date.now(),
        kind: "rejection",
        msg: clip(msg, 300),
        src: "",
        stack: stackOf(r),
      });
    });
  } catch {
    /* 計測できなくても続行 */
  }
}

/** これまでに拾えたエラー（古い順・コピー） */
export function recentErrors(): DiagError[] {
  return errors.map((e) => ({ ...e }));
}
