import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.shimadness.tripleslot",
  appName: "TRIPLE SLOT",
  webDir: "dist",
  // ネイティブWebViewの背景。読み込み中の地色をキャビネットの濃紺に合わせる
  backgroundColor: "#070a1e",
  ios: {
    // セーフエリアはCSS（env(safe-area-inset-*)）側で自前制御するため
    // WebView自体は画面いっぱいに広げる
    contentInset: "never",
    backgroundColor: "#070a1e",
  },
};

export default config;
