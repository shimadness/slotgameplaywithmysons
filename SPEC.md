# TRIPLE SLOT — 実装仕様書

> **完全オリジナル** のローカル動作ブラウザスロットゲーム（パズル × スロット）。  
> Vite + TypeScript 製。`dist/index.html` を `file://` で直接開いても動く。

---

## アーキテクチャ概要

```
src/
  main.ts            進行管理・モード切替・ラッシュ進行・勝利精算(ダブルアップ)
  style.css          夜空キャビネットのスタイル
  game/
    dropEngine.ts    ★現行3×3エンジン（8ライン＋コネクト＋コンボ＋氷＋7ラッシュ）
    doubleup.ts      ダブルアップの純ロジック（ラダー/勝敗/スペシャル/上限）
    drop.ts          旧3×3クラスターエンジン（※5リール用に残置・DROPは未使用）
    symbols.ts       5リールのシンボル定義・配当倍率・出現重み
    paylines.ts      5リール10ライン定義と当たり判定
    engine.ts        リール帯生成・抽選
    state.ts         クレジット/ベット/RUSH状態・localStorage保存
  audio/
    sfx.ts           Web Audio 効果音エンジン（音源ファイル不要）
  ui/
    dropBoard.ts     3×3 盤面描画＆連鎖アニメ（消去→落下→補充）＋オッズ列＋リーチ
    doubleup.ts      ダブルアップのUIオーバーレイ
    board.ts         5リール描画＆rAF回転アニメ（正確停止）
    effects.ts       ハイライト/勝利・連鎖ポップ/RUSHバナー/パーティクル
    hud.ts           メーターと操作ボタン（モード別ベットUI）
```

> **重要**: 3×3 DROP は **`dropEngine.ts`** が現行エンジン。旧 `drop.ts`（クラスター判定・
> 設定1〜6のRTPダイヤル）は 5リールの一部参照で残しているだけで、DROPの仕様ではない。
> 以下「① 3×3 DROP」は dropEngine 準拠の現行仕様。

---

## ゲームモード

### ① 3×3 DROP（本家トゥインクルドロップRUSH準拠 / `src/game/dropEngine.ts`）

#### ゲームフロー
1. SPIN → `state.placeBet()`（ベット消費を**即 localStorage 保存**）
2. `dropEngine.play(bet, oddsCarry?, rush?)` で1プレイぶんの連鎖を全計算（`DropResult`）
3. `dropBoard.run()` が回転スピンイン → カスケード（ハイライト→消去→落下補充）を描画
4. コンボボーナス → 勝利精算 `resolveWin()`（通常はダブルアップへ／RUSH中は自動collect）
5. 初期盤面にスキャッター3個以上ならセブンラッシュ突入

#### シンボル（弱→強・12種＋ワイルド＋スキャッター）
cherry🍒 / orange🍊 / plum🍇 / banana🍌 / melon🍈 / bell🔔 / BAR / BAR² / BAR³ /
青7 / 赤7 / **gold7**（激レア・ライン1000固定）／ **wild✨**（代用）／ **rush7 7️⃣**（突入スキャッター）

#### 配当 ＝ 3系統の総和（足し算）
1プレイの配当は次の3つを**すべて加算**（`bet` は単一ベット＝DROPの「TOTAL BET」）：

- **① ラインペイ**：有効**8ライン**（縦3・横3・斜め2）。`bet × 現在オッズ[symbol]`。
  - **オッズ上昇機構**：あるシンボルがライン成立すると、**そのシンボル以上（同格＋上位）の
    オッズが階段を1段アップ**。配当は上昇前の値で払い→その後上昇。新規スピンでリセット。
    ※**ライン役のみ上昇**（コネクト役では上がらない）。
  - マスター階段（昇順・999上限）: `1,2,3,4,5,6,8,10,12,16,20,25,30,40,50,75,100,150,200,300,400,500,750,999`
  - 開始オッズ: cherry1 / orange2 / plum3 / banana4 / melon5 / bell6 / BAR8 / BAR²10 / BAR³12 / 青7=16 / 赤7=20 / **gold7=1000固定**
