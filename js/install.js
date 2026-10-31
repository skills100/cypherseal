(function () {
  'use strict';
  const cfg = window.CS_CONFIG || {};
  const P = window.CSPlatform;
  const p = P.current();
  const names = { android: 'Android', ios: 'iPhone / iPad', desktop: 'a computer', app: 'the CipherSeal app' };
  const $ = id => document.getElementById(id);
  $('detected').textContent = p === 'app' ? 'You are already using the CipherSeal app.' : 'We detected ' + names[p] + '. Your section is highlighted below.';
  const sec = $(p === 'app' ? 'android' : p);
  if (sec && p !== 'app') sec.classList.add('here');

  const abs = rel => new URL(rel, location.href).href;
  const apk = $('apkLink'), ipa = $('ipaLink'), alt = $('altLink');
  apk.href = cfg.androidApk || 'downloads/CipherSeal.apk';
  ipa.href = cfg.iosIpa || 'downloads/CipherSeal.ipa';
  const altUrl = abs(cfg.altstoreSource || 'downloads/altstore.json');

  // Downloads: a missing file shows a message instead of a blank 404 page.
  P.guardDownload(apk, $('apkStatus'), 'The Android app file');
  P.guardDownload(ipa, $('ipaStatus'), 'The iPhone app file');

  // "Add to AltStore" is a link that only an iPhone with AltStore can open; elsewhere it shows "address not found".
  if (p === 'ios') {
    alt.href = 'altstore://source?url=' + encodeURIComponent(altUrl);
  } else {
    alt.removeAttribute('href');
    alt.classList.add('disabled');
    alt.textContent = 'Add to AltStore (open this page on your iPhone)';
    alt.addEventListener('click', e => { e.preventDefault(); $('altStatus').hidden = false; $('altStatus').textContent = 'This button works only on an iPhone that already has AltStore installed. Open this page in Safari on the iPhone. On a computer, use Sideloadly with the Download button instead.'; });
  }
  const exists = url => fetch(url, { method: 'HEAD', cache: 'no-store' }).then(r => r.ok, () => false);
  Promise.all([exists(ipa.href), exists(altUrl), exists(apk.href)]).then(([i, a, k]) => {
    const team = [!i && 'CipherSeal.ipa', !a && 'altstore.json', !k && 'CipherSeal.apk'].filter(Boolean);
    if (team.length) { const n = $('teamStatus'); n.hidden = false; n.textContent = 'Project team: not found in the downloads folder yet: ' + team.join(', ') + '. Build them, then upload to the downloads folder (see downloads/README.txt).'; }
  });
})();
