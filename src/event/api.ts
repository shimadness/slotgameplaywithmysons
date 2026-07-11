// ===== 大会モード用 RTDB RESTクライアント =============================
// Firebase SDK ではなく素の fetch(REST) を使う。理由:
//  - WebSocket が使えない環境（プレビュー/一部WebView）でも確実に動く
//  - 観戦ページ(watch.html)が SDK 無しの超軽量バンドルで済む
// ルールはテスト/公開 read-write 前提（docs/rtdb-rules.json 参照）。
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
// レスポンスの Date ヘッダ（秒精度）からローカル時計とのズレを推定する。
// 15分大会のカウントダウン用途なら ±1秒で十分。
let clockOffset = 0;
let offsetSamples = 0;

function sampleClock(res: Response): void {
  const d = res.headers.get("date");
  if (!d) return;
  const server = Date.parse(d);
  if (!Number.isFinite(server)) return;
  const diff = server - Date.now();
  // 揺れを抑えるため移動平均（最初のサンプルはそのまま採用）
  clockOffset = offsetSamples === 0 ? diff : clockOffset * 0.7 + diff * 0.3;
  offsetSamples++;
}

/** サーバー基準の現在時刻(ms)。全端末でほぼ同じ値になる。 */
export function serverNow(): number {
  return Date.now() + clockOffset;
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
