# TRIPLE SLOT — 実装仕様書

> **完全オリジナル** のローカル動作ブラウザスロットゲーム（パズル × スロット）。  
> Vite + TypeScript 製。`dist/index.html` を `file://` で直接開いても動く。

---

## アーキテクチャ概要

```
src/
  main.ts            進行管理・モード切替（DROP / 5リール）
  style.css          夜空キャビネットのスタイル
  game/
    symbols.ts       シンボル定義・配当倍率・出現重み
    drop.ts          3×3 連鎖エンジン（クラスター判定・カスケード）
    paylines.ts      5リール10ライン定義と当たり判定
    engine.ts        リール帯生成・抽選
    state.ts         クレジット/ベット/RUSH状態・localStorage保存
  audio/
    sfx.ts           Web Audio 効果音エンジン（音源ファイル不要）
  ui/
    dropBoard.ts     3×3 盤面描画＆連鎖アニメ（消去→落下→補充）
    board.ts         5リール描画＆rAF回転アニメ（正確停止）
    effects.ts       ハイライト/勝利・連鎖ポップ/RUSHバナー/パーティクル
    hud.ts           メーターと操作ボタン
```

---

## ゲームモード

### ① 3×3 DROP（連鎖パズル × スロット）

#### ゲームフロー
1. SPIN → `drop.ts:play()` で1プレイぶんの連鎖を全計算（`DropResult`）
2. `dropBoard.ts:run()` が `DropResult.steps` を順にアニメーション
3. 各ステップ: ハイライト(560ms) → 消去アニメ(300ms) → 落下補充(MAX_DROP_MS)

#### クラスター判定（`src/game/drop.ts`）
- **「道」で繋がる隣接（`neighbors()`）** をBFSで辿り、同一シンボルの連結を検出
- 接続規則（判定と道の描画で共通の単一の真実源）:
  - **タテ・ヨコ（直交）は常に接続**
  - **ナナメは中央マスに接続する場合のみ**（角↔中央）。列・行の中央どうしの斜め
    （3×3で言う 2-4, 2-6, 4-8, 6-8）は **繋がない** ＝ 繋がりすぎ・勝ちすぎを防止
- **ワイルドファイブ** は隣接するどのシンボルクラスターにも同化（代用）
- 最小サイズ3以上で有効クラスター
- ワイルドの二重取りを防ぐため、価値の高いクラスターから貪欲確定

##### ワイルドファイブ（✨）
- 代用ワイルド。**消えずに最大5回まで使える**（`WILD_USES = 5`）。
- 出目に使われると、**自身は消えず残り回数を1減らして生き残り、通常の生存シンボルと
  同じように重力で下に落ちる**。落ちた先で次のカスケード／次の出目でも再利用できる。
- 残り1で使われた時（＝5回使い切り）に、通常シンボルと同様に消去され上から補充される。
- **配当は接続役のみ**：揃った通常シンボルの価値で計算（自身の高価値は乗せない）。
  これは元々の挙動どおり（`cl.symbol` は常に土台シンボル＝ワイルド自身の値は不使用）。
- 出現はレア（DROPプールの重み **2**、`weightedPool()`）。
- 実装: `charges[col][row]`（残り回数。0=非ワイルド）を `play()` 全体に通す。
  クラスター消去時、ワイルドだけ `charges>1` なら `cleared` に入れず-1、`<=1` で消去。
  `collapse()` が生存ワイルドの残り回数を保持して落とし、新規ワイルドには5を付与。
  各 `CascadeStep.wildAfter` / `DropResult.initialWild` で UI にバッジ表示用の残り回数を渡す。
  ※ `charges` はステップ毎に**コピーしてから減算**（保存済み `wildAfter` を破壊しないため）。
- UI: セルに残り回数バッジ（`.wild-count`）＋金色グロー（`.dcell.wild5`）。プレビュー管でも表示。

