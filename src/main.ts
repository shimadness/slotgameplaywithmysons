// ===== TRIPLE SLOT — エントリポイント ===============================
// 2モード搭載: ①3×3 DROP（連鎖パズル×スロット） ②5リール本格派
import "./style.css";
import { ReelEngine } from "./game/engine";
import { GameState, type PlayerId } from "./game/state";
import {
  evaluate,
  freeSpinsFor,
  REELS,
  type Grid,
  type SpinEvaluation,
} from "./game/paylines";
import { play as dropPlay, DSYMBOLS, BASE_SYMS, SEVEN_RUSH_GAMES, type DSym } from "./game/dropEngine";
import { DU_LADDER, SPECIAL_BONUS, duGlyph, duColor } from "./game/doubleup";
import { Sfx } from "./audio/sfx";
import { Board } from "./ui/board";
import { DropBoard } from "./ui/dropBoard";
import { Effects } from "./ui/effects";
import { Hud } from "./ui/hud";
import { DoubleUp } from "./ui/doubleup";
import { RankingUI } from "./ui/ranking";
import { EventUI } from "./ui/event";
import { haptics } from "./native/haptics";
import { installFitScreen } from "./ui/fitScreen";
import { Capacitor } from "@capacitor/core";
import { ALL_SYMBOL_IDS, sym, type SymbolId } from "./game/symbols";

type Mode = "drop" | "slot";

/** 大会専用ページ（taikai.html）か。メインページには大会UIを出さない。 */
const IS_TAIKAI = /taikai\.html$/.test(location.pathname);

const app = document.getElementById("app")!;
const engine = new ReelEngine();
const state = new GameState();
const sfx = new Sfx();

// ズーム抑止：iOS Safari/PWA は viewport の user-scalable=no を無視するので、
// ピンチ拡大（gesture系）を明示的に抑止する。ダブルタップ拡大は CSS の
// touch-action: manipulation 側で無効化済み（タップ操作には干渉しない）。
for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(ev, (e) => e.preventDefault());
}

// ---- レイアウト ----------------------------------------------------
app.innerHTML = `
  <div class="cabinet">
    <header class="title">
      <h1>TRIPLE <span>SLOT</span></h1>
      <div class="header-tools">
        <div class="tool-row primary">
          <button class="player-btn" data-player title="プレイヤーを切り替え">
            👤 <b data-player-name>プレイヤー1</b>
          </button>
          <div class="mode-switch">
            <button class="mode-btn active" data-mode="drop">3×3 DROP</button>
            <button class="mode-btn" data-mode="slot">5リール</button>
          </div>
        </div>
        <div class="tool-row utility">
          <button class="paytable-btn" data-rank>🏆 ランキング</button>
          ${
            IS_TAIKAI
              ? `<button class="paytable-btn" data-event>👑 メダル王</button>`
              : `<button class="paytable-btn" data-shop>🛒 SHOP</button>`
          }
          <button class="paytable-btn" data-help>配当表</button>
        </div>
      </div>
    </header>
    <div class="machine" data-machine></div>
  </div>`;

const machine = app.querySelector("[data-machine]") as HTMLElement;

// RUSH 中だけ光る放射状の背景レイヤー
const rushRays = document.createElement("div");
rushRays.className = "rush-rays";
machine.appendChild(rushRays);

const board = new Board(engine.strips); // 5リール
const dropBoard = new DropBoard(); // 3×3
machine.appendChild(dropBoard.el);
machine.appendChild(board.el);
board.el.classList.add("hidden");

// 5リールの天狗フリーゲーム説明（電光掲示板風の横スクロール／DROPのセブンラッシュ説明と同方式）
const tenguRule = document.createElement("div");
tenguRule.className = "tengu-free-rule hidden";
{
  const t = `👺 <b>天狗フリーゲーム</b> ― 天狗が3つそろうと突入！フリー中は<b>ワイルド</b>が大量出現し、<b>花火</b>で配当が<b>×2・×3</b>と倍々に！メダル大量獲得のチャンス！`;
  tenguRule.innerHTML = `<div class="rr-track"><span class="rr-seg tengu">${t}</span><span class="rr-seg tengu" aria-hidden="true">${t}</span></div>`;
}
machine.appendChild(tenguRule);

const effects = new Effects(machine, board);
const doubleUp = new DoubleUp(sfx);
app.appendChild(doubleUp.el);

const ranking = new RankingUI();
app.appendChild(ranking.el);
app.querySelector("[data-rank]")!.addEventListener("click", () =>
  ranking.openBoard(state.mode)
);

