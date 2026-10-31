# Build and install the iPhone app from your Mac (no GitHub needed)

Your site address for every command below: `ndlapprenticeschool.com/CYPHER`

## One-time Mac setup
1. **Xcode**: Mac App Store, free, about 10 GB+. Open it once, accept the licence, then
   Xcode -> Settings -> Platforms -> make sure **iOS** is downloaded.
2. **Node.js**: download the LTS installer from nodejs.org.
3. **CocoaPods**: in Terminal run `brew install cocoapods`
   (no Homebrew? install it from brew.sh first, or use `sudo gem install cocoapods`).
4. Unzip the project, then in Terminal: `cd path/to/cipherseal-vault/native`

## Path 1: fastest, straight onto your iPhone with Xcode (no Sideloadly / AltStore)
1. `./setup-ios.sh ndlapprenticeschool.com/CYPHER`
2. `npx cap open ios`  (opens Xcode)
3. Click the **App** project (blue icon, left) -> **Signing & Capabilities** -> tick *Automatically manage signing* -> **Team**: choose your Apple ID (Add an Account if empty). If Xcode complains about the bundle identifier, change `com.cipherseal.vault` to something unique like `com.yourname.cipherseal` (then use the same value in `native/capacitor.config.json` -> appId and rebuild).
4. Plug the iPhone in by cable, unlock it, tap **Trust**. On iOS 16+: Settings -> Privacy & Security -> **Developer Mode** -> on -> restart.
5. Pick your iPhone at the top of Xcode and press **Run** (play button).
6. First launch says "Untrusted Developer": iPhone Settings -> General -> **VPN & Device Management** -> your Apple ID -> **Trust**. Open CipherSeal.
Lasts 7 days with a free Apple ID; press Run again to renew.

## Path 2: build the .ipa on your Mac, install with Sideloadly
1. Open Terminal in the main `cipherseal-vault` project folder (the folder that contains `index.html` and the `native` folder). Run `./build-ios-ipa.sh ndlapprenticeschool.com/CYPHER`. This root-level helper runs the script inside `native` for you. Alternatively, open Terminal in the `native` folder and run `./build-ios-ipa.sh ndlapprenticeschool.com/CYPHER`. Do not run `./build-ios-ipa.sh` from an unrelated folder.
   This creates `downloads/CipherSeal.ipa` and `downloads/altstore.json` in the project.
2. Install **Sideloadly** (sideloadly.io, open the .dmg, drag to Applications).
3. Plug the iPhone in, Trust, Developer Mode on (iOS 16+).
4. Drag `downloads/CipherSeal.ipa` into Sideloadly, type your Apple ID, press **Start**.
5. iPhone Settings -> General -> VPN & Device Management -> your Apple ID -> **Trust**. Open CipherSeal.

## Path 3: AltStore (renews itself over Wi-Fi)
1. Install **AltServer** on the Mac (altstore.io) and follow its steps to install **AltStore** onto the iPhone (cable, same Apple ID).
2. Upload `downloads/CipherSeal.ipa` and `downloads/altstore.json` to your hosting folder `public_html/CYPHER/downloads/`.
3. On the iPhone, open `https://ndlapprenticeschool.com/CYPHER/install.html` in Safari -> **Add to AltStore** -> Install.
4. Keep AltServer running on the Mac on the same Wi-Fi so AltStore can renew the app every 7 days.

## Put the files on the website
cPanel -> File Manager -> `public_html/CYPHER/downloads/` -> Upload `CipherSeal.ipa`, `altstore.json` (and `CipherSeal.apk`).
The install page then shows no "not found" message.

## If something fails
Copy the last 20 lines of the Terminal output (or the Xcode error) and send them. Do not guess.


## If Terminal says “no such file or directory: ./build-ios-ipa.sh”
That means Terminal is not currently in the folder containing the script. The script is at `native/build-ios-ipa.sh`. In Terminal, first change to the unzipped project folder, then run:

```bash
cd /path/to/cipherseal-vault
./build-ios-ipa.sh ndlapprenticeschool.com/CYPHER
```

Replace `/path/to/cipherseal-vault` with the real location of your unzipped folder. You can avoid typing the path by opening Terminal in that folder.

## Android download from the website
The website's Android button downloads `downloads/CipherSeal.apk`. The source ZIP does not contain that compiled APK. Build it with the GitHub Actions workflow named “Build Android APK”, then upload the actual `CipherSeal.apk` file to `public_html/CYPHER/downloads/`. Do not upload an HTML page renamed as an APK.

## If the downloaded file ends in .apk.html or .ipa.html
That is an HTML page, not an app installer. Usually the expected APK/IPA is missing or the hosting server is returning its 404/error page for the download URL. Upload the actual compiled file with the exact filename, and test the URL directly. The updated download buttons now check the response and display an error instead of saving an HTML page as an app.