- **② コネクトボーナス**：同シンボル**3個以上隣接**（`neighbors()` 規則、有効ライン外でもOK）。
  `bet × コネクト表[個数][symbol]`。個数が多い／シンボルが強いほど高配当（低個数低シンボルは0配当）。
- **③ コンボボーナス**：**4連鎖以上**で `bet × 連鎖倍率`（連鎖終了時に1回）。
  4→×1, 5→×2, 6→×4, 7→×8 … 14〜30連鎖→×1024（30コンボ打ち止め）。

> 接続規則 `neighbors()`：直交は常に接続／斜めは中央マス絡みのみ（角↔中央 1-5,3-5,5-7,5-9 有効、
> 辺中央どうし 2-4,2-6,4-8,6-8 無効）。判定とSVG「道」描画で共有の単一真実源。

#### 氷（凍結）ギミック ＝ RTPダイヤル
- 初期盤面の各セルが確率 `FREEZE_RATE`(=0.5) で凍結。**氷は役に不参加**（ライン/コネクト除外）。
- 隣接セルが役成立すると、そのステップ末で**溶けて**次カスケードから有効（連鎖が伸びる）。
- **氷は初期9マスのみ**（NEXT補充からは降らない）。出現率を上げるほど実効マッチ率↓＝RTP↓。
- UI: `.dcell.is-frozen`（水色霜）／`.melting`（溶け演出）。

#### ワイルドファイブ（✨）— 出現を厳しく制限（2026-06-21）
- 代用ワイルド。**消えずに最大5回**使える（`WILD_USES=5`、`charges[col][row]` で残数管理）。
- **出現制御**：プール抽選からは一切出さない（`normalWeights`/`RUSH_WEIGHTS` とも `wild:0`）。
  各ゲームで確率 **`WILD_SPAWN_CHANCE`(=0.12)** で「**初期NEXT枠に最大1個だけ**」注入する。
  → 最初の3×3盤面には出ない／NEXT初回のみ／**1ゲーム1個まで**（ラッシュ含む）。
  役成立でその列が空いた時に盤面へ落下。検証2万ゲームで盤面wild=0・NEXT率12.1%・最大1個。
- 配当は接続役のみ（自値不使用）。UI: `.wild-count` バッジ＋`.dcell.wild5` 金グロー。

#### セブンラッシュ（DROP専用フリーゲーム）
- **突入**: 通常スピンの初期盤面に **スキャッター7️⃣(`rush7`)が3個以上**（`SCATTER_WEIGHT`=28、突入率≈2%）。
- **内容**: **7ゲーム固定**（`SEVEN_RUSH_GAMES=7`）。ラッシュ中は専用プール `RUSH_WEIGHTS` で
  **青7/赤7を大量出現**（blue7=40 / red7=26）＋fruits抑制・**氷なし・スキャッターなし**（再突入なし）。
- 既存RUSH基盤を再利用：`state.startRush(7,1)` / `inRush`・`freeSpins` / `enterRushFx()` /
  FREE SPINメーター / **BET変更不可** / 勝利は自動collect（ダブルアップなし）/ 終了で獲得額バナー。
- 演出: 突入バナー＋RUSH BGM＋回転背景。スキャッターは金グロー（`.dcell[data-sym="rush7"]`）。
- スロット右下に簡潔なルール表示（`.drop-rush-rule`）。

#### ダブルアップ（DOUBLE UP CHALLENGE / `game/doubleup.ts`＋`ui/doubleup.ts`）
- WIN後に挑戦（通常時のみ。AUTO中も移行／RUSHフリースピン中は自動collectでスキップ）。
- **COLLECT / 半分かける(セーブ) / 全部かける** を選択（価値1のとき半分不可）。
  - 半分: `floor(atRisk/2)` をSAVEへ退避し残りで勝負。全部: atRisk全額（SAVEは安全）。
