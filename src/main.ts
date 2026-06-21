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
import { DU_LADDER, SPECIAL_BONUS, UPPER_CAP, duGlyph, duColor } from "./game/doubleup";
import { Sfx } from "./audio/sfx";
import { Board } from "./ui/board";
import { DropBoard } from "./ui/dropBoard";
import { Effects } from "./ui/effects";
import { Hud } from "./ui/hud";
import { DoubleUp } from "./ui/doubleup";
import { haptics } from "./native/haptics";
import { installFitScreen } from "./ui/fitScreen";
import { ALL_SYMBOL_IDS, sym, type SymbolId } from "./game/symbols";

type Mode = "drop" | "slot";

const app = document.getElementById("app")!;
const engine = new ReelEngine();
const state = new GameState();
const sfx = new Sfx();

// ---- レイアウト ----------------------------------------------------
app.innerHTML = `
  <div class="cabinet">
    <header class="title">
      <h1>TRIPLE <span>SLOT</span></h1>
      <div class="header-tools">
        <button class="player-btn" data-player title="プレイヤーを切り替え">
          👤 <b data-player-name>プレイヤー1</b>
        </button>
        <div class="mode-switch">
          <button class="mode-btn active" data-mode="drop">3×3 DROP</button>
          <button class="mode-btn" data-mode="slot">5リール</button>
        </div>
        <button class="paytable-btn" data-help>配当表</button>
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

const effects = new Effects(machine, board);
const doubleUp = new DoubleUp(sfx);
app.appendChild(doubleUp.el);

// 勝利の精算。AUTO中も含めてダブルアップに移行（最終額を addWin）。
// RUSH（フリースピン）中だけは自動 COLLECT（ダブルアップをスキップ）。
async function resolveWin(win: number): Promise<void> {
  if (win <= 0) return;
  // 既に上限超のWINはダブルアップに入れず自動COLLECT（ダブルアップは価値>UPPER_CAPで強制終了のため入口でも弾く）
  if (state.inRush || win > UPPER_CAP) {
    state.addWin(win);
    hud.animateWin(win);
    return;
  }
  busy = true; // ダブルアップ中はスピン禁止
  const final = await doubleUp.start(win, state.bet);
  state.addWin(final);
  hud.animateWin(final);
  hud.update();
}

let playerOverlay: HTMLElement;
let mode: Mode = "drop";
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
    state.cycleLineBet();
    hud.update();
  },
  onMaxBet: () => {
    if (busy || state.inRush) return;
    sfx.resume();
    sfx.ui();
    state.setMaxBet();
    hud.update();
  },
  onAddBet: (n) => {
    if (busy || state.inRush) return;
    sfx.resume();
    sfx.ui();
    state.addBet(n);
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
    sfx.resume();
    sfx.ui();
    setAuto(!autoPlay);
    if (autoPlay && !busy && !state.inRush) void play();
  },
  onRefill: () => {
    sfx.resume();
    sfx.ui();
    state.refill();
    hud.update();
  },
});
app.querySelector(".cabinet")!.appendChild(hud.el);

// 画面に必ず1画面で収める（小型端末/ネイティブWebView対策の安全網）
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
    state.mode = next; // ベット構造（単一 or 10ライン）を切替
    app.querySelectorAll(".mode-btn").forEach((b) =>
      b.classList.toggle("active", b === btn)
    );
    board.el.classList.toggle("hidden", mode !== "slot");
    dropBoard.el.classList.toggle("hidden", mode !== "drop");
    hud.update(); // TOTAL BET 表示を更新
  });
});

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
  if (busy || state.inRush || autoPlay) return;
  sfx.resume();
  sfx.ui();
  openPlayerPicker();
});
if (state.firstRun) openPlayerPicker(); // 初回はプレイヤー選択を出す

buildPaytable();

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
  sfx.resume();
  if (!state.canSpin()) {
    sfx.deny();
    haptics.deny();
    if (!state.inRush) void effects.banner("メダル不足", 1200);
    return;
  }

  busy = true;
  hud.setBusy(true);
  state.lastWin = 0;
  state.placeBet();
  hud.update();
  haptics.spin();

  const inRush = state.inRush; // このスピン開始時点でラッシュ中か
  const result = dropPlay(state.bet, undefined, inRush); // ラッシュ中は7大量プール

  sfx.startSpin();

  let running = 0;
  await dropBoard.run(result, {
    onReelStop: () => sfx.reelStop(),
    onAllReelsStopped: () => sfx.stopSpin(),
    onReach: () => { sfx.reach(); void effects.banner("リーチ！", 900); },
    onStep: (step) => {
      sfx.chain(step.chain);
      if (step.lineWins.length > 0) sfx.lineWin(); // ライン成立＝サンプル音
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
    await wait(inRush ? (big ? 700 : 400) : (big ? 1900 : 1500));
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
    enterRushFx();
    sfx.bonus();
    haptics.rush();
    await effects.banner(`★ セブンラッシュ 突入！ ${SEVEN_RUSH_GAMES}ゲーム ★`, 1900);
    hud.update();
  }

  busy = false;
  hud.setBusy(false);
  hud.update();

  if (state.inRush) {
    if (state.freeSpins > 0) setTimeout(() => void play(), 1000);
    else await finishDropRush();
  } else {
    maybeAutoNext();
  }
}

async function finishDropRush(): Promise<void> {
  const total = rushWinTotal;
  state.endRush();
  exitRushFx();
  hud.setBusy(false); // SPINボタンの表示を "RUSH SPIN" → "SPIN" に戻す
  hud.update();
  sfx.winBig();
  effects.burst(160);
  await effects.banner(`セブンラッシュ 終了！ 獲得 ${total.toLocaleString()}`, 2400);
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
  sfx.resume();
  if (!state.canSpin()) {
    sfx.deny();
    haptics.deny();
    if (!state.inRush) void effects.banner("メダル不足", 1200);
    return;
  }

  busy = true;
  hud.setBusy(true);
  state.lastWin = 0;
  state.placeBet();
  hud.update();
  haptics.spin();

  const { grid, stops } = engine.spin();
  const multiplier = state.inRush ? state.rushMultiplier : 1;
  const ev = evaluate(grid, state.lineBet, state.totalBet, multiplier);
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
    effects.popWin(ev.total, big);
    if (big) { sfx.winBig(); haptics.winBig(); }
    else { sfx.winSmall(); haptics.winSmall(); }
    if (state.inRush) rushWinTotal += ev.total;
    await wait(big ? 2000 : 1600); // WIN を見せてからダブルアップへ（+1秒）
    await resolveWin(ev.total); // ダブルアップ → addWin（RUSH中は自動collect）
    await wait(300);
  } else {
    await wait(250);
  }

  if (ev.scatter?.triggersBonus) {
    const fs = freeSpinsFor(ev.scatter.count);
    if (state.inRush) {
      state.retriggerRush(fs);
      sfx.bonus();
      await effects.banner(`RUSH 上乗せ +${fs}`, 1600);
    } else {
      const mult = ev.scatter.count >= 5 ? 5 : ev.scatter.count === 4 ? 3 : 2;
      rushWinTotal = 0;
      state.startRush(fs, mult);
      enterRushFx();
      sfx.bonus();
      await effects.rushBanner(fs, mult);
    }
    hud.update();
  }
}

async function finishRush(): Promise<void> {
  const total = rushWinTotal;
  state.endRush();
  exitRushFx();
  hud.setBusy(false); // SPINボタンの表示を "RUSH SPIN" → "SPIN" に戻す
  hud.update();
  sfx.winBig();
  effects.burst(160);
  await effects.banner(`RUSH 終了！ 獲得 ${total.toLocaleString()}`, 2400);
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
    cherry: "チェリー", orange: "オレンジ", plum: "プラム", banana: "バナナ",
    melon: "メロン", bell: "ベル", bar: "BAR", bar2: "BAR²", bar3: "BAR³",
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
    return `<tr>
      <td class="pt-glyph" style="color:${d.color}">${d.glyph}</td>
      <td class="pt-name">${d.name}</td>
      <td class="pt-pay">×${d.pay[3]} / ×${d.pay[4]} / ×${d.pay[5]}</td>
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
        <p>3つすべて同じ目が出ると<b>スペシャルボーナス</b>で強制終了。価値が <b>${UPPER_CAP.toLocaleString()}</b> を超えると強制COLLECT。</p>
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
  };
  app.querySelector("[data-help]")!.addEventListener("click", () => toggle(true));
  overlay.querySelector("[data-close]")!.addEventListener("click", () => toggle(false));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) toggle(false);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

hud.setMuted(sfx.muted);
