// ===== 観戦ページ（watch.html）エントリポイント =======================
// ゲーム本体・Firebase SDK を含まない超軽量バンドル（RESTのみ）。
import "./spectator.css";
import { renderSpectator } from "./ui/spectator";

renderSpectator(document.getElementById("sp")!);
