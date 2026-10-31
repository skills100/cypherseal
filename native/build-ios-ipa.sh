#!/usr/bin/env bash
# Builds the iPhone app ON YOUR MAC (no GitHub needed) and puts the files where the website expects them.
#   ./build-ios-ipa.sh ndlapprenticeschool.com/CYPHER
# Result:  ../downloads/CipherSeal.ipa   and   ../downloads/altstore.json   (upload both to your hosting)
# Needs: Xcode (Mac App Store, open it once and accept the licence), Node 18+, CocoaPods (brew install cocoapods).
set -euo pipefail
SITE="${1:?usage: ./build-ios-ipa.sh yourdomain.com[/folder]   e.g. ./build-ios-ipa.sh ndlapprenticeschool.com/CYPHER}"
cd "$(dirname "$0")"

command -v xcodebuild >/dev/null || { echo "Xcode is not installed. Install it from the Mac App Store, open it once, then run this again."; exit 1; }
command -v node >/dev/null || { echo "Node.js is missing. Install the LTS version from nodejs.org, then run this again."; exit 1; }
command -v pod >/dev/null || { echo "CocoaPods is missing. Run:  brew install cocoapods   (or: sudo gem install cocoapods)"; exit 1; }

bash ./setup-ios.sh "$SITE"

cd ios/App
rm -rf build
xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -archivePath "$PWD/build/App.xcarchive" archive \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""

cd build
mkdir Payload
cp -R App.xcarchive/Products/Applications/App.app Payload/
zip -qr CipherSeal.ipa Payload

OUT="../../../../downloads"
mkdir -p "$OUT"
cp CipherSeal.ipa "$OUT/CipherSeal.ipa"
node ../../../make-altstore-json.js "$SITE" "$OUT/CipherSeal.ipa" > "$OUT/altstore.json"

echo
echo "DONE. Files created in the project's downloads folder:"
ls -la "$OUT/CipherSeal.ipa" "$OUT/altstore.json"
echo "Upload BOTH to your hosting folder  public_html/CYPHER/downloads/  (File Manager), or install the .ipa with Sideloadly now."
