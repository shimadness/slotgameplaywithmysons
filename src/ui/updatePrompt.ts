// ===== アプリ更新の案内（ネイティブのみ） ==============================
// 起動時に RTDB の `appmeta/<platform>` を読み、配布中の最新ビルドより自分が古ければ
// 「新しいバージョンがあります」モーダルを出して配布先（TestFlight / App Distribution）へ誘導する。
//
// ※ web / PWA は開き直せば最新が配信されるので対象外（ネイティブだけが手動更新のため）。
// ※ ビルド番号は iOS(CURRENT_PROJECT_VERSION) と Android(versionCode) で体系が別なので
//    プラットフォームごとに最新値を持つ。
// ※ 取得失敗・未設定は「黙って何もしない」＝ゲームを絶対に妨げない。
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { evGet } from "../event/api";

/** RTDB `appmeta/<platform>` の中身（値はFirebaseコンソールで手動更新） */
interface AppMeta {
  /** 配布中の最新ビルド番号（iOS=CURRENT_PROJECT_VERSION / Android=versionCode） */
  build?: number;
  /** 表示用のバージョン名（例 "1.2"） */
  version?: string;
  /** 更新先URL（iOS=TestFlightリンク / Android=App Distributionの配布リンク） */
  url?: string;
  /** 「今回の更新内容」1〜2行 */
  notes?: string;
}

/** 起動時に1回呼ぶ。更新があればモーダルを出す。 */
export async function checkForUpdate(): Promise<void> {
  const platform = Capacitor.getPlatform();
  if (platform !== "ios" && platform !== "android") return; // ネイティブのみ
  try {
    const info = await App.getInfo();
    const localBuild = Number(info.build);
    if (!Number.isFinite(localBuild)) return;

    const meta = await evGet<AppMeta>(`appmeta/${platform}`);
    if (!meta || typeof meta.build !== "number") return; // 未設定なら何もしない
    if (meta.build <= localBuild) return; // 最新を使っている

    showPrompt(info.version, meta);
  } catch {
    /* 取得できなくても何もしない（オフライン等） */
  }
}

/** 更新案内モーダル（大会UIと同じ .ev-overlay/.ev-panel＝iOSセーフなレイアウトを流用） */
function showPrompt(currentVersion: string, meta: AppMeta): void {
  const ov = document.createElement("div");
  ov.className = "ev-overlay";
  const notes = meta.notes
    ? `<p class="ev-sub upd-notes">${escapeHtml(meta.notes)}</p>`
    : "";
  // 外部リンクは Capacitor が既定でシステムブラウザへ渡す（target=_blank）
  const link = meta.url
    ? `<a class="btn primary" href="${escapeHtml(meta.url)}" target="_blank" rel="noopener">更新する</a>`
    : "";
  ov.innerHTML = `
    <div class="ev-panel">
      <h2 class="ev-title">🆕 新しいバージョン</h2>
      <p class="ev-sub">
        いま <b>v${escapeHtml(currentVersion)}</b> → 最新 <b>v${escapeHtml(meta.version ?? "")}</b>
      </p>
      ${notes}
      <div class="ev-actions">
        ${link}
        <button class="btn ghost" data-later>あとで</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  // 「あとで」は永続スキップしない（次回起動でまた案内＝更新を促し続ける）
  ov.querySelector("[data-later]")!.addEventListener("click", () => ov.remove());
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