// 1ゲームの獲得メダル（ダブルアップ後の最終額）が TOP10 入りなら祝福モーダル。
// 通信失敗してもゲームは止めない（store 側が throw しない）。
async function considerRanking(score: number): Promise<void> {
  if (score <= 0) return;
  if (state.inEvent) return; // 大会のスコアは家族用TOP10に混ぜない

  const prevBusy = busy;
  try {
    // ランクインして登録モーダルが開いている間は busy=true を立て、
    // AUTO の次ゲームや setTimeout(play) が「モーダルの裏」で走らないようにする。
    // ランク外（小粒勝ち）では onOpen が呼ばれないので、無駄な SPIN 無効化は起きない。
    await ranking.maybeCelebrate(state.mode, score, state.bet, state.playerName, () => {
      busy = true;
      hud.setBusy(true);
    });
  } catch {
    /* ランキングはおまけ。失敗してもゲーム進行を妨げない。 */
  } finally {
    busy = prevBusy;
    hud.setBusy(prevBusy);
  }
}

// 勝利の精算。AUTO中も含めてダブルアップに移行（最終額を addWin）。
// RUSH（フリースピン）中だけは自動 COLLECT（ダブルアップをスキップ）。
async function resolveWin(win: number): Promise<void> {
  if (win <= 0) return;
  // RUSH中、または ダブルアップOFF のときは自動COLLECT。
  if (state.inRush || !state.duEnabled) {
    state.addWin(win);
    hud.animateWin(win);
    // 通常勝利（非RUSH）はここで確定額なのでランキング判定。RUSHは finishRush 側で判定。
    if (!state.inRush) {
      eventUI.notifyWin(win); // 大会: 大勝ち速報（RUSH中は総獲得で流す）
      await considerRanking(win);
    }
    return;
  }
  busy = true; // ダブルアップ中はスピン禁止
  const final = await doubleUp.start(win, state.bet, {
    canRetry: state.shopDuRetry,
    onRetryUsed: () => state.consumeShopDuRetry(),
  });
  state.addWin(final);
  hud.animateWin(final);
  hud.update();
  eventUI.notifyWin(final); // 大会: 大勝ち速報
  await considerRanking(final); // ダブルアップ後の最終額でランキング判定
}

let playerOverlay: HTMLElement;
let mode: Mode = state.mode; // 保存値から復元（リロードで3×3に戻る不具合の対策）
let busy = false;
let autoPlay = false;
let rushWinTotal = 0;

// RUSH 突入/終了時の専用演出（BGM＋背景）
function enterRushFx(): void {
  document.body.classList.add("rush-active");
  sfx.startRushBgm();
}
function exitRushFx(): void {
  document.body.classList.remove("rush-active");
  sfx.stopRushBgm();
}

// オートプレイの次ゲーム予約
function maybeAutoNext(): void {
  if (!autoPlay || busy || state.inRush) return;
  if (state.canSpin()) {
    setTimeout(() => void play(), 650);
  } else {
    setAuto(false);
  }
}
function setAuto(on: boolean): void {
  autoPlay = on;
  hud.setAuto(on);
}

const hud = new Hud(state, {
  onSpin: () => void play(),
  onBet: () => {
    if (busy || state.inRush) return;
    sfx.resume();
    sfx.ui();
    if (state.mode === "drop") state.cycleDropBet();
    else state.cycleLineBet();
    hud.update();
  },
  onMaxBet: () => {
    if (busy || state.inRush) return;
    sfx.resume();
    sfx.ui();
    if (state.mode === "drop") state.setDropMaxBet();
    else state.setMaxBet();
    hud.update();
  },
  onAddBet: (n) => {
    if (busy || state.inRush) return;
    sfx.resume();
    sfx.ui();
    state.addBet(n);
    hud.update();
  },
  onDropMax: () => {
    if (busy || state.inRush) return;
    sfx.resume();
    sfx.ui();
    state.betDropMax();
    hud.update();
  },
  onClearBet: () => {
    if (busy || state.inRush) return;
    sfx.resume();
    sfx.ui();
    state.clearBet();
    hud.update();
  },
  onToggleMute: () => {
    sfx.resume();
    sfx.setMuted(!sfx.muted);
    hud.setMuted(sfx.muted);
  },
  onToggleAuto: () => {
    if (state.inEvent) { sfx.deny(); return; } // 大会はAUTO禁止
    sfx.resume();
    sfx.ui();
    setAuto(!autoPlay);
    if (autoPlay && !busy && !state.inRush) void play();
  },
  onToggleDu: () => {
    if (busy) return; // 勝利精算中の切替は避ける
    sfx.resume();
    sfx.ui();
    state.setDuEnabled(!state.duEnabled);
    hud.setDu(state.duEnabled);
  },
  onRefill: () => {
    sfx.resume();
    sfx.ui();
    state.refill();
    hud.update();
  },
});
app.querySelector(".cabinet")!.appendChild(hud.el);

// ---- ⚡軽量モード（発光・花火をひかえめにして低スペ端末でもなめらかに）----
const LITE_KEY = "triple-slot.lite";
const liteBtn = app.querySelector("[data-lite]") as HTMLButtonElement;
function setLite(on: boolean): void {
  document.body.classList.toggle("lite", on);
  effects.setLite(on);
  liteBtn.classList.toggle("active", on);
  try {
    localStorage.setItem(LITE_KEY, on ? "1" : "0");
  } catch { /* ignore */ }
}
setLite(localStorage.getItem(LITE_KEY) === "1");
liteBtn.addEventListener("click", () => {
  sfx.resume();
  sfx.ui();
  setLite(!document.body.classList.contains("lite"));
});

