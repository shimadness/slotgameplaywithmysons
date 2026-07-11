import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// base: "./" にしておくと、ビルド後の dist/ をそのまま file:// で開いても動く。
export default defineConfig({
  base: "./",
  server: {
    open: true,
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
  },
  build: {
    rollupOptions: {
      input: {
        // 本体 ＋ 大会ページ ＋ 大会観戦モニター（プロジェクター用）の3ページ構成
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        taikai: fileURLToPath(new URL("./taikai.html", import.meta.url)),
        watch: fileURLToPath(new URL("./watch.html", import.meta.url)),
      },
    },
  },
});
