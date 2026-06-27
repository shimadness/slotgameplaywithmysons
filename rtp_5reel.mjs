// 5リール（TENGU KING化）RTP 計測ハーネス。
// 左詰め全リール方式＋ワイルド花火倍率＋天狗フリーゲームを再現。
//
// 実機は ReelEngine が起動時にランダムな帯を1セット作って固定する＝プレイヤー毎に
// RTPがブレる。そこで「多数セッション（＝多数の帯セット）」を回し、全体平均RTPと
// セッション間のブレ幅（min/max）を出す。シードで再現性あり。
//
// 使い方: npx tsx rtp_5reel.mjs [spinsPerSession] [sessions] [payScale]
import { ReelEngine } from "./src/game/engine.ts";
import { evaluate, freeSpinsFor } from "./src/game/paylines.ts";

const SPINS = Number(process.argv[2] ?? 200_000);
const SESSIONS = Number(process.argv[3] ?? 40);
const PAY_SCALE = Number(process.argv[4] ?? 1); // 一時：配当一律スケール（RTPは線形）
const BET = 1;
const RETRIGGER = false; // フリー中リトリガー（設計§7未決定）→既定off

// --- 再現可能な PRNG（mulberry32）。Math.random を差し替える ---
let _state = 0x9e3779b9;
function seed(n) {
  _state = n >>> 0;
}
Math.random = function () {
  _state |= 0;
  _state = (_state + 0x6d2b79f5) | 0;
  let t = Math.imul(_state ^ (_state >>> 15), 1 | _state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// 全体集計
let totalCost = 0,
  totalWin = 0,
  baseWinNoMult = 0,
  wildAddedWin = 0,
  freeGameWin = 0;
let winningSpins = 0,
  wildSpins = 0,
  entries = 0,
  freeSpins = 0,
  paidSpins = 0;
let maxWin = 0;
const sessionRTPs = [];

function runSpin(engine, intoFree) {
  const { grid } = engine.spin();
  const ev = evaluate(grid, BET, 1);
  const total = ev.total * PAY_SCALE;
  const base = ev.baseWin * PAY_SCALE;
  totalWin += total;
  if (intoFree) freeGameWin += total;
  baseWinNoMult += base;
  wildAddedWin += total - base;
  if (total > 0) winningSpins++;
  if (ev.wildMults.length > 0) wildSpins++;
  if (total > maxWin) maxWin = total;
  return ev;
}

for (let s = 0; s < SESSIONS; s++) {
  seed(0x1234 + s * 0x9e37); // セッション毎に別シード＝別の帯セット
  const engine = new ReelEngine();
  let sCost = 0,
    sWin = 0;
  for (let i = 0; i < SPINS; i++) {
    totalCost += BET;
    sCost += BET;
    paidSpins++;
    const ev = runSpin(engine, false);
    sWin += ev.total * PAY_SCALE;
    if (ev.scatter?.triggersBonus) {
      entries++;
      engine.setFreeMode(true); // フリー帯（ワイルド多め）
      let free = freeSpinsFor(ev.scatter.count);
      while (free > 0) {
        free--;
        freeSpins++;
        const r = runSpin(engine, true);
        sWin += r.total * PAY_SCALE;
        if (RETRIGGER && r.scatter?.triggersBonus)
          free += freeSpinsFor(r.scatter.count);
      }
      engine.setFreeMode(false); // 通常帯へ
    }
  }
  sessionRTPs.push((sWin / sCost) * 100);
}

sessionRTPs.sort((a, b) => a - b);
const pct = (x) => +(x * 100).toFixed(2);
const f2 = (x) => +x.toFixed(2);
console.log(
  JSON.stringify(
    {
      spinsPerSession: SPINS,
      sessions: SESSIONS,
      payScale: PAY_SCALE,
      RTP_mean_percent: pct(totalWin / totalCost),
      RTP_session_min_percent: f2(sessionRTPs[0]),
      RTP_session_median_percent: f2(sessionRTPs[Math.floor(SESSIONS / 2)]),
      RTP_session_max_percent: f2(sessionRTPs[SESSIONS - 1]),
      wildMultShare_percent: pct(wildAddedWin / totalWin),
      freeShare_percent: pct(freeGameWin / totalWin),
      hitRate_percent: pct(winningSpins / paidSpins),
      wildHitRate_percent: pct(wildSpins / paidSpins),
      freeEntryRate_percent: +((entries / paidSpins) * 100).toFixed(3),
      spinsPerEntry: +(paidSpins / Math.max(1, entries)).toFixed(0),
      maxWin_xBet: f2(maxWin / BET),
    },
    null,
    2
  )
);