// ---- 🎪 大会モード（15分タイムアタック）------------------------------
const eventUI = new EventUI({
  state,
  sfx,
  isBusy: () => busy,
  onEnter: () => {
    setAuto(false); // 大会はAUTO禁止（手動＝ダブルアップの判断が腕の見せ所）
    setLite(true); // 回転数の公平性＆負荷対策で軽量モードを自動ON
    syncModeUI();
  },
  onExit: () => {
    syncModeUI();
  },
  refreshHud: () => hud.update(),
  burst: (n) => effects.burst(n),
});
app.appendChild(eventUI.el);
// 残り時間バーはヘッダーと盤面の間に挿す
app.querySelector(".cabinet")!.insertBefore(eventUI.timerBar, machine);
// 大会UIは taikai.html 専用（メインページのヘッダー幅を増やさない＝レイアウト維持）
app.querySelector("[data-event]")?.addEventListener("click", () => {
  if (busy || state.inRush || autoPlay || state.inEvent) return;
  sfx.resume();
  sfx.ui();
  eventUI.openJoin(state.playerName);
});
if (IS_TAIKAI) {
  // リロード前の大会があれば復帰。無ければ参加モーダルを自動で開く
  void eventUI.maybeResume().then(() => {
    if (!eventUI.active) eventUI.openJoin(state.playerName);
  });
}

// ネイティブアプリ（iOS/Android）＋ PWAスタンドアロン 共通のレイアウト調整（CSSは html.native-app で分岐）
const capPlatform = Capacitor.getPlatform();
const isStandalonePWA =
  window.matchMedia?.("(display-mode: standalone)").matches === true ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;
if (capPlatform !== "web" || isStandalonePWA) {
  document.documentElement.classList.add("native-app");
  if (capPlatform !== "web") document.documentElement.classList.add(`native-${capPlatform}`);
  // セブンラッシュ告知を「オッズ列の下」→「3×3グリッドの下（全幅）」へ移動
  const rush = dropBoard.el.querySelector(".drop-rush-rule");
  if (rush) dropBoard.el.appendChild(rush);
}

// PWA: Service Worker 登録（ホーム画面インストール＋オフライン対応）。ネイティブ(Capacitor)では不要。
if (capPlatform === "web" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {/* 失敗しても通常動作 */});
  });
}

// 画面に必ず1画面で収める（zoom方式・堅牢版）
installFitScreen(app.querySelector(".cabinet") as HTMLElement);

// ---- モード切替 ----------------------------------------------------
app.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (busy || state.inRush || autoPlay) return;
    const next = btn.dataset.mode as Mode;
    if (next === mode) return;
    sfx.resume();
    sfx.ui();
    mode = next;
    state.setMode(next); // ベット構造を切替＋保存（リロード復帰用）
    syncModeUI();
  });
});

// 現在の `mode` を画面に反映（起動時の復元・モード切替で共通利用）
function syncModeUI(): void {
  app.querySelectorAll<HTMLElement>(".mode-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === mode)
  );
  board.el.classList.toggle("hidden", mode !== "slot");
  dropBoard.el.classList.toggle("hidden", mode !== "drop");
  tenguRule.classList.toggle("hidden", mode !== "slot");
  hud.update();
}
// 起動時：保存済みモード（5リール等）に復元
syncModeUI();

// ---- 設定（ペイアウト率 1〜6）切替 ----------------------------------
// 設定（ペイアウト率）は廃止 — DROPは本家準拠の固定配当。

// ---- プレイヤー（3人別々のクレジット）------------------------------
const playerNameEl = app.querySelector("[data-player-name]") as HTMLElement;
function updatePlayerName(): void {
  playerNameEl.textContent = state.playerName;
}
updatePlayerName();
buildPlayerPicker();
app.querySelector("[data-player]")!.addEventListener("click", () => {
  if (busy || state.inRush || autoPlay || state.inEvent) return; // 大会中は切替不可
  sfx.resume();
  sfx.ui();
  openPlayerPicker();
});
// 初回はプレイヤー選択を出す（大会ページでは参加モーダルが出るので出さない）
if (state.firstRun && !IS_TAIKAI) openPlayerPicker();

buildPaytable();
buildShop();

// キーボード: Space / Enter でスピン
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" || e.code === "Enter") {
    e.preventDefault();
    void play();
  }
});

// ---- モードディスパッチ --------------------------------------------
function play(): Promise<void> {
  return mode === "slot" ? playSlot() : playDrop();
}