- ベット選択後に**ディーラーがスピンして目を決定**→3箇所から1つ選ぶ。
  ディーラーより**強い目で勝ち＝賭け分2倍**。**同じ目（同点）はリトライ**（賭けそのままで引き直し）。
- 3箇所が**全部同じ目＝スペシャルボーナス**（`SPECIAL_BONUS` cherry30…gold7=3000・BET倍率）で強制終了。
- 価値が **`UPPER_CAP`(=50000) 超で強制COLLECT**。
- 値モデル: `atRisk`(勝負にさらす)＋`save`(ロック・負けても残る)。COLLECT WIN=atRisk+save / NEXT=atRisk*2+save。
- WIN→ダブルアップ移行まで余韻あり（drop: big1900/小1500ms）。BARはセルに収まるよう縮小表示(`.is-bar`)。

#### ベット（DROP専用・`state.ts`）
- **1BET / 10BET / 100BET 加算 ＋ クリア**（`dropBet` 0〜500、`DROP_BET_MIN/MAX`）。
  `totalBet`(drop)=dropBet（単一ベット＝全ライン有効）。**ベット0ではSPIN不可**（`canSpin` で totalBet≥1）。
- 5リールは従来の `BET▲/MAX`（lineBet 1/2/3/5/10）。HUDがモード別にベットUIを切替。

#### オッズ列UI（`dropBoard.buildOddsPanel`）
- スロット右側に各シンボルの**現在オッズ**を縦並び。最上段に **gold7 ×1000(固定)**。
- 各行に「**↑×N＝ライン成立で上がる次の倍率**」を現在値の下に縦積み表示（`setOdds` で追従）。
- 上昇時は「だるま落とし」風ロール（新×Nが上から降って入替）＋行が金枠フラッシュ。

#### リーチ演出（全DROPスピン共通・`dropBoard.spinIn`）
- 初回スピンで、**最終列で完成するライン（横3・斜め2）の既知2セルが揃えば「リーチ」**。
- リーチ時は最終列を **1100→`REACH_SPIN_MS`(2200)ms** に延長＋終盤ほど切替を遅くして**ゆっくり回す**。
  ピンク発光（`.reach-spin`）＋「リーチ！」バナー＋リーチ音。

#### カスケード／NEXT／スピンイン／落下アニメ
- カスケード: 列ごとの**ストリーム供給**（`streams[col]`）。消去後に重力で詰め、`from[col][row]`（負値＝NEXT域）で落下元を表現。
- NEXT: 各列上に1段（`PREVIEW_ROWS=1`）。最前面に `.next` 金グロー。
- スピンイン: rAFで各列をランダム書換え＋モーションブラー、左→右に620/860/1100ms（リーチ時は最終列のみ延長）。
- 落下アニメ（`paintCell`）: Web Animations APIで `t ∝ √距離` のぷよ風重力加速＋着地スカッシュ。

```ts
const FALL_BASE_MS = 320;  // 1セル落下の基準時間
const SQUASH_MS = 140;     // 着地時の潰れ＆復帰
// 着地スカッシュ付き：translateY(落下) → 0 → scaleX1.22/scaleY0.74 → scale1
```

---

### ② 5リール本格派（`src/game/paylines.ts`, `src/ui/board.ts`）

- 5リール × 3段 / 10ライン
- 左から連続で揃うと配当
- **スキャッター** 3個以上で RUSH（フリースピン）突入
  - 3個 → 10回・×2 / 4個 → 15回・×3 / 5個 → 20回・×5
- **リーチ演出**: 4本目停止時に「2スキャッター」or「高配当4連」でリーチ検出  
  → 最終リールを引き伸ばして点滅＋緊張音

#### 5リール回転アニメ（`src/ui/board.ts`）
- **rAF ループ** + `easeOutQuart` イージングで本物っぽい減速
- **速度連動モーションブラー**: `speed = |pos[reel] - prevPos[reel]|`  
  → `mb = min(1, speed/1.9)` → CSS `--mb` カスタムプロパティ  
  → `filter: blur(calc(var(--mb)*1.4px))` + glyph の `scaleY` / `opacity`

