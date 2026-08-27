#!/usr/bin/env bash
# Bouwt de macOS-versie van FlacDeck. Draai dit OP een Mac, in de projectmap:
#
#   bash tools/bouw-op-mac.sh
#
# Resultaat: dist/FlacDeck-<versie>-macos-arm64.dmg en -x64.dmg
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Dit script hoort op macOS te draaien. Een .dmg kun je nergens anders maken." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js ontbreekt. Installeer het via https://nodejs.org (versie 20 of hoger)." >&2
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if (( major < 20 )); then
  echo "Node $major is te oud; installeer versie 20 of hoger." >&2
  exit 1
fi

# node_modules van Windows bevat Windows-binaries van ffmpeg en ffprobe.
# Meegekopieerd? Dan weggooien, anders zit ffmpeg.exe in je Mac-app.
if [[ -d node_modules ]] && [[ -f node_modules/ffmpeg-static/ffmpeg.exe ]]; then
  echo "==> node_modules komt van Windows; opnieuw installeren"
  rm -rf node_modules
fi

echo "==> Pakketten installeren"
if [[ -f package-lock.json ]]; then npm ci; else npm install; fi

echo "==> Controleren"
npm run typecheck
npm run test:unit
npm run test:licence

echo "==> Bouwen"
export CSC_IDENTITY_AUTO_DISCOVERY=false   # niet ondertekenen: geen Apple-certificaat
npm run pack:mac

echo
echo "Klaar. In dist/ staat:"
ls -1 dist/*.dmg 2>/dev/null || echo "  (geen dmg gevonden — lees de foutmeldingen hierboven)"
echo
echo "De app is niet ondertekend. Bij de eerste keer openen:"
echo "  rechtermuisknop op FlacDeck.app -> Open -> Open"
