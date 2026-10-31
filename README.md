# CipherSeal Vault

A free, **no-login, no-server** zero-trust encryption vault for academic
records and private files. Built for the final-year project:
**"Design and Implementation of a Zero-Trust Secure File Vault with
AES-256-GCM and Dynamic Key Derivation for Academic Records Protection."**

Open `index.html` — there is nothing to install, nothing to sign up for,
and nothing is ever uploaded anywhere. Everyone is a guest; there is no
account system for anyone — including the project owner — to manipulate.

## Why "zero-trust" with no server at all

Zero trust means *never trust, always verify* — no request is treated as
safe just because it came from inside a perimeter or an earlier login.
CipherSeal Vault pushes this to its logical extreme: there is no server
to trust in the first place, so nothing can be breached there. Every
single decryption attempt is independently re-verified from scratch, in
the browser, against the cryptographic evidence bound into the item
itself:

- the AES-256-GCM authentication tag (did the password and the exact
  bytes match, byte for byte?),
- a SHA-256 digest of the recovered content (did anything else get
  corrupted?), and
- a local, per-item attempt counter (has this specific item already
  been guessed wrong too many times, or already been decrypted once, on
  *this* device?).

Nothing from a previous successful decryption is ever trusted for a
later one.

## v4.3 — final feature set (read this first)

### What opens where

| | Web browser | Android app | iPhone app |
|---|---|---|---|
| Standard encryption (any file, up to 50 MB) | works | works | works |
| Protected / view-once / self-destruct | **not opened**: an install panel is shown, nothing used up | works | works |
| Screenshot | n/a | **black** (`FLAG_SECURE`) | **blank** (secure layer) and detected, item wiped |
| Screen recording / mirroring | n/a | **black** | app **blanks at once**, item wiped; opening while recording is refused |
| One person only (camera) | n/a | yes | yes |
| Opened twice / on a 2nd device | impossible | impossible | impossible |
| Wrong-password lockout, expiry | yes | yes | yes |
| Install | none | APK from your hosting (allow "unknown apps") | IPA from your hosting via Sideloadly (cable) or the one-tap AltStore source (free Apple ID, 7-day refresh) until the App Store |

Computers: protected items show an install panel ("open this on your phone"). A
desktop app is not built. In `js/config.js`, `requireApp: false` lets new protected
items open in a browser for DEMO/TESTING only (no capture blocking).

### How it works

**Release service (the one server piece, `api/release.php`, PHP + SQLite).** A
browser-only app can never make "view once" true across devices. So view-once,
self-destruct and app-only protected items keep one random 256-bit *key share*
on the server, released **exactly once** for one-time items (atomic, serialised
transaction). Without the share the file cannot be decrypted anywhere, with any
password. The server never sees the password, the content or the ciphertext:
only the item ID, a password *proof* and the share. Three wrong proofs lock the
item on **every** device. Items can expire (1 hour to 1 year).

**Separate encryption per mode.** Protected, View-once and Self-destruct are
separate choices; the mode is authenticated in the header and bound into the key
(HKDF), so each uses different key material. "Combine modes" is opt-in.

**App-only.** The apps add `CipherSealApp/1` to their user-agent.
`js/platform.js` detects Android / iPhone / iPad / computer / app and shows the
install panel; the release service also refuses the key to anything without the
marker. (A modified browser could fake the marker; Play Integrity / App Attest is
the upgrade after launch.) Protected items in the app can be reopened; view-once
and self-destruct items open once.

**Personal view (camera, `js/camguard.js`, on-device, nothing recorded).** Exactly
one face and no phone before anything opens. While viewing: a second face, a
phone or a covered lens hides the content **at once**; the camera keeps
re-checking and the content returns about 8 s after the view is clear. One noisy
frame hides it ~2 s at no cost. Three separate confirmed violations end the
session; nobody in front of the screen for 10 s ends it.

**Open order for one-time items:** password proof -> camera check -> one-time key
release -> decrypt -> display. A refused camera or a phone in view never burns an item.

