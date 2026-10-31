#!/usr/bin/env bash
# Usage:  ./setup-android.sh yourdomain.com
# Creates the Android project that loads https://yourdomain.com inside a hardened WebView with
#   * FLAG_SECURE  -> screenshots and screen recordings come out BLACK, recents thumbnail hidden
#   * CAMERA permission wired through to the page (needed for the camera guard)
#   * no other sites can be opened inside the app
set -euo pipefail
DOMAIN="${1:?usage: ./setup-android.sh yourdomain.com[/folder]   e.g. ./setup-android.sh ndlapprenticeschool.com/CYPHER}"
cd "$(dirname "$0")"
node set-url.js "$DOMAIN"
npm install
[ -d android ] || npx cap add android
npx cap sync android

MAIN=$(find android/app/src/main/java -name MainActivity.java | head -1)
[ -n "$MAIN" ] || { echo "MainActivity.java not found"; exit 1; }
cat > "$MAIN" <<JAVA
package com.cipherseal.vault;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // Blocks screenshots, screen recording and screen mirroring of this window.
    getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
  }
}
JAVA

MANIFEST=android/app/src/main/AndroidManifest.xml
grep -q "android.permission.CAMERA" "$MANIFEST" || sed -i 's#</manifest>#    <uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>#' "$MANIFEST"
# no backups of app data (keeps nothing readable via adb backup)
sed -i 's#android:allowBackup="true"#android:allowBackup="false"#' "$MANIFEST"

echo
echo "Done. Next:  npx cap open android   (Android Studio -> Build -> Build APK)"
echo "Or CLI:      cd android && ./gradlew assembleDebug   -> app/build/outputs/apk/debug/app-debug.apk"