---

## 共通機能

### RUSH 演出（`src/main.ts`）
- `enterRushFx()`: `document.body.classList.add("rush-active")` + `sfx.startRushBgm()`
- `exitRushFx()`: クラス削除 + `sfx.stopRushBgm()`
- `body.rush-active` 時:
  - `.rush-rays`: `repeating-conic-gradient` の放射状背景が14秒で回転
  - 背景色が暖色にシフト（`rushBgPulse` アニメーション）
  - キャビネットが発光

### Web Audio エンジン（`src/audio/sfx.ts`）
音源ファイルなし。すべて Web Audio API で合成。

| 関数 | 内容 |
|------|------|
| `startSpin()` / `stopSpin()` | のこぎり波オシレーター＋LFOのループ音 |
| `reelStop()` | クリック音＋方形波トーン |
| `reach()` | 緊張感のある上昇音 |
| `chain(level)` | 連鎖数に応じてピッチが上がる |
| `winSmall()` / `winBig()` | 小当たり/大当たり効果音 |
| `bonus()` | RUSH突入ファンファーレ |
| `ui()` | UIボタン操作音 |
| `deny()` | 残高不足音 |
| `startRushBgm()` | 152BPM インターバルスケジューラ、マイナーペンタトニックアルペジオ＋のこぎり波ベース＋三角波ハット |
| `stopRushBgm()` | ゲインフェードアウト＋disconnect |

#### RUSH BGM スケジューリング方式
- `setInterval` で60ms先の音符を先行スケジュール（バッファオーバーランを防ぐ）
- 8ステップのアルペジオループ、152BPM

### プレイヤー / クレジット / ベット管理（`src/game/state.ts`）
- **プレイヤーは3人（`PLAYER_IDS = p1/p2/p3`）。各自で別々のセーブ**。
  - 保存キー：`triple-slot.save.<id>`（credits / lineBetIndex / settei / **dropBet**）。
  - `triple-slot.meta`：3人の名前 + 直近プレイヤー（`current`）。
  - `switchPlayer(id)` でその人のデータをロード（RUSH等の一時状態はリセット）。
  - 初回（`current` 未設定）は `firstRun=true` → 起動時にプレイヤー選択を表示。
  - `setName(id, name)`（12文字まで）、`allPlayers()`/`peekCredits(id)` で選択画面に残高表示。
  - サーバー無し構成のため **クレジットは端末ごとに保存**（端末間同期はしない）。
- **ベットはモード別**：DROP=`dropBet`(0〜500・1/10/100BET加算＋クリア、`totalBet=dropBet`)／
  5リール=`lineBet`(1/2/3/5/10循環、`totalBet=lineBet×10`)。`bet` ゲッターが配当倍率用の単位を返す。
- **`placeBet()` はベット消費を即 `save()`**（スピン演出中・ダブルアップ中にリロードされても
  ベットが巻き戻らない＝タダ回し防止。2026-06-21修正）。
- 残高不足時 → HUD に「+1000補充」ボタン表示。`canSpin()` は `totalBet≥1 && credits≥totalBet`。
- UI: 起動時のプレイヤー選択オーバーレイ＋ヘッダー「👤 名前」ボタンで切替（`main.ts`）。

### AUTO プレイ（`src/main.ts`, `src/ui/hud.ts`）
- `autoPlay` フラグ。HUD に金色「AUTO ●」インジケーター
- 各プレイ終了後 650ms 後に次プレイを自動開始
- RUSH中は自動継続（1000ms間隔）
- 残高不足で自動停止

---

## スタイル設計（`src/style.css`）

