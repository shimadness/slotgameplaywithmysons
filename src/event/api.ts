// ===== 大会モード用 RTDB RESTクライアント =============================
// Firebase SDK ではなく素の fetch(REST) を使う。理由:
//  - WebSocket が使えない環境（プレビュー/一部WebView）でも確実に動く
//  - 観戦ページ(watch.html)が SDK 無しの超軽量バンドルで済む
// 書き込みは docs/rtdb-rules.json の events ルールで検証される（構造・状態遷移・時刻）。
// dev検証用: localStorage "triple-slot.dburl" でモックDBに差し替え可能
const DB_OVERRIDE = (() => {
  try {
    return localStorage.getItem("triple-slot.dburl");
  } catch {
    return null;
  }
})();
export const DB_URL =
  DB_OVERRIDE ||
  "https://triple-slot-ranking-default-rtdb.asia-southeast1.firebasedatabase.app";

/** RTDB のサーバー値（書き込み時にサーバー時刻へ解決される） */
export const SV_TIME = { ".sv": "timestamp" } as const;

// --- サーバー時刻同期 -------------------------------------------------
// 大会の開始/終了は「サーバー時刻の startAt」と「端末の現在時刻」の比較で決まる。
// 端末の時計がズレていると、その人だけ早く（または遅く）タイムアップしてしまう。
//
// 旧実装はレスポンスの Date ヘッダだけでズレを推定していたが、Date は CORS の
// safelisted ヘッダではないため、別オリジン（GitHub Pages / capacitor://localhost）
// からの fetch では headers.get("date") が null になり得る。その場合ズレは 0 のまま
// ＝**端末の時計そのもの**で終了判定しており、時計が進んでいる端末だけ早く終わった。
//
// 対策: RTDB に {".sv":"timestamp"} を書いてサーバー時刻を直接受け取り（＝probe）、
// 往復時間の中点でズレを推定する。Date ヘッダは probe が取れるまでの保険に格下げ。
let clockOffset = 0;
let clockSource: "none" | "header" | "probe" = "none";
let bestRtt = Infinity;
let probeInflight: Promise<boolean> | null = null;

function sampleClock(res: Response): void {
  if (clockSource === "probe") return; // 精密な値があるなら秒精度のヘッダは使わない
  const d = res.headers.get("date");
  if (!d) return;
  const server = Date.parse(d);
  if (!Number.isFinite(server)) return;
  const diff = server - Date.now();
  // 揺れを抑えるため移動平均（最初のサンプルはそのまま採用）
  clockOffset = clockSource === "none" ? diff : clockOffset * 0.7 + diff * 0.3;
  clockSource = "header";
}

/** サーバー基準の現在時刻(ms)。全端末でほぼ同じ値になる。 */
export function serverNow(): number {
  return Date.now() + clockOffset;
}

/** サーバー時刻を直接測れたか（false の間は端末時計 or Date ヘッダ頼み）。 */
export function clockSynced(): boolean {
  return clockSource === "probe";
}

/**
 * `path` にサーバー時刻を書き込み、その値から端末時計とのズレを測る。
 * 同時呼び出しは1本にまとめる。失敗しても throw しない（false）。
 */
export function syncServerClock(path: string): Promise<boolean> {
  if (probeInflight) return probeInflight;
  probeInflight = (async () => {
    try {
      const t0 = Date.now();
      const put = await req<unknown>("PUT", path, SV_TIME);
      const t1 = Date.now();
      if (put === null) return false;
      // REST は解決済みの値を返すはずだが、返らない場合は読み直す。
      // どちらでもサーバーが時刻を確定させたのは PUT の往復中（t0〜t1）。
      let ts = typeof put === "number" ? put : null;
      if (ts === null) {
        const got = await req<unknown>("GET", path);
        ts = typeof got === "number" ? got : null;
      }
      if (ts === null) return false;
      const rtt = t1 - t0;
      const offset = ts - (t0 + t1) / 2; // 誤差は最大 rtt/2
      // 採用条件: 初回 / 前回並みに速い往復 / 誤差では説明できない大ズレ（端末時計の変更など）
      const jumped = Math.abs(offset - clockOffset) > rtt / 2 + 1500;
      if (clockSource !== "probe" || jumped || rtt <= bestRtt * 1.5 + 100) {
        bestRtt = clockSource !== "probe" || jumped ? rtt : Math.min(bestRtt, rtt);
        clockOffset = offset;
        clockSource = "probe";
      }
      return true;
    } finally {
      probeInflight = null;
    }
  })();
  return probeInflight;
}

// --- REST 実行（throwしない。失敗は null） ----------------------------
async function req<T>(
  method: "GET" | "PUT" | "PATCH" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T | null> {
  try {
    const res = await fetch(`${DB_URL}/${path}.json`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    sampleClock(res);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const evGet = <T>(path: string) => req<T>("GET", path);
export const evPut = <T>(path: string, body: unknown) => req<T>("PUT", path, body);
export const evPatch = <T>(path: string, body: unknown) => req<T>("PATCH", path, body);
/** POST=push。戻り値は `{ name: <pushId> }`。 */
export const evPost = (path: string, body: unknown) =>
  req<{ name: string }>("POST", path, body);
export const evDelete = (path: string) => req<null>("DELETE", path);