**Apps and cloud builds.** See `native/README.md` and `install.html`. The iOS workflow outputs `CipherSeal.ipa` and `altstore.json` (artifacts and a Releases link); upload both to `public_html/CYPHER/downloads/`. Build locally on a Mac from the project root with `./build-ios-ipa.sh ndlapprenticeschool.com/CYPHER` (the helper calls the script in `native/`). The site links to these files, including a one-tap "Add to AltStore" button. The
GitHub workflows in `.github/workflows` build the APK and an unsigned IPA without
Android Studio or a Mac (macOS minutes count 10x on private repos).

### Honest limits (important)
- **Browsers cannot block OS screenshots or screen recording.** That is why protected items open only in the apps.
- **iPhone** blanking uses an undocumented secure-layer behaviour plus detection;
  a screenshot is detected after it is taken, so the guarantee is weaker than
  Android's. It has an off switch and must be re-tested after iOS updates.
- **The apps were generated and patched by the scripts here (patches verified)
  but never compiled or run on a phone in this environment.** Test capture
  blocking on your own devices before the presentation.
- **The camera only sees what the front camera sees.** A phone behind the viewer,
  out of frame, or a second camera elsewhere is invisible. It can miss a phone in
  poor light and occasionally mistake an object for one. Tune `createJudge()`.
- **Once the share is released, the viewer's device holds the content.** A modified
  device could save it; the service guarantees nobody opens a *second* copy.
- **Server breach:** stolen shares plus password-proof hashes reduce security to
  "file + offline password guessing" (what v3 always was).
- Needs HTTPS (camera) and PHP with SQLite (Namecheap Stellar has both).
- The service rate-limits per IP (300 checks / 10 min); a campus behind one IP is fine.

### Deploying on Namecheap Stellar (cPanel)
1. In cPanel, **Domains/SSL**: make sure AutoSSL has issued HTTPS for your domain. The camera guard only works on HTTPS.
2. **File Manager -> public_html**: upload the *contents* of this folder (`index.html`, `css/`, `js/`, `vendor/`, `api/`, `data/`, `assets/`, `.htaccess`, ...). Turn on "Show hidden files" so `.htaccess` and `api/.htaccess` come across. **Do not upload** `tests/`, `native/` or `package.json` (they are blocked anyway).
3. **MultiPHP Manager**: choose PHP 8.1 or newer for the domain. **Select PHP Version -> Extensions**: confirm `pdo_sqlite` is ticked (it is by default).
4. Open `https://yourdomain.com/api/release.php` in a browser. You should see `{"error":"POST only"}`. That means the release service is alive.
5. The database is created automatically at `/home/<cpanel-user>/cipherseal_data/release.sqlite`, **above** public_html so it can never be downloaded. If that folder cannot be created it falls back to `api/data/` (blocked by `.htaccess`).
6. Encrypt a view-once test item, copy it to a second device and confirm the second open is refused.

Also replace `data/recovery-public-key.json` with your own key and update the canonical URLs, as in the original steps below.

### Item expiry
For view-once and self-destruct items the sender picks how long the item stays
openable if nobody opens it (1 hour to 1 year, default 7 days). When that time
passes the release service deletes the key share, so the file is permanently
unopenable by anyone. Dead rows are purged 30 days later.

### Putting the app files on the site
Upload the actual compiled `CipherSeal.apk` to `public_html/CYPHER/downloads/` (for this deployment path). The source ZIP does not include compiled APK/IPA installers; build them separately and upload the resulting files with the exact names. iPhone users cannot install from a link; see `install.html`.

### Tests that exist
`npm test` runs `tests/core.test.js` (28 checks against the real PHP service, including secure-app-only:
separate modes, one-time release, 12 parallel claims with one winner, global
lockout, tamper and mode-relabel rejection, expiry, purge, input hardening;
needs `php` with `pdo_sqlite` installed locally) `tests/platform.test.js` (7 device-detection checks), `tests/altstore.test.js` (3 checks) and `tests/camguard.test.js` (11 checks on the hide / recheck / return /
strike logic for phone, second face, covered lens and absence). `tests/e2e.py` predates
v4 and still expects the old no-server flow; it needs updating before use.


## Folder structure (kept separate by technology, not one combined file)