| クラス / 要素 | 役割 |
|--------------|------|
| `.cabinet` | 夜空背景のキャビネット外枠 |
| `.rush-rays` | RUSH中に回転する放射状グラデーション |
| `.drop-stack` | プレビュー管＋3×3グリッドの縦スタック |
| `.drop-previews` | 各列の上のNEXTプレビュー管（`::before` で "NEXT" ラベル） |
| `.ptube-cell.next` | 最も手前のプレビューセル：金色グロー + `nextGlow` アニメ |
| `.dcell` | 3×3グリッドの1セル（`--dcell`：PC最大116px／モバイルは可変） |
| `.dcell.match` | マッチ確定：ボーダーグロー＋脈動アニメ |
| `.dcell.clearing .glyph` | 消去中：`clearOut` で縮小・回転して消える |
| `.dcell.is-frozen` / `.melting` | 氷（凍結）／溶け演出 |
| `.dcell.reach-spin` | リーチ中の最終列：ピンク発光で煽る |
| `.dcell[data-sym="rush7"]` | 突入スキャッターの金グロー |
| `.odds-panel` / `.odds-next` | 右側オッズ列／「次の倍率」プレビュー |
| `.drop-rush-rule` | スロット右下のセブンラッシュ説明 |
| `.du-overlay` / `.du-*` | ダブルアップのオーバーレイ一式 |
| `body.rush-active` | RUSH中の全体背景色変化＋キャビネット発光 |

---

## データフロー（3×3 DROPの1プレイ）

```
[SPIN押下]
  → state.placeBet()           ← ベット消費を即save（巻き戻し防止）
  → dropEngine.play(state.bet, undefined, state.inRush)   ← 全連鎖を事前計算
       ↓ DropResult { initial, initialPreview, steps[], totalWin, maxChain,
                      comboMult/comboPay, scatterCount, triggeredRush }
  → dropBoard.run(result, callbacks)
       ├─ renderPreview(initialPreview) / spinIn(initial)  ← 回転＋リーチ判定(最終列スロー)
       └─ for each step: highlight → onStep(sfx/粒子) → 消去 → setGrid(落下) → renderPreview
       └─ setOdds(step.oddsAfter)  ← オッズ上昇ロール＋「次の倍率」追従
  → result.comboPay>0 → コンボバナー
  → result.totalWin>0 → resolveWin(win):
        RUSH中    → state.addWin(win)（自動collect）
        通常      → doubleUp.start(win, bet) → 最終額を state.addWin
  → !inRush && result.triggeredRush → state.startRush(7,1) / enterRushFx()
        → 以降 freeSpins>0 の間 play() を自動継続、0で finishDropRush()
```

---

## 未実装・既知 TODO

- **ダブルアップ入口の上限ガード（未対応）**: ダブルアップ前のWINが既に `UPPER_CAP`(50000) 超でも
  ダブルアップに入れてしまう。`resolveWin` 冒頭で `win > UPPER_CAP` なら自動collectで弾く想定。
- **軽量モード（未実装）**: 端末差のなめらかさ対策。重さの主因は描画（box-shadow脈動/blur/
  backdrop-filter/パーティクル/RUSH回転背景）で、ゲーム演算は無負荷。`body.lite` トグルで
  発光・ぼかし・粒子を抑制する方針（メモに手順あり）。
- ペイアウト率（RTP）は固定配当＋氷ダイヤルで設計。dropEngine 用の常設RTPハーネスは未整備
  （旧 `rtp.mjs` は旧 drop.ts 用）。構造変更時は使い捨てスクリプトで実測する運用。

---

## 演出・アニメーション技術ディテール（こだわりの実装）

ここが本作の「気持ちよさ」を作っている中核。各演出をどう実現しているかを記す。

### 1. ぷよぷよ風 落下（重力加速＋着地スカッシュ）

**狙い**: 「サッと出現」ではなく「上からだんだん速く落ちて、着地でグニャッと潰れる」。

**実現方法**（`src/ui/dropBoard.ts:paintCell()`）:
- ロジック側（`drop.ts:collapse()`）が `from[col][row]` に**落下元の行**を持たせる。  
  負値はNEXTプレビュー域からの落下を意味する。