```ts
// 道の接続規則（drop.ts）。判定・道レイヤー双方がこれを使う
export function neighbors(c: number, r: number): Array<[number, number]> {
  // 直交4方向は常に / 斜め4方向は中央マス絡みのみ
  // → 角↔中央(1-5,3-5,5-7,5-9)は有効、辺中央どうし(2-4,2-6,4-8,6-8)は無効
}
```

#### 配当計算
```
配当 = round( CLUSTER_VALUE[symbol] × クラスターセル数 × 連鎖倍率 × lineBet
              × rushMultiplier × payoutScale )   （最低1）
```
`payoutScale` は設定（ペイアウト率）由来の係数。下の「ペイアウト率（RTP）制御」を参照。

| シンボル | 1セル価値 |
|---------|-----------|
| drop    | 1         |
| bgem    | 2         |
| ggem    | 2         |
| pgem    | 3         |
| bell    | 4         |
| cherry  | 6         |
| star    | 10        |
| seven   | 20        |
| ※wild   | 接続役のみ・自値は不使用（cl.symbol は常に土台シンボル） |

#### 連鎖倍率ラダー
| 連鎖数 | ×1 | ×2 | ×3 | ×4 | ×6 | ×9 | ×14 |

#### RUSH突入条件
- **6連鎖以上** で RUSH 突入（`RUSH_CHAIN = 6`、突入をレアに）
- フリープレイ 6回（`RUSH_PLAYS`）、配当 ×2（`RUSH_MULTIPLIER`）
- RUSH中に再トリガーで上乗せ。ただし **1RUSHの総スピンは `RUSH_MAX_SPINS = 24` で上限**
  （上乗せ暴走＝出すぎの防止。main.ts と rtp.mjs の両方で同じ上限を適用）

#### ペイアウト率（RTP）制御・設定1〜6
ゲーセン的に「目標RTPを設計値として持ち、そこに合わせ込む」方式（`drop.ts`）。

- **設定1〜6 → 目標RTP**（`SETTEI_RTP`）：1=90% / 2=92% / 3=94% / 4=95%(既定) / 5=96% / 6=97%。
- 実配当に **`payoutScale = 目標RTP ÷ RAW_RTP`** を掛ける（`play(lineBet, rushMult, payoutScale)`）。
  - `RAW_RTP`＝構造（配当表・RUSH）を固定し、`npm run rtp` で実測・較正した基準値（現状 **6.5**）。
  - スケール1.0時の素のRTPは約 **637%**。整数丸め下限（最低1）の影響込みで、操作点(設定4)が
    95%になるよう `RAW_RTP` を較正してある。
- **計測ハーネス常設**：`npm run rtp [payoutScale]`（`rtp.mjs`）。main.ts の進行（RUSH上限含む）を
  再現して RTP・通常/RUSH内訳・突入率・ヒット率を出す。**構造を変えたら再計測して `RAW_RTP` を更新**。
- 設定値は `GameState.settei` に保持し localStorage 保存。ヘッダーの「設定」ボタンで 1→6 循環。
- 較正後の実測（150万有料スピン）: 設定1≈90% / 設定4≈95% / 設定6≈97%、
  RUSH寄与≈39%（通常61%）、RUSH突入率≈4.1%、1RUSH平均≈7.9スピン。

> 重要：`rtp.mjs` は main.ts のゲーム進行（特に `RUSH_MAX_SPINS` 上限・`RUSH_PLAYS`・
> `RUSH_MULTIPLIER`）を手動で再現している。ゲーム側のRUSH進行を変えたらハーネスも合わせること。

#### カスケード（落下補充）
- 列ごとの**ストリーム供給**方式（`streams[col]` = 無限に続く供給列）
- 消去後、残存シンボルが重力で下に詰まり、上から `streams` 先頭を補充
- `from[col][finalRow]` = 落下元の行（負値 = プレビュー域から落下）

#### NEXTプレビュー
- 各列の上に **1段** のプレビュー管（`.ptube`）
- `PREVIEW_ROWS = 1`
- 最も手前（次に落ちる）セルに `.next` クラス → 金色グロー発光アニメ
- ストリーム供給方式なので落下後も正確に次のシンボルを先読み表示

