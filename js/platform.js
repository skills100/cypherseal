/**
 * platform.js — device detection + the "install the app" panel.
 * The detector is a pure function (tests/platform.test.js).
 */
(function (global) {
  'use strict';

  /** @returns {'app'|'android'|'ios'|'desktop'} */
  function detectPlatform(ua, platform, touchPoints) {
    ua = ua || '';
    if (/CipherSealApp\//.test(ua)) return 'app';                       // inside our wrapper (Android or iOS)
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (platform === 'MacIntel' && touchPoints > 1) return 'ios';       // iPadOS Safari pretends to be a Mac
    return 'desktop';
  }

  const current = () => detectPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints || 0);
  global.CS_IN_APP = current() === 'app';

  function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }
  function link(text, href, cls, download) {
    const a = el('a', text, cls); a.href = href;
    if (download) a.setAttribute('download', '');
    return a;
  }

  /**
   * Makes a download link safe: if the file is not on the server yet, show a clear message instead of
   * navigating to a blank 404 page.
   */
  function guardDownload(a, noteEl, what) {
    a.addEventListener('click', async e => {
      e.preventDefault();
      a.setAttribute('aria-busy', 'true');
      const fail = message => {
        noteEl.hidden = false;
        noteEl.textContent = message;
        a.removeAttribute('aria-busy');
      };
      try {
        // Fetch the actual file rather than navigating to the URL. Some shared hosts
        // return the website's HTML 404 page with status 200; downloading that page
        // creates misleading files such as CipherSeal.apk.html.
        const response = await fetch(a.href, { cache: 'no-store' });
        if (!response.ok) throw new Error('The server returned HTTP ' + response.status + '.');
        const type = (response.headers.get('content-type') || '').toLowerCase();
        const blob = await response.blob();
        if (!blob.size || type.includes('text/html') || type.includes('application/xhtml')) {
          throw new Error('The hosting server returned a web page instead of the app file.');
        }
        const objectUrl = URL.createObjectURL(blob);
        const downloadLink = document.createElement('a');
        downloadLink.href = objectUrl;
        downloadLink.download = a.href.split('/').pop().split('?')[0];
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
        a.removeAttribute('aria-busy');
      } catch (error) {
        fail(what + ' could not be downloaded. ' + error.message + ' Check that the real file exists in public_html/CYPHER/downloads/ and that its name ends exactly in .apk or .ipa.');
      }
    });
  }

  /** Fills `box` with the install panel for this device. */
  function renderInstallPanel(box) {
    const cfg = global.CS_CONFIG || {};
    const p = current();
    box.textContent = '';
    box.hidden = false;
    const missing = el('p', '', 'appgate-note'); missing.hidden = true;
    box.appendChild(el('h3', 'Open this item in the CipherSeal app'));
    box.appendChild(el('p', 'This item is protected against screenshots and screen recording. Web browsers cannot enforce that, so it opens only inside the CipherSeal app. Nothing has been used up.'));

    if (p === 'android') {
      const apk = link('Download the Android app', cfg.androidApk || 'downloads/CipherSeal.apk', 'btn-primary appgate-btn', true);
      guardDownload(apk, missing, 'The Android app file'); box.appendChild(apk); box.appendChild(missing);
      const ol = el('ol');
      ['Open the downloaded file. If Android asks, allow your browser to install unknown apps.',
       'If Play Protect warns about an unrecognised app, tap More details, then Install anyway. This is expected: the app is not on the Play Store yet.',
       'Open CipherSeal, choose this same file again and enter the password.'].forEach(t => ol.appendChild(el('li', t)));
      box.appendChild(ol);
      box.appendChild(link('Full Android guide', (cfg.installPage || 'install.html') + '#android', 'appgate-more'));
    } else if (p === 'ios') {
      const abs = rel => new URL(rel, location.href).href;
      if (cfg.iosInstallUrl) {
        box.appendChild(link('Install on iPhone / iPad', cfg.iosInstallUrl, 'btn-primary appgate-btn'));
      } else {
        box.appendChild(el('p', 'iPhone and iPad: the app is not on the App Store yet. Until launch it is installed with AltStore or Sideloadly using a free Apple ID (it must be refreshed every 7 days).', 'appgate-note'));
        box.appendChild(link('Add to AltStore (needs AltStore installed)', 'altstore://source?url=' + encodeURIComponent(abs(cfg.altstoreSource || 'downloads/altstore.json')), 'btn-primary appgate-btn'));
        box.appendChild(document.createElement('br'));
        const ipa = link('Download CipherSeal.ipa (for Sideloadly)', cfg.iosIpa || 'downloads/CipherSeal.ipa', 'appgate-more', true);
        guardDownload(ipa, missing, 'The iPhone app file'); box.appendChild(ipa); box.appendChild(missing);
        box.appendChild(document.createElement('br'));
      }
      box.appendChild(link('Step-by-step iPhone guide', (cfg.installPage || 'install.html') + '#ios', 'appgate-more'));
    } else {
      box.appendChild(el('p', 'You are on a computer. Open this file on an Android phone or iPhone that has the CipherSeal app. A desktop app is planned for after launch.', 'appgate-note'));
      box.appendChild(link('Get the app for your phone', (cfg.installPage || 'install.html'), 'appgate-more'));
    }
  }

  global.CSPlatform = { detectPlatform, current, renderInstallPanel, guardDownload };
  if (typeof module !== 'undefined') module.exports = { detectPlatform };
})(typeof window !== 'undefined' ? window : globalThis);