- UIは `fromOffsetPx = (fromRow - finalRow) * DCELL` を計算し、glyphを**最終位置に置いたまま**、
  Web Animations API で「上から最終位置へ」のキーフレームを再生（teleport→animateではなく、
  常にレイアウトは確定済みで transform だけが動く）。
- **重力加速**: 自由落下は `距離 ∝ t²` なので、落下時間は `t ∝ √距離`。  
  `fallMs = FALL_BASE_MS * √(落下セル数)` ＝ **遠くから落ちるものほど長い時間**＝速度が上がって見える。
  イージング `cubic-bezier(0.45, 0, 0.85, 0.6)`（ease-in系）で「だんだん速く」を表現。
- **着地スカッシュ**: 接地後に `scaleX(1.22) scaleY(0.74)`（横に潰れ縦が縮む）→ `scale(1)` で
  バネのように復帰。体積が一定っぽく見えるよう X拡大とY縮小をセットにしている。
- キーフレームの `offset` は `fallMs / (fallMs+SQUASH_MS)` で「落下:スカッシュ」の時間比を保つ。

```ts
const cells = Math.abs(fromOffsetPx) / DCELL;
const fallMs = Math.round(FALL_BASE_MS * Math.sqrt(cells)); // t ∝ √距離
const land = fallMs / (fallMs + SQUASH_MS);
glyph.animate([
  { transform: `translateY(${fromOffsetPx}px) scaleX(1) scaleY(1)`,
    easing: "cubic-bezier(0.45, 0, 0.85, 0.6)" },   // 加速して落下
  { transform: "translateY(0) scaleX(1) scaleY(1)", offset: land, easing: "ease-out" },
  { transform: "translateY(0) scaleX(1.22) scaleY(0.74)",
    offset: land + (1-land)*0.4, easing: "ease-in-out" },   // 着地で潰れる
  { transform: "translateY(0) scaleX(1) scaleY(1)" },        // 復帰
], { duration: fallMs + SQUASH_MS, fill: "backwards" });
```

`run()` のカスケード待機は **最長落下ぶん** `MAX_DROP_MS + 120ms` で全列の着地を保証。

**「管からそのまま落ちてくる」連続感**（演出の肝）:
- NEXTプレビュー管を、グリッドの **「行 -1」** として扱う。CSSで管セルを **フルセル高さ
  （`--dcell`）・フル列幅・グリッドと同寸のグリフ（`0.5*dcell`）** にし、`.drop-stack` の
  gap を行間ギャップ `--dgap` と一致させることで、管とグリッドが **等ピッチ** で縦に連続する。
- 落下量は `PITCH = DCELL + GAP`（116+8=124px）で計算。これで「1行＝124px」がアニメと
  レイアウトで完全一致し、ガタつきが消える。
- エンジン（`drop.ts:collapse()`）は、**管で光っていた予備シンボル（`taken[0]`）が必ず最深部へ**
  落ちるように積む。その `from = -1` なので開始オフセットはちょうど管の位置（行 -1）になり、
  **管の中身がそのまま下へスライドする** ように見える。
- `.dcell { overflow: visible }` にして、落下中のグリフが **上のセルや管を横切って滑り込む**
  様子をクリップせず見せる（各セル内に閉じ込めない）。DOM順で下の行ほど上に描画されるため、
  落下中のグリフが上の静止シンボルを正しく覆い、1つの塊が滑り落ちるように見える。
- 結果として、管に「次の予備」が現れる ⇄ 直前まで光っていた予備がスッと盤面へ滑り込む、の
  ハンドオフが1モーションで繋がる。

**予備枠への落下**（`renderPreview(preview, animate=true)`）:
- 旧予備が盤面へ滑り出るのと同時に、**新しい予備が「行 -2」から予備枠へ落ちてくる**。
  急に出現せず、`translateY(-PITCH) → 0` ＋ `opacity 0.3 → 1` を加速イージングで再生。
- カスケードの各ステップで `animate=true` を渡す（初期表示・スピンイン時は `false`）。
  シンボルが変化した枠だけアニメーションする（`cell.dataset.sym` で差分検出）。

