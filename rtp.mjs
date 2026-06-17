// DROP モード RTP（ペイアウト率）計測。main.ts の進行＋RUSH上限を再現。
// 使い方: npx tsx rtp.mjs [payoutScale]   （省略時 1.0 = 素のRTP）
import {
  play,
  RUSH_PLAYS,
  RUSH_MULTIPLIER,
  RUSH_MAX_SPINS,
} from "./src/game/drop.ts";

const scale = Number(process.argv[2] ?? 1);
const LINE_COUNT = 10;
const lineBet = 1;
const COST = lineBet * LINE_COUNT;

const PAID_SPINS = 1_500_000;
let totalCost = 0;
let totalWin = 0;
let baseWin = 0;
let rushWin = 0;
let rushEntries = 0;
let rushSpins = 0;
let winningSpins = 0;

for (let i = 0; i < PAID_SPINS; i++) {
  totalCost += COST;
  const res = play(lineBet, 1, scale);
  totalWin += res.totalWin;
  baseWin += res.totalWin;
  if (res.totalWin > 0) winningSpins++;

  if (res.triggeredRush) {
    rushEntries++;
    let awarded = RUSH_PLAYS;
    let free = RUSH_PLAYS;
    while (free > 0) {
      free--;
      rushSpins++;
      const r = play(lineBet, RUSH_MULTIPLIER, scale);
      totalWin += r.totalWin;
      rushWin += r.totalWin;
      if (r.triggeredRush && awarded < RUSH_MAX_SPINS) {
        const add = Math.min(RUSH_PLAYS, RUSH_MAX_SPINS - awarded);
        awarded += add;
        free += add;
      }
    }
  }
}

const pct = (x) => +(x * 100).toFixed(1);
console.log(JSON.stringify({
  payoutScale: scale,
  RTP_percent: pct(totalWin / totalCost),
  baseRTP_percent: pct(baseWin / totalCost),
  rushRTP_percent: pct(rushWin / totalCost),
  rushShare_percent: pct(rushWin / totalWin),
  rushEntryRate_percent: +((rushEntries / PAID_SPINS) * 100).toFixed(2),
  avgRushSpinsPerEntry: +(rushSpins / Math.max(1, rushEntries)).toFixed(1),
  hitRate_percent: pct(winningSpins / PAID_SPINS),
}, null, 2));
