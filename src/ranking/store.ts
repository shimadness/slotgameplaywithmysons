// ===== ランキング ストア（Firebase RTDB ＋ ローカルキャッシュ）========
// 全プラットフォーム共有の TOP10 を読み書きする層。
// 方針: ゲームを絶対に止めない。通信失敗時は throw せず、
//       ローカルキャッシュにフォールバックする（オフラインでも遊べる）。
import { db } from "./firebase";
import {
  ref,
  query,
  orderByChild,
  limitToLast,
  get,
  push,
} from "firebase/database";

export type RankMode = "drop" | "slot";

export interface RankEntry {
  id?: string; // RTDB の pushId（自分のエントリ強調用）
  name: string;
  score: number;
  bet: number;
  mode: RankMode;
  at: number; // epoch ms
}

export const TOP_N = 10;
export const NAME_MAX = 12;

const cacheKey = (m: RankMode) => `triple-slot.rank.${m}`;

function readCache(mode: RankMode): RankEntry[] {
  try {
    const raw = localStorage.getItem(cacheKey(mode));
    return raw ? (JSON.parse(raw) as RankEntry[]) : [];
  } catch {
    return [];
  }
}

function writeCache(mode: RankMode, list: RankEntry[]): void {
  try {
    localStorage.setItem(cacheKey(mode), JSON.stringify(list));
  } catch {
    /* localStorage 不可環境は無視 */
  }
}

function sortDesc(list: RankEntry[]): RankEntry[] {
  // スコア降順。同点は古い登録（at 昇順）を上位に。
  return [...list].sort((a, b) => b.score - a.score || a.at - b.at).slice(0, TOP_N);
}

/** TOP10 を取得。オンライン成功時はキャッシュ更新、失敗時はキャッシュを返す。 */
export async function fetchTop(mode: RankMode): Promise<RankEntry[]> {
  try {
    const q = query(ref(db, mode), orderByChild("score"), limitToLast(TOP_N));
    const snap = await get(q);
    const out: RankEntry[] = [];
    snap.forEach((child) => {
      const v = child.val() as Omit<RankEntry, "id">;
      out.push({ ...v, mode, id: child.key ?? undefined });
    });
    const top = sortDesc(out);
    writeCache(mode, top);
    return top;
  } catch {
    return sortDesc(readCache(mode));
  }
}

/**
 * 与えられたスコアが TOP10 入りするか判定し、予想順位（1始まり）を返す。
 * ランク外なら rank=null。判定に使った top も返す（モーダル表示用）。
 */
export async function checkRankIn(
  mode: RankMode,
  score: number
): Promise<{ rank: number | null; top: RankEntry[] }> {
  const top = await fetchTop(mode);
  if (score <= 0) return { rank: null, top };
  // 自分より「厳密に上」の件数 + 1 が順位（同点は下に付ける）。
  const above = top.filter((e) => e.score > score).length;
  const rank = above + 1;
  const qualifies = rank <= TOP_N && (top.length < TOP_N || score > top[top.length - 1].score);
  return { rank: qualifies ? rank : null, top };
}

/**
 * ランキングに登録。成功時は採番された id を含むエントリを、
 * 失敗時は null を返す（呼び出し側はローカルにだけ残す等の判断が可能）。
 */
export async function submit(
  entry: Omit<RankEntry, "id" | "at">
): Promise<RankEntry | null> {
  const full: RankEntry = { ...entry, at: Date.now() };
  // 楽観的にローカルキャッシュへ反映（オフラインでも自分の記録は見える）。
  writeCache(entry.mode, sortDesc([...readCache(entry.mode), full]));
  try {
    const r = await push(ref(db, entry.mode), {
      name: full.name,
      score: full.score,
      bet: full.bet,
      mode: full.mode,
      at: full.at,
    });
    return { ...full, id: r.key ?? undefined };
  } catch {
    return null; // 通信失敗。ローカルキャッシュには残っている。
  }
}

export function sanitizeName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}
