import { defineConfig } from "vite";

// base: "./" にしておくと、ビルド後の dist/ をそのまま file:// で開いても動く。
export default defineConfig({
  base: "./",
  server: {
    open: true,
  },
});
