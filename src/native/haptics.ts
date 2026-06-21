// ネイティブ触覚フィードバック。Capacitor(@capacitor/haptics)を薄く包む。
// Web / 非ネイティブ端末では vibrate 非対応＝自動で無音 no-op。例外は握りつぶす。
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

let enabled = true;

/** 触覚のON/OFF（将来ミュート設定と連動させる場合の口）。 */
export function setHaptics(on: boolean): void {
  enabled = on;
}

function safe(run: () => Promise<unknown> | void): void {
  if (!enabled) return;
  try {
    void run();
  } catch {
    // 非対応環境では黙って無視
  }
}

export const haptics = {
  /** スピン開始の軽いコツン */
  spin: () => safe(() => Haptics.impact({ style: ImpactStyle.Light })),
  /** 連鎖ステップ：連鎖が深いほど強く */
  chain: (n: number) =>
    safe(() =>
      Haptics.impact({
        style:
          n >= 4 ? ImpactStyle.Heavy : n >= 2 ? ImpactStyle.Medium : ImpactStyle.Light,
      })
    ),
  /** 小当たり */
  winSmall: () => safe(() => Haptics.notification({ type: NotificationType.Success })),
  /** 大当たり */
  winBig: () => safe(() => Haptics.notification({ type: NotificationType.Success })),
  /** コンボ/ボーナス成立 */
  bonus: () => safe(() => Haptics.impact({ style: ImpactStyle.Heavy })),
  /** セブンラッシュ突入 */
  rush: () => safe(() => Haptics.notification({ type: NotificationType.Warning })),
  /** メダル不足など拒否 */
  deny: () => safe(() => Haptics.notification({ type: NotificationType.Error })),
};
