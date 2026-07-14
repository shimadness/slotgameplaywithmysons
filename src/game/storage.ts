// ===== 永続ストレージ（書き込みスルー・キャッシュ） ===================
// ゲーム側は今まで通り「同期」で読み書きするが、実体は起動時に hydrate() で
// 読み込んだインメモリキャッシュ。書き込みはキャッシュ更新と同時に、背後で
// 非同期に永続化される。
//
//   ネイティブ（iOS/Android）: @capacitor/preferences に保存
//       → アプリ再インストール／再起動でも消えない（localStorage は WebView の
//         都合で消えることがある＝メダルが飛ぶ原因だった）。
//   Web / PWA / プラグイン不在: localStorage にフォールバック。
//
// さらに hydrate() 時に、旧 localStorage のセーブを Preferences へ一度きり移行する
// （既存プレイヤーのメダルを、更新後も引き継ぐため）。
import { Capacitor } from "@capacitor/core";

/** このゲームが使うキーの共通プレフィックス（storage の走査対象を絞る）。 */
const PREFIX = "triple-slot.";

/** 同期読み書きの実体。hydrate() で永続ストアから満たす。 */
const cache = new Map<string, string>();

type Backend = "preferences" | "local";
let backend: Backend = "local";

// Preferences はネイティブ時のみ動的 import する（web バンドルを太らせない）。
interface PrefsAPI {
  get(o: { key: string }): Promise<{ value: string | null }>;
  set(o: { key: string; value: string }): Promise<void>;
  remove(o: { key: string }): Promise<void>;
  keys(): Promise<{ keys: string[] }>;
}
let prefs: PrefsAPI | null = null;

// --- localStorage 薄ラッパ（例外を握りつぶす） ------------------------
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* プライベートモード等で不可でも無視 */
  }
}
function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
function lsKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) out.push(k);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * 起動時に一度だけ呼ぶ（await 必須）。永続ストアからキャッシュを満たす。
 * これを終える前に GameState を構築すると、再インストール直後などに残高が
 * 初期値のまま見えてしまうので、必ず new GameState() の前に await すること。
 */
export async function hydrate(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    try {
      const mod = await import("@capacitor/preferences");
      prefs = mod.Preferences as unknown as PrefsAPI;
      backend = "preferences";
    } catch {
      // プラグイン不在ならフォールバック（web と同じ挙動で壊れない）
      prefs = null;
      backend = "local";
    }
  }

  if (backend === "preferences" && prefs) {
    // Preferences の全キーを読み込む（動的な大会キーも含めて拾える）。
    let keys: string[] = [];
    try {
      keys = (await prefs.keys()).keys ?? [];
    } catch {
      keys = [];
    }
    for (const k of keys) {
      if (!k.startsWith(PREFIX)) continue;
      try {
        const { value } = await prefs.get({ key: k });
        if (value != null) cache.set(k, value);
      } catch {
        /* 個別キーの読み取り失敗は無視 */
      }
    }
    // 旧データ移行：localStorage にあって Preferences に無いキーを取り込み、
    // Preferences 側にも書き込む（既存メダルを更新後も保持する一度きりの移行）。
    for (const k of lsKeys()) {
      if (!k.startsWith(PREFIX) || cache.has(k)) continue;
      const v = lsGet(k);
      if (v == null) continue;
      cache.set(k, v);
      try {
        await prefs.set({ key: k, value: v });
      } catch {
        /* 移行書き込みの失敗は無視（次回また試みる） */
      }
    }
  } else {
    // web / PWA / フォールバック：localStorage をそのままキャッシュへ。
    for (const k of lsKeys()) {
      if (!k.startsWith(PREFIX)) continue;
      const v = lsGet(k);
      if (v != null) cache.set(k, v);
    }
  }
}

/** 同期読み取り（キャッシュから）。 */
export function getItem(key: string): string | null {
  return cache.has(key) ? cache.get(key)! : null;
}

/** 同期書き込み（キャッシュ更新＋背後で永続化）。 */
export function setItem(key: string, value: string): void {
  cache.set(key, value);
  if (backend === "preferences" && prefs) {
    void prefs.set({ key, value }).catch(() => {});
    // Preferences 書き込みが万一失敗しても次回 hydrate の移行で拾えるよう、
    // localStorage にも保険としてミラーしておく（同期・軽量）。
    lsSet(key, value);
  } else {
    lsSet(key, value);
  }
}

/** 同期削除（キャッシュ＋永続ストアの両方から）。 */
export function removeItem(key: string): void {
  cache.delete(key);
  if (backend === "preferences" && prefs) {
    void prefs.remove({ key }).catch(() => {});
    lsRemove(key);
  } else {
    lsRemove(key);
  }
}