// ===================================================================
// 3×3 DROP モード
// ===================================================================
async function playDrop(): Promise<void> {
  if (busy) return;
  if (eventUI.blocksSpin()) { sfx.deny(); return; } // 大会: 開始前/タイムアップ後
  sfx.resume();
  if (!state.canSpin()) {
    sfx.deny();
    haptics.deny();
    if (!state.inRush) void effects.banner("メダル不足", 1200);
    return;
  }

  busy = true;
  hud.setBusy(true);
  effects.clearParticles(); // 前スピン（特にフリー中の連続花火）の残留を一掃
  state.lastWin = 0;
  state.placeBet();
  hud.update();
  haptics.spin();

  const inRush = state.inRush; // このスピン開始時点でラッシュ中か
  // SHOP購入効果は通常スピンでのみ消費（ラッシュ中は対象外）
  const forceWild = !inRush && state.consumeShopWild();
  const forceRush = !inRush && state.consumeShopRush();
  const result = dropPlay(state.bet, undefined, inRush, forceWild, forceRush); // ラッシュ中は7大量プール

  sfx.startSpin();
  sfx.playStart(); // ゲーム開始〜初回配当決定の効果音（リール停止でカット）

  let running = 0;
  let lineHits = 0; // このプレイで「ライン配当」が出た回数（コンボのみのステップは数えない）
  await dropBoard.run(result, {
    onReelStop: () => sfx.reelStop(),
    onAllReelsStopped: () => sfx.stopSpin(), // 開始効果音はここで切らず最後まで流す
    onReach: () => { sfx.fadeOutPlayStart(); sfx.reach(); void effects.banner("リーチ！", 900); },
    onStep: (step) => {
      sfx.chain(step.chain);
      // ライン配当が出た回数で音を出し分け（1回目→001 … 5回目以降→005）。連鎖の深さではない。
      if (step.lineWins.length > 0) { sfx.fadeOutPlayStart(); sfx.lineWin(++lineHits); } // 被るので開始音はフェードアウト
      if (step.stepWin > 0) haptics.chain(step.chain);
      running += step.stepWin;
      state.lastWin = running;
      hud.update();
      const colors = [
        ...step.lineWins.map((w) => dropSymColor(w.symbol)),
        ...step.connectWins.map((w) => dropSymColor(w.symbol)),
        "#fff",
      ];
      effects.burst(Math.min(10 + step.chain * 8, 60), colors);
      if (step.chain >= 2 && step.stepWin > 0) effects.popChain(step.chain, step.stepWin);
    },
  });

  // コンボボーナス（連鎖終了時に1回）
  if (result.comboPay > 0) {
    running += result.comboPay;
    state.lastWin = running;
    hud.update();
    sfx.bonus();
    haptics.bonus();
    await effects.banner(`コンボ ${result.maxChain}連鎖  ×${result.comboMult}  +${result.comboPay}`, 1300);
  }

  if (result.totalWin > 0) {
    const big = result.totalWin >= state.totalBet * 30 || result.maxChain >= 5;
    effects.popWin(result.totalWin, big);
    if (big) { sfx.winBig(); haptics.winBig(); }
    else { sfx.winSmall(); haptics.winSmall(); }
    // ラッシュ中は自動collectなので短め、通常はダブルアップ前に余韻(+1秒)
    await pace(inRush ? (big ? 700 : 400) : (big ? 1900 : 1500));
    await resolveWin(result.totalWin); // ラッシュ中は自動collect / 通常はダブルアップ
    if (inRush) rushWinTotal += result.totalWin;
    await wait(300);
  } else {
    await wait(200);
  }

  // セブンラッシュ突入（通常スピンで初期盤面にスキャッター3個以上）
  if (!inRush && result.triggeredRush) {
    rushWinTotal = 0;
    state.startRush(SEVEN_RUSH_GAMES, 1);
    eventUI.notifyRush("rush"); // 大会: 速報
    enterRushFx();
    sfx.bonus();
    haptics.rush();
    await effects.banner(`★ セブンラッシュ 突入！ ${SEVEN_RUSH_GAMES}ゲーム ★`, 1900);
    hud.update();
  }

  busy = false;
  hud.setBusy(false);
  hud.update();
  eventUI.onSpinCycleEnd(); // 大会: スピン数カウント＋スコア即時送信

  if (state.inRush) {
    if (state.freeSpins > 0) setTimeout(() => void play(), 1000);
    else await finishDropRush();
  } else {
    maybeAutoNext();
  }
}