#### リール回転スピンイン（`dropBoard.ts:spinIn()`）
- rAFループで各列をランダムシンボルで高速書き換え + モーションブラー
- 左→右へ順番に停止（620ms / 860ms / 1100ms）
- 停止時に `easeOutCubic` で急停止感
- 停止列から `onReelStop` コールバック → `sfx.reelStop()`

#### 落下アニメ（`dropBoard.ts:paintCell()`）
- **Web Animations API** 使用（CSS transitionではない）
- 落下距離に応じた時間（Puyo Puyo風重力加速：`t ∝ √distance`）

```ts
const FALL_BASE_MS = 320;  // 1セル落下の基準時間
const SQUASH_MS = 140;     // 着地時の潰れ＆復帰
const MAX_DROP_MS = Math.round(FALL_BASE_MS * Math.sqrt(ROWS) + SQUASH_MS);

// 着地スカッシュ付きアニメーション
glyph.animate([
  { transform: `translateY(${fromOffsetPx}px) scaleX(1) scaleY(1)` },
  { transform: "translateY(0px) scaleX(1) scaleY(1)",
    offset: dur / (dur + SQUASH_MS), easing: "cubic-bezier(0.55, 0, 0.9, 0.7)" },
  { transform: "translateY(0px) scaleX(1.25) scaleY(0.7)",
    offset: (dur + SQUASH_MS * 0.4) / (dur + SQUASH_MS) },
  { transform: "translateY(0px) scaleX(1) scaleY(1)" },
], { duration: dur + SQUASH_MS, fill: "backwards" });
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
  - 保存キー：`triple-slot.save.<id>`（credits / lineBetIndex / settei）。
  - `triple-slot.meta`：3人の名前 + 直近プレイヤー（`current`）。
  - `switchPlayer(id)` でその人のデータをロード（RUSH等の一時状態はリセット）。
  - 初回（`current` 未設定）は `firstRun=true` → 起動時にプレイヤー選択を表示。
  - `setName(id, name)`（12文字まで）、`allPlayers()`/`peekCredits(id)` で選択画面に残高表示。
  - サーバー無し構成のため **クレジットは端末ごとに保存**（端末間同期はしない）。
- `lineBet`: 1/2/3/5/10 を循環。`totalBet = lineBet × 10`。
- 残高不足時 → HUD に「+1000補充」ボタン表示。
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
| `.dcell` | 3×3グリッドの1セル（`--dcell = 116px`） |
| `.dcell.match` | マッチ確定：ボーダーグロー＋`winPulse` アニメ |
| `.dcell.clearing .glyph` | 消去中：`clearOut` で縮小・回転して消える |
| `body.rush-active` | RUSH中の全体背景色変化＋キャビネット発光 |

---

## データフロー（3×3 DROPの1プレイ）

```
[SPIN押下]
  → state.placeBet()
  → drop.play(lineBet, rushMult)  ← 全連鎖を事前計算
       ↓ DropResult { initial, initialPreview, steps[], totalWin, maxChain, triggeredRush }
  → dropBoard.run(result, callbacks)
       ├─ renderPreview(initialPreview)
       ├─ spinIn(initial)  ← リール回転アニメ
       └─ for each step:
            ├─ highlight(step)       ← .match クラス付与
            ├─ onStep() callback     ← sfx.chain(), パーティクル
            ├─ wait(560ms)
            ├─ markClearing(step)   ← .clearing クラス付与
            ├─ wait(300ms)
            ├─ setGrid(gridAfter, from)  ← paintCell() × 9（落下アニメ）
            ├─ renderPreview(previewAfter)
            └─ wait(MAX_DROP_MS)
  → result.totalWin > 0 → state.addWin() / effects.popWin()
  → result.triggeredRush → state.startRush() / enterRushFx()
```

---

## 未実装・既知 TODO

- 現状、主要要望はすべて実装済み（ぷよぷよ風落下も完了）。

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
