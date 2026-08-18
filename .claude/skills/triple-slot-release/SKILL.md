---
name: triple-slot-release
description: |
  TRIPLE SLOT（twinkle-drop-rush / shimadness/slotgameplaywithmysons）専用の
  配信・リリース手順。Web(GitHub Pages)へのデプロイ、iOS(TestFlight)への
  Archive＆アップロード（自動化スクリプトあり）、Android署名付きAPKの作成、
  RTDB appmeta によるアプリ内アップデート告知まで。このプロジェクトで
  ユーザーが「配信」「リリース」「デプロイ」「配布」「出そう」「TestFlightに
  上げたい」「APK作って」「バージョン上げて」等と言ったら必ずこのスキルを使う。
  ビルドだけの依頼でも、その後配信につながりそうな文脈ならこれを読んでから動く。
---

# triple-slot-release — TRIPLE SLOT の配信手順

配信チャネルは3つ＋告知1つ。全部やるか一部だけかはユーザーの指示に従う
（「配信しよう」だけなら Web は自動なので必ず含まれる。ネイティブはバージョン
バンプの要否を確認）。

## 0. 前提と環境

- リポジトリ: `shimadness/slotgameplaywithmysons`（main への push = Web 本番配信）
- 配布先は家族＋社内のみ。Google Play / App Store 公開はしていない。
- Gradle 系は必ず `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`
  を付ける（PATH に Java が無い環境がある。別環境なら手元の JDK でよい）。
- **別の端末で作業する場合**に必要なもの（リポジトリには入っていない）:
  - `android/release.keystore`＋`android/keystore.properties`（署名鍵。バックアップから復元）
  - `ios/App/asc-key.env`＋App Store Connect APIキーの .p8（iOS自動アップロード用。
    `ios/App/asc-key.env.example` 参照）
  - Xcode／Android Studio

## 1. バージョンバンプ（ネイティブ配布する時だけ）

アプリ内アップデート告知（`src/ui/updatePrompt.ts`）は「RTDB の appmeta のビルド番号 >
インストール済みビルド番号」で発火する。ネイティブに新ビルドを配るなら必ず上げる：

- **Android**: `android/app/build.gradle` の `versionCode`（+1）と `versionName`
- **iOS**: `ios/App/App.xcodeproj/project.pbxproj` の `CURRENT_PROJECT_VERSION`（+1、
  **2箇所ある**ので replace_all で）。`MARKETING_VERSION` は原則触らない。

Webだけの配信ならバンプ不要。

## 2. Web（GitHub Pages）— push すれば自動

1. `npm run build` が通ることを確認してからコミット（メッセージは既存ログの
   「Prefix: 概要」形式。日本語可）。
2. `git push origin main` → `.github/workflows/deploy.yml` が自動で Pages にデプロイ。
3. `gh run watch <run-id> --exit-status` で完了を見届ける。
4. 本番反映を検証：
   ```bash
   base="https://shimadness.github.io/slotgameplaywithmysons/"
   main=$(curl -s "${base}assets/$(curl -s $base | grep -oE 'boot-[A-Za-z0-9_-]+\.js' | head -1)" | grep -oE 'main-[A-Za-z0-9_-]+\.js' | head -1)
   curl -s "${base}assets/$main" | grep -o "<今回の変更に固有の文字列>"
   ```
   （index.html は boot-*.js しか参照しない。main チャンク名は boot 経由で取る）

Android の家族向けは PWA（このURLをChromeで「インストール」）でも配信されるので、
Web 反映 = PWA 勢への配信完了。

## 3. iOS（TestFlight）

1. `npm run sync`（build + cap sync）で `ios/App/App/public` を最新化。
2. シミュレータビルドで壊れていないか確認：
   ```bash
   cd ios/App && xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator \
     -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
   ```
3. **自動アップロード**（`ios/App/asc-key.env` がある場合）：
   ```bash
   bash .claude/skills/triple-slot-release/scripts/ios_upload.sh
   ```
   Archive → App Store Connect へのアップロードまで自動。アップロードは外部公開に
   つながる操作なので、実行前にユーザーへ一言確認する。
4. asc-key.env が無い場合は手動（従来手順）: `npx cap open ios` → Any iOS Device →
   Product→Archive → Distribute App → App Store Connect → Upload。
5. **どちらの場合も最後は手作業**: App Store Connect の TestFlight で処理完了を待ち、
   外部グループ「家族とシスナビ」にビルドを追加（ベータ審査が走ることがある）。
   Team `KFW7UH97T3`。Xcode Cloud は使わない。

過去のハマりどころ（聞かれたら案内）: iPad要件は `UIRequiresFullScreen=true`、
暗号化質問は `ITSAppUsesNonExemptEncryption=false`、アップロード毎に build 番号必須バンプ、
テスト情報の「サインインが必要」はチェックを外す。

## 4. Android（署名付きAPK・直接配布）

署名鍵は作成済み（2026-08-18、バックアップ済み）。**`android/release.keystore` と
`android/keystore.properties` は git 管理外（.gitignore 済み）。絶対にコミットしない。**

1. `npm run sync` で web アセットを最新化（Web手順と共通。二度やる必要はない）。
2. 署名付きビルド：
   ```bash
   cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleRelease
   ```
   `app/build.gradle` が `keystore.properties` を読んで自動署名する。
3. 署名検証（apksigner も JAVA_HOME が要る）：
   ```bash
   JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
   ~/Library/Android/sdk/build-tools/<最新>/apksigner verify --print-certs \
     app/build/outputs/apk/release/app-release.apk
   ```
   期待値: `CN=shimadness, O=shimadness, C=JP`
4. 成果物 `android/app/build/outputs/apk/release/app-release.apk` を
   `TripleSlot-<versionName>-release.apk` にリネームしてユーザーへ渡す
   （SendUserFile があれば attach で送る）。配布は直接インストール（AirDrop/共有）。

注意: 過去に debug 署名の APK を入れた端末は署名不一致で上書きできない。
その場合は一度アンインストールしてもらう。

## 5. RTDB appmeta 更新（アプリ内アップデート告知）

Firebase コンソールで `appmeta/ios` / `appmeta/android` のビルド番号を配布した
番号に更新する。**クライアントからは書けない（rules で read-only）ので必ず
ユーザーの手作業**。配布が完了してから更新するよう伝える（先に上げると
まだ落とせないビルドへ誘導してしまう）。

## 6. 完了報告のテンプレ

- Web: デプロイ成功＋本番バンドルに変更が入っていることを確認した旨（検証コマンドの結果）
- iOS: アップロード結果（自動なら script のログ、手動なら残り手順）と build 番号
- Android: APK の場所と versionCode、署名検証結果
- appmeta: 更新すべき値（ios / android それぞれ）
