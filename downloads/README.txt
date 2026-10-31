CIPHERSEAL APP DOWNLOAD FILES

This folder in the source ZIP is intentionally empty. The APK and IPA are compiled
installation packages; they are not included in the website source archive.

For Android, build CipherSeal.apk using GitHub Actions -> Build Android APK, then
upload the downloaded APK to this folder on your hosting.

For iPhone/iPad, build CipherSeal.ipa and altstore.json on a Mac using
./build-ios-ipa.sh ndlapprenticeschool.com/CYPHER (from the project root), or use
GitHub Actions -> Build iOS IPA. Upload BOTH files to this folder.

The live hosting folder must be:
  public_html/CYPHER/downloads/

The exact filenames must be:
  CipherSeal.apk
  CipherSeal.ipa
  altstore.json

Do not rename the files, add .html, or upload a browser error page. Make sure the
files are actual compiled APK/IPA files. After upload, test the links on the live
install page. The page checks that it receives a file, not an HTML error page.

For detailed Mac instructions, read native/MAC-GUIDE.md.