### 2. リール回転モーションブラー（速度連動）

**5リール**（`src/ui/board.ts`）:
- rAFループで `pos[reel]`（セル単位の連続位置）を `easeOutQuart` で目標まで補間。
  4乗イージングは終盤の減速が長く「ヌルッと」止まる。
- **ブラー量は速度から算出**: `speed = |pos - prevPos|`（フレーム間移動量）→ `mb = min(1, speed/1.9)`。
  これを CSS変数 `--mb` に書き込む。
- CSS側（`style.css`）が `--mb` を3つの効果に分配:
  - 帯全体に `filter: blur(calc(var(--mb) * 1.4px))`
  - glyph を `transform: scaleY(calc(1 + var(--mb)*1.15))`（縦に伸びる）
  - glyph を `opacity: calc(1 - var(--mb)*0.3)`（高速時うっすら）
- 停止時 `clearBlur()` で `--mb=0` に戻し、シャープな静止画へ。
- 帯は**2連結**（strip を2周ぶん並べる）して継ぎ目でのループ切れを防止。

**3×3 DROPのスピンイン**（`dropBoard.ts:spinIn()`）:
- 停止前は各列を**ランダムシンボルで45ms毎に差し替え**（`spinFrame()`）て高速回転を演出。
- ブラーは JSで直接 glyph に `scaleY`＋`opacity` をインライン適用（`applyBlur()`）。
  ※ここはCSS変数ではなくインラインtransform。落下アニメと描画経路を分離するため。
- 列ごとに停止時刻をずらし（620 / 860 / 1100ms）左→右へ順番に止め、`easeOutCubic` で減速。

### 3. RUSH 専用 BGM（先読みスケジューラ）

**課題**: Web Audioで途切れないループBGMを鳴らすには、`setInterval` の発火ジッタを音にしてはいけない。

**実現方法**（`src/audio/sfx.ts:startRushBgm()`）:
- **ルックアヘッド・スケジューラ** パターン。`setInterval(25ms)` は「予約係」に徹し、
  実際の発音時刻は `AudioContext.currentTime` 基準で**先（〜140ms先）まで前倒し予約**する。
  ```ts
  while (bgm.nextTime < ctx.currentTime + 0.14) { /* 音符をt=nextTimeで予約 */ bgm.nextTime += stepDur; }
  ```
  これで タイマーが多少遅れても、音はサンプル精度で正確に並ぶ。
- 152BPM、8分音符グリッド。**マイナーペンタトニック**のアルペジオ `[0,3,5,7,10,12,10,7]`（square波）、
  1オクターブ下のベース `[0,0,5,5,3,3,7,7]`（sawtooth）、奇数ステップに高音ハット（triangle, 3520Hz）。
- 各音は `bgmNote()` が個別のオシレーター＋ゲインを生成し、`exponentialRampToValueAtTime` で
  アタック12ms→ディケイのエンベロープを付ける（クリックノイズ防止）。
- 停止は専用ゲインを `setTargetAtTime` でフェードアウトしてから `disconnect()`。

### 4. その他の合成効果音（ファイル不要）

すべて `OscillatorNode`＋`GainNode` の動的生成。代表例:
- **連鎖音 `chain(level)`**: 基音 `440 * 2^((level-1)/12)` ＝ 連鎖が伸びるほど半音ずつ上がる高揚感。
- **リール停止 `reelStop()`**: ホワイトノイズ（1024サンプルのBufferを減衰）を bandpass(1800Hz) に
  通した「カチッ」＋ square 220Hz の短打。
- **スピンループ `startSpin()`**: sawtooth 70Hz を LFO(22Hz) で周波数変調した唸り音。停止でフェード。
- 当たり/ファンファーレは三角波・矩形波で和音アルペジオ。

### 5. パーティクル（Canvas 物理）

