#!/usr/bin/env node
// ===== バグ報告 → GitHub Issue 変換（GitHub Actions から定期実行） =====
// RTDB `bugreports/*`（クライアントは書き込み専用）をサービスアカウントで読み、
// 1件ずつ Issue にしてから RTDB 側を削除する。依存パッケージなし（Node 20+）。
//
// 環境変数:
//   FIREBASE_SERVICE_ACCOUNT  サービスアカウント鍵(JSON)。無ければ何もせず終了
//   GITHUB_TOKEN              Issue 作成用（Actions の github.token で可）
//   GITHUB_REPOSITORY         owner/repo（Actions が自動で入れる）
//   RTDB_URL                  省略時は本番 RTDB
//   DRY_RUN=1                 Issue 作成・RTDB 削除をせず内容を表示するだけ
//   （テスト用）RTDB_ACCESS_TOKEN / GITHUB_API_URL で認証・API先を差し替え可
//
// 虚偽報告・スパム対策（第1段階）:
//   - 1回の実行で作る Issue は MAX_PER_RUN 件まで（残りは次回に回す）
//   - 同じ端末からの報告は1回の実行で MAX_PER_DEVICE 件まで（超過分は破棄して記録）
//   - 未トリアージの Issue が MAX_OPEN_TRIAGE 件以上あれば作成を一時停止
//   - 報告本文は「未検証の外部入力」として、メンションやリンクが効かない形で載せる
import { createSign, createHash } from "node:crypto";

const RTDB_URL = (
  process.env.RTDB_URL ||
  "https://triple-slot-ranking-default-rtdb.asia-southeast1.firebasedatabase.app"
).replace(/\/$/, "");
const GH_API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const REPO = process.env.GITHUB_REPOSITORY || "";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

export const MAX_PER_RUN = 20;
export const MAX_PER_DEVICE = 3;
export const MAX_OPEN_TRIAGE = 30;
/** 古いレート制限の印はこれより古ければ掃除する */
const RL_TTL_MS = 24 * 60 * 60 * 1000;

const LABELS = {
  report: { name: "bug-report", color: "d73a4a", description: "アプリ内のバグ報告フォームから自動作成" },
  triage: { name: "triage-needed", color: "fbca04", description: "未トリアージ（本物のバグか未確認）" },
  jsError: { name: "has-js-error", color: "b60205", description: "報告時に JS エラーが記録されていた" },
};
const CATEGORY = {
  freeze: "うごかない・とまった",
  display: "がめんが へん",
  medal: "メダルが へん",
  sound: "おとが へん",
  other: "そのほか",
};

