import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// バグ報告に「どのビルドで起きたか」を載せるため、バージョンとコミットを埋め込む。
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
function buildSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

// base: "./" にしておくと、ビルド後の dist/ をそのまま file:// で開いても動く。
export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_SHA__: JSON.stringify(buildSha()),
  },
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
