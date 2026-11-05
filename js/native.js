/*
 * CipherSeal native helpers (apps only; harmless in an ordinary browser).
 *
 *  - saveBytes(): inside the Android / iPhone app a normal <a download> link does nothing, because the
 *    app's web view cannot download blob files. So the file is written to the app's cache folder with
 *    the Capacitor Filesystem plugin and the system share sheet is opened with the Capacitor Share
 *    plugin ("Save to Files" on iPhone). In a browser the usual download is used.
 *  - setSecure(): asks the iPhone app to hide the screen from screenshots and recordings only while a
 *    protected item is open (see native/SecureViewing.swift.txt). No effect elsewhere.
 */
(function (global) {
  'use strict';

  function cap() { return global.Capacitor; }
  function inApp() { try { return !!(cap() && cap().isNativePlatform && cap().isNativePlatform()); } catch (e) { return false; } }

  function toBase64(bytes) {
    let s = ''; const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return global.btoa(s);
  }
  function safeName(n) { return String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120) || 'file'; }
  function cancelled(e) { return !!e && (e.name === 'AbortError' || /cancel|dismiss|abort/i.test(String(e.message || e))); }

  async function saveBytes(name, data, mime) {
    name = safeName(name);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const type = mime || 'application/octet-stream';

    if (inApp()) {
      const plugins = (cap() && cap().Plugins) || {};
      if (plugins.Filesystem && plugins.Share) {
        try {
          const written = await plugins.Filesystem.writeFile({ path: name, data: toBase64(bytes), directory: 'CACHE', recursive: true });
          await plugins.Share.share({ title: name, url: written.uri, dialogTitle: 'Save ' + name });
          return 'shared';
        } catch (e) { if (cancelled(e)) return 'cancelled'; /* otherwise try the next route */ }
      }
      try {
        const file = new File([bytes], name, { type });
        if (global.navigator.canShare && global.navigator.canShare({ files: [file] })) {
          await global.navigator.share({ files: [file], title: name });
          return 'shared';
        }
      } catch (e) { if (cancelled(e)) return 'cancelled'; }
    }

    const url = global.URL.createObjectURL(new Blob([bytes], { type }));
    const a = global.document.createElement('a');
    a.href = url; a.download = name;
    global.document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => global.URL.revokeObjectURL(url), 2000);
    return 'downloaded';
  }

  function setSecure(on) {
    try {
      const h = global.webkit && global.webkit.messageHandlers && global.webkit.messageHandlers.csSecure;
      if (h) h.postMessage(!!on);
    } catch (e) { /* not the iPhone app: nothing to do */ }
  }

  global.CSNative = { inApp, saveBytes, setSecure };
})(typeof window !== 'undefined' ? window : globalThis);