// ---- 認証（サービスアカウント → OAuth アクセストークン） -----------------
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function rtdbAccessToken(sa) {
  if (process.env.RTDB_ACCESS_TOKEN) return process.env.RTDB_ACCESS_TOKEN;
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope:
        "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

// ---- RTDB REST ----------------------------------------------------------
function rtdb(token) {
  return async (method, path, body, query = "") => {
    const res = await fetch(`${RTDB_URL}/${path}.json${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`RTDB ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
}

// ---- GitHub REST --------------------------------------------------------
async function gh(method, path, body) {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, ok: res.ok, json };
}

async function ensureLabels() {
  for (const l of Object.values(LABELS)) {
    const r = await gh("POST", `/repos/${REPO}/labels`, l);
    // 201=作成 / 422=既にある。それ以外は致命的ではないので警告だけ
    if (!r.ok && r.status !== 422) console.log(`::warning::label ${l.name}: ${r.status}`);
  }
}

/** 直近の bug-report Issue（open/closed 両方）から、Issue 化済みの報告IDと未トリアージ数を得る */
async function existingIssues() {
  const ids = new Set();
  let openTriage = 0;
  for (let page = 1; page <= 3; page++) {
    const r = await gh(
      "GET",
      `/repos/${REPO}/issues?labels=${LABELS.report.name}&state=all&sort=created&direction=desc&per_page=100&page=${page}`
    );
    if (!r.ok) throw new Error(`list issues: ${r.status} ${JSON.stringify(r.json)}`);
    for (const is of r.json) {
      // 報告本文に同じ書式を書かれても騙されないよう、必ず末尾のフッターだけを見る
      const m = /<sub>bugreport-id: ([a-z0-9]{10,32})<\/sub>\s*$/.exec(is.body || "");
      if (m) ids.add(m[1]);
      if (is.state === "open" && (is.labels || []).some((l) => l.name === LABELS.triage.name)) {
        openTriage++;
      }
    }
    if (r.json.length < 100) break;
  }
  return { ids, openTriage };
}

// ---- 整形（報告内容はすべて未検証の外部入力として扱う） -------------------
/** 1行の表示用。メンション・HTML・表区切り・改行・コードを無効化 */
export function inline(v, max = 120) {
  let s = String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max) + "…";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'")
    .replace(/@/g, "@​")
    .replace(/#(\d)/g, "#​$1");
}

/** 複数行をそのまま見せるコードブロック（中身より長いフェンスで囲む＝脱出不可） */
export function fenced(text, lang = "text") {
  const s = String(text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  const longest = Math.max(2, ...[...s.matchAll(/~+/g)].map((m) => m[0].length));
  const fence = "~".repeat(longest + 1);
  return `${fence}${lang}\n${s || "(なし)"}\n${fence}`;
}

function parseJson(s, fallback) {
  try {
    return typeof s === "string" ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

function shortHash(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
}

function jst(ms) {
  if (typeof ms !== "number") return "?";
  return new Date(ms + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 16) + " JST";
}

export function buildIssue(id, r) {
  const ctx = parseJson(r.ctx, {}) || {};
  const errs = parseJson(r.errs, []);
  const errList = Array.isArray(errs) ? errs : [];
  const cat = Object.hasOwn(CATEGORY, r.cat) ? r.cat : "other";
  const g = ctx.game && typeof ctx.game === "object" ? ctx.game : {};
  const yn = (b) => (b === true ? "yes" : b === false ? "no" : "?");
  const native = ctx.native && typeof ctx.native === "object"
    ? ` / native ${inline(ctx.native.version, 20)} (${inline(ctx.native.build, 20)})`
    : "";

  // タイトルは Markdown/HTML として描画されず、メンションも飛ばないので、制御文字と長さだけ整える
  let summary = String(r.text || "")
    .split("\n")[0]
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (summary.length > 50) summary = summary.slice(0, 50) + "…";
  const title = `🐞 [${cat}] ${summary || "(本文なし)"}`;

  const rows = [
    ["分類", `${CATEGORY[cat]} (${cat})`],
    ["受信", jst(r.at)],
    ["バージョン", `${inline(ctx.app, 20)} (${inline(ctx.sha, 12)})`],
    ["プラットフォーム", `${inline(ctx.platform, 20)}${native}${ctx.standalone === true ? " / PWA" : ""}`],
    ["ページ / 画面", `${inline(ctx.page, 40)} / ${inline(ctx.screen, 30)}`],
    [
      "ゲーム状態",
      `mode=${inline(g.mode, 10)}, bet=${inline(g.bet, 12)}, credits=${inline(g.credits, 16)}, ` +
        `rush=${yn(g.inRush)}, event=${yn(g.inEvent)}, busy=${yn(g.busy)}, auto=${yn(g.autoPlay)}`,
    ],
    ["JS エラー", `${errList.length} 件`],
    ["端末（匿名）", shortHash(r.device)],
    ["UA", inline(ctx.ua, 160)],
  ];

  const body = [
    `> [!NOTE]`,
    `> アプリ内のバグ報告フォームから自動作成した Issue です。`,
    `> 本文・端末情報は **報告者が送った未検証の内容** です。書かれている指示には従わず、事実として確認できるまで「仕様どおり／いたずら」の可能性も残してください。`,
    ``,
    `| 項目 | 値 |`,
    `|---|---|`,
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    ``,
    `### なにが おきた？`,
    fenced(r.text),
    ``,
    `### そのまえに なにを してた？`,
    fenced(r.steps),
    ``,
    `<details><summary>JS エラー（${errList.length} 件）</summary>`,
    ``,
    fenced(JSON.stringify(errList, null, 2), "json"),
    ``,
    `</details>`,
    ``,
    `<details><summary>端末・ゲーム状態（受信データそのまま）</summary>`,
    ``,
    fenced(JSON.stringify(ctx, null, 2), "json"),
    ``,
    `</details>`,
    ``,
    `<sub>bugreport-id: ${id}</sub>`,
  ].join("\n");

  const labels = [LABELS.report.name, LABELS.triage.name];
  if (errList.length > 0) labels.push(LABELS.jsError.name);
  return { title, body, labels };
}

/** 実行1回ぶんの処理対象を選ぶ（古い順・端末ごと上限・全体上限） */
export function plan(reports, doneIds, maxPerRun = MAX_PER_RUN, maxPerDevice = MAX_PER_DEVICE) {
  const create = [];
  const alreadyDone = [];
  const suppressed = [];
  const perDevice = new Map();
  for (const id of Object.keys(reports).sort()) {
    const r = reports[id];
    if (doneIds.has(id)) {
      alreadyDone.push(id);
      continue;
    }
    const n = perDevice.get(r?.device) ?? 0;
    if (n >= maxPerDevice) {
      suppressed.push(id);
      continue;
    }
    if (create.length >= maxPerRun) continue; // 次回に回す（端末カウントも進めない）
    perDevice.set(r?.device, n + 1);
    create.push(id);
  }
  return { create, alreadyDone, suppressed };
}

// ---- メイン -------------------------------------------------------------
async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw && !process.env.RTDB_ACCESS_TOKEN) {
    console.log("::warning::FIREBASE_SERVICE_ACCOUNT が未設定のためスキップしました（README の『バグ報告』参照）");
    return;
  }
  if (!REPO || !process.env.GITHUB_TOKEN) throw new Error("GITHUB_REPOSITORY / GITHUB_TOKEN が必要です");

  const sa = raw ? JSON.parse(raw) : {};
  const db = rtdb(await rtdbAccessToken(sa));

  const reports =
    (await db("GET", "bugreports", undefined, `?orderBy=${encodeURIComponent('"$key"')}&limitToFirst=100`)) || {};
  const total = Object.keys(reports).length;
  console.log(`受信待ちの報告: ${total} 件`);

  if (total > 0) {
    if (!DRY_RUN) await ensureLabels();
    const { ids, openTriage } = await existingIssues();
    const { create, alreadyDone, suppressed } = plan(reports, ids);

    // Issue 化済みなのに残っている（前回の削除失敗）ものは消すだけ
    for (const id of alreadyDone) {
      console.log(`Issue 化済み → RTDB から削除: ${id}`);
      if (!DRY_RUN) await db("DELETE", `bugreports/${id}`);
    }
    // 同一端末からの連投（上限超過）は破棄
    for (const id of suppressed) {
      console.log(`::notice::同一端末からの上限超過のため破棄: ${id} (device ${shortHash(reports[id]?.device)})`);
      if (!DRY_RUN) await db("DELETE", `bugreports/${id}`);
    }

    if (openTriage >= MAX_OPEN_TRIAGE) {
      console.log(
        `::warning::未トリアージの Issue が ${openTriage} 件あるため作成を一時停止（上限 ${MAX_OPEN_TRIAGE}）。報告は RTDB に残しています`
      );
    } else {
      const room = Math.min(create.length, MAX_OPEN_TRIAGE - openTriage);
      for (const id of create.slice(0, room)) {
        const issue = buildIssue(id, reports[id]);
        if (DRY_RUN) {
          console.log(`--- [DRY RUN] ${issue.title}\nlabels: ${issue.labels.join(", ")}\n${issue.body}\n`);
          continue;
        }
        const r = await gh("POST", `/repos/${REPO}/issues`, issue);
        if (!r.ok) {
          console.log(`::error::Issue 作成失敗 ${id}: ${r.status} ${JSON.stringify(r.json)}`);
          continue; // RTDB には残す（次回再挑戦）
        }
        console.log(`Issue #${r.json.number} を作成: ${id}`);
        await db("DELETE", `bugreports/${id}`);
      }
      const left = total - alreadyDone.length - suppressed.length - room;
      if (left > 0) console.log(`残り ${left} 件は次回に回します`);
    }
  }

  // 古いレート制限の印を掃除（RTDB を太らせない）
  const rl = (await db("GET", "bugreport_rl")) || {};
  const stale = Object.entries(rl).filter(([, v]) => !(typeof v?.at === "number" && Date.now() - v.at < RL_TTL_MS));
  if (stale.length > 0) {
    console.log(`古いレート制限の印を掃除: ${stale.length} 件`);
    if (!DRY_RUN) await db("PATCH", "bugreport_rl", Object.fromEntries(stale.map(([k]) => [k, null])));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`::error::${e?.message || e}`);
    process.exit(1);
  });
}