**実現方法**（`src/ui/effects.ts:burst()` ＋ `startLoop()`）:
- 単一の `<canvas>`（DPR対応、最大2倍）に rAF ループで全パーティクルを再描画。
- 各粒子は `{x,y,vx,vy,life,size,color,rot,vr}`。毎フレーム `vy += 0.32`（重力）、
  位置・回転を更新、`life` を 0.012 ずつ減らし `globalAlpha` でフェードアウト。
- 矩形を回転描画（紙吹雪の短冊）。粒子が尽きたら自動でループ停止しCPUを解放。
- **当たりシンボルの色を引き継ぐ**: クラスター/ラインの `sym(...).color` をパレットに渡すので、
  揃った色の紙吹雪が舞う。

### 6. 「道（通路）」の可視化 — 繋がりを見せる

**狙い**: 「3個以上の繋がりで出目」というコンボ条件を、**セル間の通路が点灯して
繋がる**ことで直感的に見せる。

**実現方法**（`src/ui/dropBoard.ts`）:
- グリッド背面に **SVGレイヤー `.drop-roads`** を敷く（`.drop-grid-wrap` で相対配置、
  グリッドは `z-index:1`、道は `z-index:0`）。
- `buildRoads()` が **`neighbors()` が返す隣接セル中心どうしを結ぶ線分**を生成（重複辺は
  スキップ）。セル中心は `c*(DCELL+GAP)+DCELL/2`。3×3では道は16本（直交12＋中央斜め4）。
  辺中央どうしの斜め（2-4 等）は道が無いので、繋がりすぎない。
- セル背景は不透明なので、道は **ギャップ部分にだけ覗く**＝盤面の格子に通路が走る見た目。
  斜めの道は中央の交差点（4セルが集まるギャップ）でのみ見える。
- 揃った瞬間 `highlight(step)` が、**同一クラスター内の隣接ペアを結ぶ道だけ** `.lit` にして
  そのシンボル色（`--road-color`）で発光（`drop-shadow` ＋ `roadPulse` 明滅）。これで
  「どの石がどう繋がって3個以上になったか」がひと目で分かる。
- マッチ判定（`drop.ts:findClusters()`）と道の接続は**同じ `neighbors()`** で定義 →
  「点灯した道の連なり＝判定された繋がり」が完全一致する。斜めの制限もここで一元管理。
- 次ステップの落下時に `setGrid()` 冒頭で `clearRoads()` し、道の点灯をリセット。

### 7. CSS主導のマイクロ演出

| 効果 | 実装 |
|------|------|
| NEXT最前面の発光 | `.ptube-cell.next` → `@keyframes nextGlow`（1.1s 明滅 alternate） |
| マッチ確定の脈動 | `.dcell.match` → `@keyframes winPulse`（明度を往復） |
| 消去アニメ | `.dcell.clearing .glyph` → `@keyframes clearOut`（0.26s で縮小回転消滅） |
| RUSH背景の回転光 | `.rush-rays` = `repeating-conic-gradient` を `@keyframes raySpin`（14s 無限回転）、`body.rush-active` で `opacity 0→1` |
| RUSH中の全体トーン | `body.rush-active` に `@keyframes rushBgPulse`（saturate/brightness を往復）＋暖色化 |
| AUTO作動表示 | `@keyframes autoGlow` で金色インジケーターを明滅 |
| リーチ点滅 | `.reel.reach` → `@keyframes reachFlash` |

JS（状態）とCSS（見た目）を疎結合に保つため、演出の多くは**クラス付与だけ**でトリガーしている
（例: `enterRushFx()` は `body.classList.add("rush-active")` のみで背景・光・色を一斉起動）。

---

## ビルド・開発

```bash
npm install          # 初回のみ（esbuild: npm approve-scripts esbuild が必要な場合あり）
npm run dev          # http://localhost:5173
npm run build        # dist/ へ出力（tsc型チェック込み）
npm run rtp          # ペイアウト率（RTP）を計測
```

`vite.config.ts`: `base: "./"` 設定済み → `dist/index.html` を `file://` で直接開ける。
