#!/usr/bin/env bash
# TRIPLE SLOT: iOS を Archive して App Store Connect (TestFlight) へアップロードする。
# 前提: ios/App/asc-key.env に App Store Connect APIキー情報があること（無ければ案内して終了）。
# 使い方: bash .claude/skills/triple-slot-release/scripts/ios_upload.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT/ios/App"

ENV_FILE="asc-key.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: ios/App/asc-key.env がありません。" >&2
  echo "ios/App/asc-key.env.example をコピーして APIキー情報を記入してください。" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
ASC_KEY_PATH="${ASC_KEY_PATH/#\$HOME/$HOME}"  # example の $HOME 表記を展開
[ -f "$ASC_KEY_PATH" ] || { echo "ERROR: .p8 が見つかりません: $ASC_KEY_PATH" >&2; exit 1; }

AUTH=(-allowProvisioningUpdates
      -authenticationKeyPath "$ASC_KEY_PATH"
      -authenticationKeyID "$ASC_KEY_ID"
      -authenticationKeyIssuerID "$ASC_ISSUER_ID")

echo "==> Archive"
xcodebuild -project App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' \
  archive -archivePath build/App.xcarchive "${AUTH[@]}"

echo "==> Export & Upload to App Store Connect"
xcodebuild -exportArchive -archivePath build/App.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export "${AUTH[@]}"

echo "==> 完了。App Store Connect の TestFlight で処理完了（数分）を待ち、"
echo "    外部グループ「家族とシスナビ」にビルドを追加してください。"
