#!/bin/bash
# 打包脚本：生成 zip 包 + 未压缩目录，方便本地加载和商店上传。
# 用法：./scripts/package.sh [输出文件名]
# 输出：
#   - dist/x-light-translate/      未压缩目录（可直接「加载已解压的扩展程序」）
#   - dist/x-light-translate.zip   压缩包（用于 Chrome Web Store 上传）

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_FILE="${1:-$PROJECT_ROOT/dist/x-light-translate.zip}"
OUT_DIR="$(dirname "$OUT_FILE")"
UNPACKED_DIR="$OUT_DIR/x-light-translate"

echo "[1/4] 构建生产包..."
cd "$PROJECT_ROOT"
npm run build

echo "[2/4] 创建输出目录..."
mkdir -p "$OUT_DIR"

# 清理旧产物
rm -rf "$UNPACKED_DIR"
rm -f "$OUT_FILE"

echo "[3/4] 复制到未压缩目录..."
mkdir -p "$UNPACKED_DIR"

# 逐一复制，保持与 zip 清单一致
cp -v \
  manifest.json \
  content.js \
  background.js \
  popup.js \
  popup.html \
  popup.css \
  styles.css \
  config.example.json \
  README.md \
  LICENSE \
  PRIVACY.md \
  "$UNPACKED_DIR/"

# 复制 icons 目录
rsync -av --exclude='.DS_Store' icons/ "$UNPACKED_DIR/icons/"

echo "[4/4] 打 zip 包..."
cd "$OUT_DIR"
zip -r "$OUT_FILE" x-light-translate/ \
  -x "*.DS_Store" \
  -x "*/.git/*"

echo ""
echo "✅ 打包完成"
echo "   未压缩目录: $UNPACKED_DIR"
echo "   ZIP 包:     $OUT_FILE"
echo ""
unzip -l "$OUT_FILE" | tail -5
