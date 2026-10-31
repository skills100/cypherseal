# CipherSeal apps (Android + iPhone)

Thin shells that load your deployed site and add what a browser cannot do. Protected, view-once and
self-destruct items open ONLY in these apps.

**Your site is in a folder, so ALWAYS give the full address**, e.g. `ndlapprenticeschool.com/CYPHER`, to every script and workflow.
**Have a Mac? Use `MAC-GUIDE.md`: no GitHub needed.**

## Option: build in the cloud (no Android Studio, no Mac)
1. Create a GitHub repo from this folder (never commit your recovery private key).
2. Actions -> **Build Android APK** -> Run workflow -> your domain -> download `CipherSeal.apk`.
3. Upload it to `public_html/downloads/CipherSeal.apk` on Namecheap. The site links to it automatically.
4. Actions -> **Build iOS IPA** -> Run workflow -> your domain. When it finishes, open the run page: the **Summary** shows direct links, and **Artifacts** (bottom of the page, a .zip) holds `CipherSeal.ipa` and `altstore.json`. Also under **Releases -> CipherSeal iOS (latest)**.
5. Upload `CipherSeal.ipa` and `altstore.json` to `public_html/downloads/`. `install.html` and the in-app panel now link to them, with a one-tap **Add to AltStore** button and a Sideloadly download.

## Or build locally
- Android (Node 18+, Java 17, Android SDK): `./setup-android.sh yourdomain.com`, then `cd android && ./gradlew assembleDebug`.
- iPhone (Mac + Xcode): `./setup-ios.sh yourdomain.com`, `npx cap open ios`, Signing -> Team = your Apple ID, Run.

## What each app does
| | Android | iPhone / iPad |
|---|---|---|
| Screenshot | window is `FLAG_SECURE`: **black** | secure layer: **blank**; also detected, item wiped |
| Screen recording / mirroring | **black** | app **blanks at once**, item wiped; opening while recording is refused |
| App-switcher thumbnail | hidden | hidden |
| Camera guard | yes (permission added) | yes (`NSCameraUsageDescription` added) |
| User-agent marker | `CipherSealApp/1` | `CipherSealApp/1` |

## Verified vs not verified
Verified: both scripts scaffold the projects and apply every patch (FLAG_SECURE in MainActivity, camera
permission + no backups in the manifest, storyboard class, Swift code, Info.plist camera text, user-agent marker).
**Not verified (no Android SDK, Xcode or phone here):** that the projects compile, that WebView/WKWebView
camera access works, and that capture is really blanked on your devices.

Test on each phone before the presentation:
1. the app opens your site and the camera prompt appears;
2. a screenshot of an opened protected item is black/blank;
3. screen recording is black/blank (iPhone: the app blanks and the item is wiped);
4. a view-once item cannot be opened a second time on another device.

If the iPhone shows layout or touch problems, set `CS_USE_SECURE_LAYER = false` in `SecureViewing.swift.txt`
and rebuild; recording, mirroring and screenshot detection keep working.

## Limits
Capacitor 6: Android 7+ (WebView 60+), iOS 13+. Free-Apple-ID installs expire after 7 days. None of this stops
a second phone filming the screen; the camera guard handles that, partially.