async function finishDropRush(): Promise<void> {
  // ★大会の確定(finalize)は busy を見て待つ。ラッシュ終了バナー〜ダブルアップまで
  // busy=true を保持し、「ダブルアップ後の最終スコア」が確定してから finalize させる。
  // （旧: バナー中に busy=false になり、ダブルアップ前スコアで確定→自分/他者/観戦がズレた）
  busy = true;
  hud.setBusy(true);
  const total = rushWinTotal;
  state.endRush();
  exitRushFx();
  hud.update();
  sfx.winBig();
  effects.burst(160);
  await effects.banner(`セブンラッシュ 終了！ 獲得 ${total.toLocaleString()}`, 2400);

  // 総獲得メダルでダブルアップに突入。total はラッシュ中に加算済みなので、
  // 一旦戻して「賭ける元手」にし、ダブルアップ結果(final)を改めて反映する（上限なし）。
  if (total > 0) {
    state.credits -= total; // lastWin は触らずメダルだけ戻す（overlayで隠れる）
    state.save();
    const final = await doubleUp.start(total, state.bet, {
      canRetry: state.shopDuRetry,
      onRetryUsed: () => state.consumeShopDuRetry(),
    });
    state.addWin(final);
    hud.animateWin(final);
    hud.update();
    eventUI.notifyWin(final); // 大会: ラッシュ総獲得の速報
    await considerRanking(final); // ラッシュ総獲得（ダブルアップ後）でランキング判定
  }

  busy = false;
  hud.setBusy(false);
  hud.update();
  // 大会: ダブルアップ後の確定スコアを即時反映（この後 tick の finalize も同値で確定）
  eventUI.reportScoreNow();

  maybeAutoNext();
}

/** dropEngine シンボルの色（effects 用） */
function dropSymColor(id: import("./game/dropEngine").DSym): string {
  return DSYMBOLS[id].color;
}

// ===================================================================
// 5リール モード
// ===================================================================
async function playSlot(): Promise<void> {
  if (busy) return;
  if (eventUI.blocksSpin()) { sfx.deny(); return; } // 大会: 開始前/タイムアップ後
  sfx.resume();
  if (!state.canSpin()) {
    sfx.deny();
    haptics.deny();
    if (!state.inRush) void effects.banner("メダル不足", 1200);
    return;
  }

  busy = true;
  hud.setBusy(true);
  effects.clearParticles(); // 前スピン（特にフリー中の連続花火）の残留を一掃
  state.lastWin = 0;
  state.placeBet();
  hud.update();
  haptics.spin();

  const { grid, stops } = engine.spin();
  const multiplier = state.inRush ? state.rushMultiplier : 1;
  const ev = evaluate(grid, state.totalBet, multiplier);
  const reach = computeReach(grid);

  sfx.startSpin();
  await board.spin(stops, reach, {
    onReelStop: () => sfx.reelStop(),
    onReachStart: () => {
      sfx.reach();
      void effects.banner("リーチ!!", 900);
    },
    onAllStopped: () => sfx.stopSpin(),
  });

  await resolveSlot(ev);

  busy = false;
  hud.setBusy(false);
  hud.update();
  eventUI.onSpinCycleEnd(); // 大会: スピン数カウント＋スコア即時送信

  if (state.inRush) {
    if (state.freeSpins > 0) setTimeout(() => void play(), 1100);
    else await finishRush();
  }
  if (!state.inRush) maybeAutoNext();
}

// 最終リール停止前の「アツい」状況を検出してリーチ演出
function computeReach(grid: Grid): boolean {
  let scat = 0;
  for (let reel = 0; reel < REELS - 1; reel++) {
    for (let row = 0; row < 3; row++) if (grid[reel][row] === "scatter") scat++;
  }
  if (scat >= 2) return true;

  const lines = [
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [2, 2, 2, 2],
    [0, 1, 2, 1],
    [2, 1, 0, 1],
  ];
  for (const pat of lines) {
    const syms: SymbolId[] = pat.map((row, reel) => grid[reel][row]);
    let base: SymbolId | undefined = syms.find(
      (s) => s !== "wild" && s !== "scatter"
    );
    if (!base && syms[0] === "wild") base = "wild";
    if (!base) continue;
    const allMatch = syms.every((s) => s === base || s === "wild");
    if (allMatch && (sym(base).premium || base === "cherry")) return true;
  }
  return false;
}

async function resolveSlot(ev: SpinEvaluation): Promise<void> {
  if (ev.total > 0) {
    effects.showWins(ev);
    const big = ev.total >= state.totalBet * 15;
    effects.sparkleForWins(ev);
    if (ev.wildMults.length > 0) {
      // まず花火前の素の配当を見せ → ワイルド花火で×N → 跳ね上がった総配当
      effects.popWin(ev.baseWin, false);
      sfx.winSmall();
      await pace(650);
      await effects.wildShow(ev); // 各ワイルドで花火＋×Nバッジ
      effects.popWin(ev.total, big);
      if (big) { sfx.winBig(); haptics.winBig(); }
      else { sfx.winSmall(); haptics.winSmall(); }
    } else {
      effects.popWin(ev.total, big);
      if (big) { sfx.winBig(); haptics.winBig(); }
      else { sfx.winSmall(); haptics.winSmall(); }
    }
    if (state.inRush) rushWinTotal += ev.total;
    await pace(big ? 2000 : 1600); // WIN を見せてからダブルアップへ（+1秒）
    await resolveWin(ev.total); // ダブルアップ → addWin（RUSH中は自動collect）
    await wait(300);
  } else {
    await wait(250);
  }

  if (ev.scatter?.triggersBonus) {
    const fs = freeSpinsFor(ev.scatter.count);
    if (state.inRush) {
      // フリー中の天狗3個で上乗せ（リトリガー）
      state.retriggerRush(fs);
      sfx.bonus();
      await effects.banner(`👺 天狗 上乗せ +${fs}`, 1600);
    } else {
      // 天狗フリーゲーム突入。フラット倍率は無し（大量獲得はワイルド花火で作る）。
      // ワイルド多めの「フリー帯」に切替える。
      rushWinTotal = 0;
      state.startRush(fs, 1);
      eventUI.notifyRush("tengu"); // 大会: 速報
      engine.setFreeMode(true);
      board.setStrips(engine.strips);
      enterRushFx();
      sfx.bonus();
      await effects.freeGameIntro(fs); // 突入オーバーレイ（ムービーのプレースホルダ）
    }
    hud.update();
  }
}

