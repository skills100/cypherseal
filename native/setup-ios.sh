#!/usr/bin/env bash
# Usage:  ./setup-ios.sh yourdomain.com          (run on a Mac, or on GitHub's macOS runner)
# Creates the iPhone/iPad project that loads https://yourdomain.com and adds:
#   * secure-layer + capture detection: screenshots/recordings come out blank, recording/mirroring
#     blanks the app at once and wipes the open item (see SecureViewing.swift.txt)
#   * camera permission text (needed for the camera guard)
#   * the "CipherSealApp/1" user-agent marker the release service checks
set -euo pipefail
DOMAIN="${1:?usage: ./setup-ios.sh yourdomain.com[/folder]   e.g. ./setup-ios.sh ndlapprenticeschool.com/CYPHER}"
cd "$(dirname "$0")"
node set-url.js "$DOMAIN"
npm install
[ -d ios ] || npx cap add ios

APPDEL=ios/App/App/AppDelegate.swift
grep -q "class SecureViewController" "$APPDEL" || cat SecureViewing.swift.txt >> "$APPDEL"

SB=ios/App/App/Base.lproj/Main.storyboard
python3 - "$SB" <<'PYSB'
import re, sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s2 = re.sub(r'customClass="CAPBridgeViewController"\s+customModule="Capacitor"(\s+customModuleProvider="[^"]*")?',
            'customClass="SecureViewController" customModule="App" customModuleProvider="target"', s)
open(p, 'w', encoding='utf-8').write(s2)
PYSB
grep -q 'customClass="SecureViewController"' "$SB" || { echo "Storyboard patch failed"; exit 1; }

python3 - ios/App/App/Info.plist <<'PY'
import plistlib, sys
p = sys.argv[1]
d = plistlib.load(open(p, 'rb'))
d['NSCameraUsageDescription'] = 'CipherSeal uses the front camera on this device only, to make sure nobody else is watching or filming the protected item. Nothing is recorded or uploaded.'
plistlib.dump(d, open(p, 'wb'))
PY

npx cap sync ios
echo
echo "Done. On a Mac:  npx cap open ios   (set Signing -> Team to your Apple ID, press Run with the iPhone plugged in)"
echo "Unsigned IPA for Sideloadly/AltStore: see ../.github/workflows/build-ios.yml"