```
cipherseal-vault/
├── index.html                   Markup and SEO metadata only
├── css/
│   └── style.css                Design system, 3D padlock, 3D tech badges, viewer
├── js/
│   ├── crypto.js                AES-256-GCM + dynamic PBKDF2 + container format
│   │                             + DOCX/PDF text extraction for protected view
│   ├── password.js              Strong password generator and strength estimate
│   ├── guard.js                 Wrong-password warning/lockout, view-once registry
│   ├── viewer.js                Self-destruct timer, protected view, consent-gated
│   │                             camera obstruction check and capture deterrents
│   ├── padlock.js                Interactive 3D padlock animation
│   └── app.js                   Wires the UI together (tabs, encrypt/decrypt/recover)
├── data/
│   └── recovery-public-key.json  Owner's PUBLIC recovery key only (safe to publish)
├── tools/
│   └── generate-recovery-keypair.html   Offline helper to make your own key pair
├── tests/
│   ├── serve.py                  Local static server with the same CSP as production
│   └── e2e.py                    58-check automated test suite (Playwright)
├── assets/img/                  Favicon, OG image, padlock.gif fallback
├── api/release.php              One-time key release service (PHP + SQLite)
├── native/                      Android wrapper (FLAG_SECURE) — see native/README.md
├── vendor/human/                On-device face/phone detector + models
├── robots.txt, sitemap.xml, manifest.json, .htaccess
```

No PHP, no database, no API — `data/recovery-public-key.json` is the only
file ever fetched, and it contains only a *public* key.

## How each requested feature works

**Guest-only, no server to manipulate.** There is no account system and
no backend to attack: every cryptographic operation runs through the
browser's native Web Cryptography API. A strict Content-Security-Policy
(`script-src 'self'`, no `unsafe-eval`, no third-party connect targets)
is sent by `.htaccess`, so
even a compromised dependency could not phone home. The automated test
suite independently confirms the page makes zero network requests other
than to its own origin.

**3D padlock, with a GIF fallback.** `js/padlock.js` builds a real CSS-3D
object (stacked layers for thickness) and animates it through one loop:
turn to the side, the key slides in along the Z axis, it turns, the
shackle lifts and swings open, then it reverses to lock again. Move the
pointer over it to tilt it in 3D; click to pause/resume.
`assets/img/padlock.gif` is a rendered-frame GIF of the same animation,
shown by the `<noscript>` fallback and used as the Open Graph preview
image.

**Logo placeholder.** `#logoSlot` renders "CS" in a dashed box by
default; drop a real `assets/img/logo.png` in and `app.js` swaps it in
automatically (see the `logo()` function).

**Auto-generated strong password, with a mandatory copy-first gate.**
`js/password.js` generates a 40-character password from a browser-CSPRNG
with Fisher–Yates shuffling (crypto.getRandomValues, no Math.random
anywhere). Clicking **Encrypt it** does not encrypt immediately — it
opens a modal that shows the password and keeps the real **"I copied it
— encrypt now"** button disabled until the password has actually been
copied (or the person confirms they copied it by hand, for browsers
that block clipboard access). A visitor can also switch to typing their
own password, which is checked against a strength estimator and
rejected if it is too weak.

**Disappearing files: self-destruct timer + view once.** Both policies
are stored *inside* the encrypted item (as authenticated metadata, so
they cannot be stripped without invalidating the AES-GCM tag). A timer
policy shows a countdown ring and wipes the decrypted content from
memory when it reaches zero. A view-once policy records, in this
browser's local storage, that this item's ID has already been displayed,
and refuses to decrypt it again — even with the correct password.
Timed and view-once items require Protected view so the viewer does not
offer a direct file download. Before display, the viewer asks for camera
permission; denying or canceling does not consume view-once. Once shown,
the item is consumed. Camera loss or sustained near-total darkness or
obstruction ends the current viewing session.