async function finishRush(): Promise<void> {
  // finishDropRush と同様、確定演出中は busy=true を保持して大会 finalize を待たせる
  // （5リールはダブルアップ無しだが、バナー中に確定処理が割り込むのを防ぐ）。
  busy = true;
  hud.setBusy(true);
  const total = rushWinTotal;
  state.endRush();
  engine.setFreeMode(false); // 通常帯へ戻す
  board.setStrips(engine.strips);
  exitRushFx();
  hud.update();
  sfx.winBig();
  effects.burst(160);
  await effects.banner(`👺 天狗フリーゲーム 終了！ 獲得 ${total.toLocaleString()}`, 2400);
  eventUI.notifyWin(total); // 大会: フリーゲーム総獲得の速報
  await considerRanking(total); // フリーゲーム総獲得でランキング判定
  busy = false;
  hud.setBusy(false);
  hud.update();
  eventUI.reportScoreNow(); // 大会: 確定スコアを即時反映
  maybeAutoNext();
}

// ---- プレイヤー選択（3人別々のクレジット）--------------------------
function buildPlayerPicker(): void {
  playerOverlay = document.createElement("div");
  playerOverlay.className = "player-overlay hidden";
  playerOverlay.innerHTML = `
    <div class="player-panel">
      <h2>だれが あそぶ？</h2>
      <p class="player-sub">名前はタップして変えられるよ</p>
      <div class="player-list" data-player-list></div>
      <button class="btn ghost" data-player-close>とじる</button>
    </div>`;
  app.appendChild(playerOverlay);

  playerOverlay
    .querySelector("[data-player-close]")!
    .addEventListener("click", () => closePlayerPicker());
  playerOverlay.addEventListener("click", (e) => {
    if (e.target === playerOverlay && !state.firstRun) closePlayerPicker();
  });
}

function renderPlayerList(): void {
  const list = playerOverlay.querySelector("[data-player-list]") as HTMLElement;
  list.innerHTML = state
    .allPlayers()
    .map(
      (p) => `
      <div class="player-card${p.id === state.playerId ? " current" : ""}">
        <input class="player-name-input" data-pid="${p.id}" maxlength="12"
               value="${escapeHtml(p.name)}" aria-label="名前" />
        <div class="player-credits">メダル <b>${p.credits.toLocaleString()}</b></div>
        <button class="btn primary" data-play="${p.id}">これで あそぶ</button>
      </div>`
    )
    .join("");

  list.querySelectorAll<HTMLInputElement>(".player-name-input").forEach((inp) => {
    const pid = inp.dataset.pid as PlayerId;
    const commit = () => {
      state.setName(pid, inp.value);
      if (pid === state.playerId) updatePlayerName();
    };
    inp.addEventListener("change", commit);
    inp.addEventListener("blur", commit);
  });
  list.querySelectorAll<HTMLButtonElement>("[data-play]").forEach((btn) => {
    btn.addEventListener("click", () => {
      sfx.resume();
      sfx.ui();
      state.switchPlayer(btn.dataset.play as PlayerId);
      updatePlayerName();
      hud.update();
      closePlayerPicker();
    });
  });
}

