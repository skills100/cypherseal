/**
 * config.js — the few settings you may want to change.
 *
 * requireApp  true  = protected / view-once / self-destruct items can only be opened inside the CipherSeal
 *                     app (the website shows an install panel instead). This is what blocks screenshots
 *                     and screen recording, which a browser cannot do.
 *             false = DEMO/TESTING ONLY. New protected items can also open in a browser (no capture
 *                     blocking). Items already encrypted keep the setting they were created with.
 * androidApk  where you upload the Android app file on your hosting.
 * iosIpa        the iPhone app file you upload to your hosting (for Sideloadly, or AltStore on a computer).
 * altstoreSource the AltStore source file you upload next to it; lets AltStore on the iPhone add the app with a tap.
 * iosInstallUrl  optional: a TestFlight / App Store link after launch. When set, it replaces the manual guide.
 */
window.CS_CONFIG = {
  requireApp: true,
  androidApk: 'downloads/CipherSeal.apk',
  iosIpa: 'downloads/CipherSeal.ipa',
  altstoreSource: 'downloads/altstore.json',
  iosInstallUrl: '',
  installPage: 'install.html'
};
