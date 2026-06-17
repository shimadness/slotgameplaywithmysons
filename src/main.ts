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
import {
  play as dropPlay,
  payoutScaleFor,
  RUSH_MULTIPLIER,
  RUSH_PLAYS,
  RUSH_MAX_SPINS,
} from "./game/drop";
import { Sfx } from "./audio/sfx";
import { Board } from "./ui/board";
import { DropBoard } from "./ui/dropBoard";
import { Effects } from "./ui/effects";
import { Hud } from "./ui/hud";
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
        <button class="settei-btn" data-settei title="ペイアウト率の設定（1〜6）">
          設定 <b data-settei-n>4</b><small data-settei-rtp>95%</small>
        </button>
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

// ---- モード切替 ----------------------------------------------------
app.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (busy || state.inRush || autoPlay) return;
    const next = btn.dataset.mode as Mode;
    if (next === mode) return;
    sfx.resume();
    sfx.ui();
    mode = next;
    app.querySelectorAll(".mode-btn").forEach((b) =>
      b.classList.toggle("active", b === btn)
    );
    board.el.classList.toggle("hidden", mode !== "slot");
    dropBoard.el.classList.toggle("hidden", mode !== "drop");
  });
});

// ---- 設定（ペイアウト率 1〜6）切替 ----------------------------------
const setteiBtn = app.querySelector("[data-settei]") as HTMLButtonElement;
const setteiNEl = app.querySelector("[data-settei-n]") as HTMLElement;
const setteiRtpEl = app.querySelector("[data-settei-rtp]") as HTMLElement;
function updateSetteiLabel(): void {
  setteiNEl.textContent = String(state.settei);
  setteiRtpEl.textContent = `${Math.round(state.targetRtp * 100)}%`;
}
updateSetteiLabel();
setteiBtn.addEventListener("click", () => {
  if (busy || state.inRush || autoPlay) return;
  sfx.resume();
  sfx.ui();
  state.setSettei((state.settei % 6) + 1); // 1→2→…→6→1 と循環
  updateSetteiLabel();
  void effects.banner(`設定 ${state.settei}（払出 ${Math.round(state.targetRtp * 100)}%）`, 1100);
});

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
    if (!state.inRush) void effects.banner("クレジット不足", 1200);
    return;
  }

  busy = true;
  hud.setBusy(true);
  state.lastWin = 0;
  state.placeBet();
  hud.update();

  const rushMult = state.inRush ? state.rushMultiplier : 1;
  const result = dropPlay(state.lineBet, rushMult, payoutScaleFor(state.settei));

  sfx.startSpin();

  let running = 0;
  await dropBoard.run(result, {
    onReelStop: () => sfx.reelStop(),
    onAllReelsStopped: () => sfx.stopSpin(),
    onStep: (step) => {
      sfx.chain(step.chain);
      running += step.stepWin;
      state.lastWin = running;
      hud.update();
      effects.burst(
        Math.min(10 + step.chain * 8, 60),
        [...step.clusters.map((c) => sym(c.symbol).color), "#fff"]
      );
      if (step.chain >= 2 && step.stepWin > 0) {
        effects.popChain(step.chain, step.stepWin);
      }
    },
  });

  if (result.totalWin > 0) {
    const big = result.totalWin >= state.totalBet * 15 || result.maxChain >= 4;
    effects.popWin(result.totalWin, big);
    if (big) sfx.winBig();
    else sfx.winSmall();
    state.addWin(result.totalWin);
    if (state.inRush) rushWinTotal += result.totalWin;
    hud.animateWin(result.totalWin);
    await wait(big ? 1200 : 650);
  } else {
    await wait(200);
  }

  // 連鎖で RUSH 突入 / 上乗せ
  if (result.triggeredRush) {
    if (state.inRush) {
      // 上乗せは1RUSHの総スピン上限まで（暴走＝出すぎ防止）
      const room = RUSH_MAX_SPINS - state.freeSpinsTotal;
      if (room > 0) {
        const add = Math.min(RUSH_PLAYS, room);
        state.retriggerRush(add);
        sfx.bonus();
        await effects.banner(`RUSH 上乗せ +${add}`, 1500);
      }
    } else {
      rushWinTotal = 0;
      state.startRush(RUSH_PLAYS, RUSH_MULTIPLIER);
      enterRushFx();
      sfx.bonus();
      await effects.rushBanner(RUSH_PLAYS, RUSH_MULTIPLIER);
    }
    hud.update();
  }

  busy = false;
  hud.setBusy(false);
  hud.update();

  if (state.inRush) {
    if (state.freeSpins > 0) setTimeout(() => void play(), 1000);
    else await finishRush();
  }
  if (!state.inRush) maybeAutoNext();
}

// ===================================================================
// 5リール モード
// ===================================================================
async function playSlot(): Promise<void> {
  if (busy) return;
  sfx.resume();
  if (!state.canSpin()) {
    sfx.deny();
    if (!state.inRush) void effects.banner("クレジット不足", 1200);
    return;
  }

  busy = true;
  hud.setBusy(true);
  state.lastWin = 0;
  state.placeBet();
  hud.update();

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
    if (big) sfx.winBig();
    else sfx.winSmall();
    state.addWin(ev.total);
    if (state.inRush) rushWinTotal += ev.total;
    hud.animateWin(ev.total);
    await wait(big ? 1400 : 850);
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
        <div class="player-credits">CREDIT <b>${p.credits.toLocaleString()}</b></div>
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
      updateSetteiLabel();
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
  const overlay = document.createElement("div");
  overlay.className = "paytable-overlay hidden";
  const rows = ALL_SYMBOL_IDS.map((id) => {
    const d = sym(id);
    const note =
      id === "wild"
        ? "ワイルドファイブ：代用ワイルド。DROPは消えずに最大5回使えて落下"
        : id === "scatter"
        ? "5リール: 3個以上でRUSH（総BET倍率）"
        : "";
    return `<tr>
      <td class="pt-glyph" style="color:${d.color}">${d.glyph}</td>
      <td class="pt-name">${d.name}</td>
      <td class="pt-pay">×${d.pay[3]} / ×${d.pay[4]} / ×${d.pay[5]}</td>
      <td class="pt-note">${note}</td>
    </tr>`;
  }).join("");
  overlay.innerHTML = `
    <div class="paytable">
      <h2>遊び方 &amp; 配当表</h2>
      <div class="pt-modes">
        <p><b>3×3 DROP</b>：同じシンボルが<b>タテ・ヨコ・ナナメ（道）</b>で3つ以上つながると配当→消えて上から落下（ドロップ）→再判定で<b>連鎖</b>。連鎖が伸びるほど倍率UP、6連鎖以上で<b>RUSH</b>突入。</p>
        <p><b>5リール</b>：左から連続で揃うと配当（10ライン）。スキャッター🌟3つ以上でRUSH。</p>
        <p class="pt-rtp">ヘッダーの<b>「設定」</b>でペイアウト率を 1（90%）〜6（97%）に変更できます。</p>
      </div>
      <table>${rows}</table>
      <p class="pt-foot">配当倍率は 3個 / 4個 / 5個揃い（ラインBET倍率）。DROPはクラスターサイズ×連鎖倍率×設定で決まります。</p>
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