function openPlayerPicker(): void {
  renderPlayerList();
  playerOverlay.classList.remove("hidden");
}
function closePlayerPicker(): void {
  playerOverlay.classList.add("hidden");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

// ---- 配当表 --------------------------------------------------------
function buildPaytable(): void {
  // DROP シンボルの日本語名（配当表表示用）
  const DROP_NAMES: Record<DSym, string> = {
    cherry: "チェリー", orange: "オレンジ", plum: "プラム",
    bell: "ベル", bar: "BAR", bar2: "BAR²", bar3: "BAR³",
    blue7: "青7", red7: "赤7", gold7: "GOLD7", wild: "ワイルド5", rush7: "ラッシュ7",
  };

  const overlay = document.createElement("div");
  overlay.className = "paytable-overlay hidden";

  // ① DROP ラインオッズ開始値（役成立でこのシンボル以上が1段ずつ上昇）
  const oddsRows = [...BASE_SYMS, "gold7" as DSym].map((id) => {
    const d = DSYMBOLS[id];
    const fixed = id === "gold7";
    return `<tr>
      <td class="pt-glyph" style="color:${d.color}">${d.glyph}</td>
      <td class="pt-name">${DROP_NAMES[id]}</td>
      <td class="pt-pay">×${d.lineOdds}${fixed ? "" : "〜"}</td>
      <td class="pt-note">${fixed ? "固定・激レア" : ""}</td>
    </tr>`;
  }).join("");

  // ② コンボ（連鎖）倍率
  const combo = [
    ["4連鎖", "×1"], ["5", "×2"], ["6", "×4"], ["7", "×8"], ["8", "×16"],
    ["9", "×32"], ["10", "×64"], ["11", "×128"], ["12", "×256"],
    ["13", "×512"], ["14〜30", "×1024"],
  ].map(([c, m]) => `<span class="pt-chip">${c} <b>${m}</b></span>`).join("");

  // ③ 5リール配当（3/4/5個揃い）
  const reelRows = ALL_SYMBOL_IDS.map((id) => {
    const d = sym(id);
    const note =
      id === "wild" ? "代用ワイルド"
      : id === "scatter" ? "3個以上でRUSH" : "";
    // ワイルド/スキャッターはライン配当を持たない（pay:{}）ので「×undefined」を出さず「—」に
    const payCell =
      d.pay[3] != null ? `×${d.pay[3]} / ×${d.pay[4]} / ×${d.pay[5]}` : "—";
    return `<tr>
      <td class="pt-glyph" style="color:${d.color}">${d.glyph}</td>
      <td class="pt-name">${d.name}</td>
      <td class="pt-pay">${payCell}</td>
      <td class="pt-note">${note}</td>
    </tr>`;
  }).join("");

  // ④ ダブルアップ：スペシャルボーナス（3つ揃い）
  const duBonus = [...DU_LADDER].reverse().map((s) =>
    `<span class="pt-chip"><b style="color:${duColor(s)}">${duGlyph(s)}×3</b> ×${SPECIAL_BONUS[s]}</span>`
  ).join("");

  overlay.innerHTML = `
    <div class="paytable">
      <h2>遊び方 &amp; 配当表</h2>

      <h3 class="pt-h">① 3×3 DROP</h3>
      <div class="pt-modes">
        <p>同じシンボルが<b>タテ・ヨコ・ナナメ（道）</b>で3つ以上つながると消えて、上から落下→再判定で<b>連鎖</b>。配当は次の<b>3系統の合計</b>です。</p>
        <p><b>1. ラインペイ</b>：有効<b>8ライン</b>（縦3・横3・斜め2）。揃うと <b>BET×オッズ</b>。役が出るたび<b>そのシンボル以上のオッズが1段アップ</b>（次スピンでリセット）。</p>
        <p><b>2. コネクトボーナス</b>：同じシンボルが<b>3個以上隣接</b>（ライン外もOK）。<b>個数×シンボル</b>が多い/強いほど高配当（例：赤7 5個＝×100、9個＝×8000）。</p>
        <p><b>3. コンボボーナス</b>：<b>4連鎖以上</b>で連鎖倍率を加算。</p>
        <p><span class="pt-ice">🧊 氷</span>：凍ったマスは役に使えませんが、<b>となりで役が成立すると溶けて</b>連鎖がのびます。<span style="color:${DSYMBOLS.wild.color}">✨ ワイルド5</span>：全シンボルの代用。消えずに<b>最大5回</b>使えて落下します。</p>
      </div>
      <p class="pt-sub">ラインオッズ開始値（このシンボル以上が階段を上昇）</p>
      <table>${oddsRows}</table>
      <p class="pt-sub">コンボ倍率</p>
      <div class="pt-chips">${combo}</div>

      <h3 class="pt-h">② 5リール</h3>
      <div class="pt-modes">
        <p>左から連続で揃うと配当（<b>10ライン</b>）。スキャッター🌟<b>3個以上でRUSH</b>（フリースピン）。</p>
      </div>
      <table>${reelRows}</table>

      <h3 class="pt-h">③ ダブルアップ（両モード共通）</h3>
      <div class="pt-modes">
        <p>WIN後に挑戦できます。ディーラーの目より<b>強い目を3つの中から当てれば配当2倍</b>。<b>COLLECT</b>（降りる）／<b>半分かける</b>（残りはSAVEで確保）／<b>全部かける</b>から選べます（価値1のときは半分不可）。</p>
        <p>3つすべて同じ目が出ると<b>スペシャルボーナス</b>で強制終了。<b>上限なし</b>＝勝てば何度でも挑戦できます（負けると賭けた分は没収）。</p>
      </div>
      <p class="pt-sub">スペシャルボーナス（BET倍率）</p>
      <div class="pt-chips">${duBonus}</div>

      <p class="pt-foot">配当はすべて1BET（全ライン有効）。倍率はBET1枚あたりの値です。</p>
      <button class="btn primary" data-close>閉じる</button>
    </div>`;
  app.appendChild(overlay);

  const toggle = (show: boolean) => {
    sfx.resume();
    sfx.ui();
    overlay.classList.toggle("hidden", !show);
    if (show) overlay.scrollTop = 0; // 再オープン時は必ず先頭から表示
  };
  app.querySelector("[data-help]")!.addEventListener("click", () => toggle(true));
  overlay.querySelector("[data-close]")!.addEventListener("click", () => toggle(false));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) toggle(false);
  });
}

