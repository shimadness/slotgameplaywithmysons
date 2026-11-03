// ===== ブートストラップ ==============================================
// 永続ストレージ（メダル等）を hydrate() で読み込んでから本体を起動する。
// トップレベル await は Vite の既定ターゲット（safari14 等）で使えないため、
// await ではなく then で本体（main.ts）を動的 import する。これで本体の
// トップレベルに来た時点では GameState が正しい残高で構築できる。
import { hydrate } from "./game/storage";
import { installDiag } from "./diag";

// バグ報告に添付するため、本体より先にエラー収集を仕込む
installDiag();

hydrate()
  .catch(() => {
    /* 読み込み失敗でも起動は続行（初期値/フォールバックで動く） */
  })
  .then(() => import("./main.ts"));