**Protected view: no copy, no share, no save, screenshot and DevTools
deterrents — for text, Word, PDF and images.** `js/viewer.js` paints
content onto a `<canvas>` instead of leaving it as selectable DOM text,
blocks copy/cut/print/select-all/right-click, blanks the canvas
whenever the tab loses focus or visibility (the usual moment a
screen-share or capture tool takes over), and listens for PrintScreen /
snipping shortcuts and a heuristic DevTools-open detector (comparing
the outer window to the inner viewport, since DevTools panels widen
that gap) — each attempt blanks the content, tries to clear the
clipboard, and three attempts end the session and wipe the content for
good. Plain text and images are painted directly; Word (`.docx`) files
have their text extracted from the underlying OOXML zip (`js/crypto.js`
→ `extractDocxText`, using the native `DecompressionStream` API — no
bundled library) and PDFs have their text extracted from FlateDecode
content streams (`extractPdfText`) — both best-effort: exact layout,
embedded images and tables are not reproduced, but the readable text
never touches the DOM as selectable content. **Honest limit:** no web
page can stop a phone camera pointed at the screen, or true OS-level
screen recording; this defeats the common software capture and
inspection routes, and the burned-in, moving per-session watermark
makes anything that does get through traceable back to that specific
decryption. View-once and timed items additionally require Protected view
and explicit camera permission before display. The viewer samples a tiny,
downscaled camera frame locally and ends the session only when the camera
feed stays near-black/obstructed; frames are neither stored nor uploaded.
This can have false positives/negatives and cannot reliably identify a
nearby phone or prove that recording is not happening. Camera access needs
HTTPS (or localhost), browser support, user permission, and the site's
camera allowance in its hosting `Permissions-Policy`.

**Wrong-password warnings, then lockout.** `js/guard.js` tracks attempts
per item (by the random ID embedded in its authenticated header — an ID
that cannot be reset without the ciphertext failing to authenticate at
all). The 1st wrong password shows a warning, the 2nd shows a final
warning, and the 3rd locks and visually "damages" the item for good on
this device. Only a fresh item re-encrypted by the sender can be
decrypted after that.

## Dynamic key derivation

PBKDF2-HMAC-SHA-256's iteration count is **not** a fixed constant. It is
computed per item from the sensitivity level chosen at encryption time
(Public / Internal / Confidential / Restricted) multiplied against a
quick on-device PBKDF2 timing probe, so a 2026-model laptop and a
budget phone both get an appropriately costly — but not punishingly
slow — key derivation. See `planIterations()` and `deviceIndex()` in
`js/crypto.js`. The chosen iteration count travels inside the item's
authenticated header, so changing it after the fact invalidates the
AES-GCM tag.

## Running it

Just open `index.html` in a browser — it works from the local
filesystem for encrypting/decrypting/recovering. To also exercise the
strict CSP exactly as production will send it (and to let `fetch()`
load `data/recovery-public-key.json`, which some browsers block from
`file://`), serve the folder instead:

```
python3 tests/serve.py 8765
# then open http://127.0.0.1:8765/index.html
```

Deploy on Namecheap Stellar using the steps in "Deploying on Namecheap Stellar" above (the release service needs PHP, so static-only hosts will not work for view-once and self-destruct). Then:

1. Run `tools/generate-recovery-keypair.html` **locally, offline**, and
   replace `data/recovery-public-key.json` with your own public key.
   Keep the matching private key off the server entirely.
2. Update the canonical/OG URLs in `index.html`, `robots.txt` and
   `sitemap.xml` to your real deployed domain.
3. Submit `sitemap.xml` in Google Search Console so Google indexes it.

## Testing

`tests/e2e.py` is a 58-assertion Playwright suite covering the password
generator, the dynamic iteration schedule, AES-GCM tamper rejection on
every header field, the copy-password gate, the 1st/2nd/3rd
wrong-password warning and lockout sequence, view-once, the
self-destruct timer, protected-view canvas rendering for text, images,
a real deflate-compressed `.docx` and a hand-built FlateDecode `.pdf`,
their copy/print/PrintScreen/DevTools-open deterrents, focus-loss
blanking, owner recovery (and its refusal when not enabled),
byte-identical file round-trips, and a check that the page makes zero
network requests beyond its own origin. Run it with the server from the
previous section already running:

```
python3 tests/e2e.py
```