// ---- SHOP（メダルで特典を購入）------------------------------------
type ShopKey = "duRetry" | "rush" | "wild";
interface ShopItem {
  key: ShopKey;
  cost: number;
  glyph: string;
  title: string;
  desc: string;
  owned: () => boolean;
}
function buildShop(): void {
  const items: ShopItem[] = [
    {
      key: "duRetry", cost: 10_000_000, glyph: "🎫",
      title: "ダブルアップ リトライ",
      desc: "ダブルアップの負けを1回だけ取り消して、もう一度挑戦できる。",
      owned: () => state.shopDuRetry,
    },
    {
      key: "rush", cost: 8_000_000, glyph: "7️⃣",
      title: "セブンラッシュ 強制突入",
      desc: "次の 3×3 DROP ゲームで必ずセブンラッシュに突入！",
      owned: () => state.shopRush,
    },
    {
      key: "wild", cost: 1_000_000, glyph: "✨",
      title: "ワイルド5 確定",
      desc: "次の 3×3 DROP ゲームで必ずワイルド5が出現！",
      owned: () => state.shopWild,
    },
  ];

  const overlay = document.createElement("div");
  overlay.className = "paytable-overlay shop-overlay hidden";
  app.appendChild(overlay);

  const render = (): void => {
    const rows = items
      .map((it) => {
        const owned = it.owned();
        const afford = state.canAfford(it.cost);
        const btn = owned
          ? `<button class="btn shop-buy owned" disabled>セット済み</button>`
          : `<button class="btn primary shop-buy" data-buy="${it.key}"${afford ? "" : " disabled"}>買う</button>`;
        return `<div class="shop-item${owned ? " is-owned" : ""}">
          <div class="shop-ico">${it.glyph}</div>
          <div class="shop-body">
            <div class="shop-title">${it.title}</div>
            <div class="shop-desc">${it.desc}</div>
            <div class="shop-cost">${it.cost.toLocaleString()} <span>メダル</span></div>
          </div>
          ${btn}
        </div>`;
      })
      .join("");
    overlay.innerHTML = `
      <div class="paytable shop">
        <h2>🛒 SHOP</h2>
        <div class="shop-balance">所持メダル <b data-shop-balance>${Math.floor(state.credits).toLocaleString()}</b></div>
        <div class="shop-list">${rows}</div>
        <button class="btn primary" data-close>閉じる</button>
      </div>`;
    overlay.querySelector("[data-close]")!.addEventListener("click", () => toggle(false));
    overlay.querySelectorAll<HTMLButtonElement>("[data-buy]").forEach((b) =>
      b.addEventListener("click", () => buy(b.dataset.buy as ShopKey))
    );
  };

  const toggle = (show: boolean): void => {
    sfx.resume();
    sfx.ui();
    if (show) render();
    overlay.classList.toggle("hidden", !show);
    if (show) overlay.scrollTop = 0; // 再オープン時は先頭から
  };

  const buy = (key: ShopKey): void => {
    const it = items.find((i) => i.key === key)!;
    if (it.owned() || !state.spend(it.cost)) {
      sfx.deny();
      haptics.deny();
      return;
    }
    if (key === "duRetry") state.shopDuRetry = true;
    else if (key === "rush") state.shopRush = true;
    else state.shopWild = true;
    state.save();
    sfx.bonus();
    haptics.bonus();
    hud.update();
    render();
    void effects.banner(`🛒 ${it.title} を購入！`, 1400);
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) toggle(false);
  });
  // 大会ページ(taikai.html)にはSHOPボタンが無い
  app.querySelector("[data-shop]")?.addEventListener("click", () => {
    if (busy || state.inRush || autoPlay || state.inEvent) return; // 大会中はSHOP禁止
    toggle(true);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 勝利の余韻など「見せる待ち時間」。大会中は回転数を稼げるよう短縮する。 */
function pace(ms: number): Promise<void> {
  return wait(eventUI.active ? Math.ceil(ms * 0.55) : ms);
}

hud.setMuted(sfx.muted);
hud.setDu(state.duEnabled);

// dev検証用ハンドル（vite devサーバーでのみ有効）
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __dev?: unknown }).__dev = { state, eventUI, hud };
}
