"""End-to-end tests for CipherSeal Vault (run: python3 tests/serve.py 8765 &  python3 tests/e2e.py)."""
import json, base64, os, sys
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8765/index.html"
SHOTS = "/home/claude/shots2"
os.makedirs(SHOTS, exist_ok=True)
results = []
def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("PASS " if cond else "FAIL ") + name + (" :: " + str(extra) if extra and not cond else ""))

# tiny valid PNG (red 40x24)
import zlib, struct
def png(w=240, h=120):
    raw = b''.join(b'\x00' + bytes([200, 40, 60] * w) for _ in range(h))
    def ch(t, d): 
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b'')
open('/tmp/test.png', 'wb').write(png())
open('/tmp/note.txt', 'w').write('Official transcript (SAMPLE)\nName: Jane A. Adebayo\nCGPA: 4.52\n')

# ---- minimal real .docx (a genuine deflate-compressed OOXML zip)
import zipfile
DOCX_PARA_1 = "Result Sheet (SAMPLE) \u2014 300 Level, First Semester"
DOCX_PARA_2 = "Student: Jane A. Adebayo. CGPA: 4.52. This paragraph exists to confirm protected-view DOCX text extraction."
def make_docx(path):
    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:body>'
        f'<w:p><w:r><w:t>{DOCX_PARA_1}</w:t></w:r></w:p>'
        f'<w:p><w:r><w:t>{DOCX_PARA_2}</w:t></w:r></w:p>'
        '</w:body></w:document>'
    )
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '</Relationships>')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('_rels/.rels', rels)
        z.writestr('word/document.xml', document_xml)
make_docx('/tmp/sample.docx')

# ---- minimal real .pdf (hand-built, one page, zlib/FlateDecode content stream with Tj text)
def make_pdf(path):
    content = b"BT /F1 18 Tf 72 720 Td (Official Transcript (SAMPLE)) Tj ET\nBT /F1 14 Tf 72 690 Td (Protected PDF text extraction check.) Tj ET"
    stream = zlib.compress(content)
    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    objs.append(b"<< /Length " + str(len(stream)).encode() + b" /Filter /FlateDecode >>\nstream\n" + stream + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(objs)+1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF".encode()
    open(path, 'wb').write(bytes(out))
make_pdf('/tmp/sample.pdf')

def wait_js(pg, expr, timeout=12000, interval=100):
    """Poll a JS boolean expression via page.evaluate (wait_for_function uses
    eval() internally, which our strict CSP script-src 'self' correctly blocks)."""
    waited = 0
    while waited < timeout:
        if pg.evaluate(expr):
            return True
        pg.wait_for_timeout(interval)
        waited += interval
    raise TimeoutError(f"wait_js timed out: {expr}")

def new_ctx(browser):
        ctx = browser.new_context(viewport={"width": 1100, "height": 900}, accept_downloads=True)
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin="http://127.0.0.1:8765")
        ctx.add_init_script("""(() => {
            const media = navigator.mediaDevices || {};
            Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: Object.assign({}, media, {
                getUserMedia: async () => {
                    if (window.__denyCamera) { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }
                    const c = document.createElement('canvas'); c.width = 64; c.height = 48;
                    const x = c.getContext('2d'); x.fillStyle = '#b0b0b0'; x.fillRect(0, 0, c.width, c.height);
                    window.__fakeCameraCanvas = c;
                    return c.captureStream(10);
                }
            }) });
        })();""")
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "404" not in m.text else None)
    return ctx, pg, errs

def do_encrypt(pg, text="", file=None, sens="restricted", timer=None, once=False, prot=False, recovery=False):
    pg.click('.tab[data-tab="encrypt"]')
    pg.fill('#encryptMessage', text)
    if file: pg.set_input_files('#encryptFile', file)
    pg.select_option('#encryptSensitivity', sens)
    for sel, on in (('#optOnce', once), ('#optProtected', prot), ('#optRecovery', recovery)):
        if pg.is_checked(sel) != on: pg.click(sel)
    if timer:
        if not pg.is_checked('#optTimer'): pg.click('#optTimer')
        pg.fill('#optSeconds', str(timer))
    pg.click('#encryptBtn')
    pg.wait_for_selector('#pwModal:not([hidden])')
    pw = pg.inner_text('#pwModalValue')
    check("copy gate: encrypt button disabled before copy", pg.is_disabled('#pwModalGo'))
    pg.click('#pwModalCopy')
    wait_js(pg, "!document.getElementById('pwModalGo').disabled")
    clip = pg.evaluate("navigator.clipboard.readText()")
    check("copy gate: clipboard holds the generated password", clip == pw)
    pg.click('#pwModalGo')
    pg.wait_for_selector('#encryptOut:not([hidden])', timeout=20000)
    return pw

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx, pg, errs = new_ctx(browser)
    pg.goto(URL); pg.wait_for_timeout(500)

    # ---- unit-level crypto checks inside the browser
    r = pg.evaluate("""async () => {
      const C = window.CSCrypto, out = {};
      const pw = CSPassword.generate(40);
      out.pwLen = pw.length;
      out.classes = [/[A-Z]/,/[a-z]/,/[2-9]/,/[!@#$%^&*\\-_=+?]/].every(r => r.test(pw));
      out.noAmbig = !/[0O1lI]/.test(pw);
      out.unique = new Set(Array.from({length:50}, () => CSPassword.generate(40))).size;
      const s = await C.encrypt({text:'hello vault', password: pw, sensitivity:'confidential', policy:{viewSeconds:20,viewOnce:true,protected:true}});
      const o = await C.decrypt(s.bytes, pw);
      out.roundtrip = o.text === 'hello vault' && o.meta.policy.viewOnce && o.meta.policy.protected && o.meta.policy.viewSeconds === 20;
      out.iters = s.iterations;
      // tamper with each header region and with ciphertext
      const flips = {itemId: 10, salt: 30, iv: 45, iters: 51, ct: s.bytes.length - 5};
      out.tamper = {};
      for (const [k, idx] of Object.entries(flips)) {
        const b = s.bytes.slice(); b[idx] ^= 1;
        try { await C.decrypt(b, pw); out.tamper[k] = 'OPENED'; } catch (e) { out.tamper[k] = e.code; }
      }
      // unsafe iteration count rejected before any work
      const b2 = s.bytes.slice(); b2[50]=255;b2[51]=255;b2[52]=255;b2[53]=255;
      try { C.parseHeader(b2); out.dos = 'accepted'; } catch (e) { out.dos = 'refused'; }
      try { await C.decrypt(s.bytes, 'wrong password'); out.wrong = 'opened'; } catch (e) { out.wrong = e.code; }
      // iteration plan is dynamic and monotonic in sensitivity
      out.plan = ['public','internal','confidential','restricted'].map(k => C.planIterations(k, 0.5));
      return out;
    })();""")
    check("generator: 40 chars, all classes, no ambiguous chars", r['pwLen'] == 40 and r['classes'] and r['noAmbig'])
    check("generator: 50 passwords all unique", r['unique'] == 50)
    check("encrypt/decrypt round trip keeps policy inside ciphertext", r['roundtrip'])
    check("PBKDF2 floor respected (>=250k)", r['iters'] >= 250000, r['iters'])
    check("tamper: item ID / salt / IV / iterations / ciphertext all rejected", all(v in ('BAD_KEY', 'BAD_INPUT') for v in r['tamper'].values()), r['tamper'])
    check("unsafe iteration count refused before deriving", r['dos'] == 'refused')
    check("wrong password -> BAD_KEY", r['wrong'] == 'BAD_KEY')
    check("dynamic iterations increase with sensitivity", r['plan'] == sorted(r['plan']) and len(set(r['plan'])) == 4, r['plan'])

    # ---- custom password strength rule
    pg.click('#pwModeBtn'); pg.fill('#pwField', 'password123')
    pg.fill('#encryptMessage', 'x'); pg.click('#encryptBtn')
    check("weak own password is rejected", 'weak' in pg.inner_text('#encryptErr').lower())
    pg.click('#pwModeBtn')
    pg.fill('#encryptMessage', '')

    # ---- 1. lockout: wrong password 1st, 2nd warnings, 3rd locks & damages
    pw1 = do_encrypt(pg, text="Final exam script v1", sens="restricted")
    encrypted1 = pg.input_value('#encryptedText')
    pg.screenshot(path=f"{SHOTS}/04_encrypted_output.png", full_page=False)
    pg.click('.tab[data-tab="decrypt"]'); pg.fill('#decryptText', encrypted1)
    pg.wait_for_selector('#decryptInfo:not([hidden])')
    pg.fill('#decryptPassword', 'Wrong-Guess-1!'); pg.click('#decryptBtn'); pg.wait_for_selector('#decryptWarn.show')
    w1 = pg.inner_text('#decryptWarn')
    check("1st wrong password -> warning 1 of 2", 'warning 1 of 2' in w1.lower(), w1)
    pg.screenshot(path=f"{SHOTS}/05_warning1.png")
    pg.fill('#decryptPassword', 'Wrong-Guess-2!'); pg.click('#decryptBtn'); wait_js(pg, "document.getElementById('decryptWarn').textContent.includes('Final')")
    check("2nd wrong password -> final warning", 'final warning' in pg.inner_text('#decryptWarn').lower())
    pg.screenshot(path=f"{SHOTS}/06_warning2.png")
    pg.fill('#decryptPassword', 'Wrong-Guess-3!'); pg.click('#decryptBtn'); pg.wait_for_selector('#decryptErr.show')
    check("3rd wrong password -> item damaged/locked", 'damaged' in pg.inner_text('#decryptErr').lower())
    check("inputs wiped after lock", pg.input_value('#decryptText') == '')
    pg.screenshot(path=f"{SHOTS}/07_locked.png")
    pg.fill('#decryptText', encrypted1); pg.fill('#decryptPassword', pw1); pg.click('#decryptBtn'); pg.wait_for_selector('#decryptErr.show')
    check("locked item refuses even the CORRECT password", 'locked' in pg.inner_text('#decryptErr').lower())
    check("viewer did not open for locked item", pg.is_hidden('#viewer'))

    # ---- 2. fresh item from sender works (new item ID)
    pw2 = do_encrypt(pg, text="Final exam script v2 (fresh)", sens="restricted")
    encrypted2 = pg.input_value('#encryptedText')
    pg.click('.tab[data-tab="decrypt"]'); pg.fill('#decryptText', encrypted2); pg.fill('#decryptPassword', pw2); pg.click('#decryptBtn')
    pg.wait_for_selector('#viewer:not([hidden])')
    check("fresh item decrypts after the old one was locked", pg.query_selector('#viewerText') is not None and 'fresh' in pg.input_value('#viewerText'))
    pg.click('#viewerClose')

    # ---- 3. view-once + timer + protected (text)
    pw3 = do_encrypt(pg, text="TOP SECRET: view once, 6 seconds, protected", sens="confidential", timer=6, once=True, prot=True)
    encrypted3 = pg.input_value('#encryptedText')
    pg.click('.tab[data-tab="decrypt"]'); pg.fill('#decryptText', encrypted3); pg.fill('#decryptPassword', pw3); pg.click('#decryptBtn')
    pg.wait_for_selector('#cameraGate:not([hidden])')
    check("view-once/timed item requires explicit camera consent", pg.is_visible('#cameraStart'))
    pg.evaluate("window.__denyCamera = true")
    pg.click('#cameraStart'); wait_js(pg, "document.getElementById('cameraStatus').textContent.includes('denied')")
    check("denied camera permission does not reveal or consume the item", pg.is_visible('#cameraGate') and pg.is_hidden('#viewerText'))
    pg.click('#cameraCancel')
    pg.evaluate("window.__denyCamera = false")
    pg.fill('#decryptText', encrypted3); pg.fill('#decryptPassword', pw3); pg.click('#decryptBtn')
    pg.wait_for_selector('#cameraGate:not([hidden])'); pg.click('#cameraStart')
    pg.wait_for_selector('#viewer:not([hidden]) canvas.pcanvas')
    pg.wait_for_timeout(600)
    check("camera stream is active during protected view", pg.evaluate("!!document.getElementById('cameraPreview').srcObject && document.getElementById('cameraPreview').srcObject.getVideoTracks()[0].readyState === 'live'"))
    check("protected view paints to a canvas (no text node in DOM)", 'TOP SECRET' not in pg.inner_text('#viewer'))
    check("badges shown: view once + protected + timer", all(k in pg.inner_text('#viewerBadges') for k in ('VIEW ONCE', 'PROTECTED VIEW', 'SELF-DESTRUCT 6s')))
    pg.screenshot(path=f"{SHOTS}/08_protected_viewer.png")
    # copy / contextmenu / select-all blocked
    prevented = pg.evaluate("""() => {
      const res = {};
      const c = new Event('copy', {cancelable:true, bubbles:true}); document.querySelector('.pcanvas').dispatchEvent(c); res.copy = c.defaultPrevented;
      const m = new Event('contextmenu', {cancelable:true, bubbles:true}); document.querySelector('.pcanvas').dispatchEvent(m); res.menu = m.defaultPrevented;
      const k = new KeyboardEvent('keydown', {key:'c', ctrlKey:true, cancelable:true, bubbles:true}); document.dispatchEvent(k); res.ctrlC = k.defaultPrevented;
      const s = new KeyboardEvent('keydown', {key:'p', ctrlKey:true, cancelable:true, bubbles:true}); document.dispatchEvent(s); res.ctrlP = s.defaultPrevented;
      return res; }""")
    check("copy, right-click, Ctrl+C and Ctrl+P are blocked in protected view", all(prevented.values()), prevented)
    # simulate window losing focus -> content hidden
    pg.evaluate("window.dispatchEvent(new Event('blur'))")
    pg.evaluate("Object.defineProperty(document,'hasFocus',{value:()=>false,configurable:true}); window.dispatchEvent(new Event('blur'))")
    pg.wait_for_timeout(150)
    hidden_px = pg.evaluate("""() => { const c=document.querySelector('.pcanvas'); const d=c.getContext('2d').getImageData(10,10,1,1).data; return Array.from(d); }""")
    check("content blanked when the window loses focus", hidden_px[0] < 20 and hidden_px[1] < 20, hidden_px)
    pg.screenshot(path=f"{SHOTS}/09_hidden_on_blur.png")
    pg.evaluate("Object.defineProperty(document,'hasFocus',{value:()=>true,configurable:true}); window.dispatchEvent(new Event('focus'))")
    # PrintScreen attempts
    pg.keyboard.press('PrintScreen'); pg.wait_for_timeout(150)
    note = pg.inner_text('#viewerNote')
    check("PrintScreen attempt is detected and counted", 'attempt' in note.lower() and '1 of 3' in note, note)
    wait_js(pg, "document.getElementById('viewer').textContent.includes('self-destructed')", timeout=12000)
    check("content self-destructs when the timer ends", 'self-destructed' in pg.inner_text('#viewerBody'))
    pg.screenshot(path=f"{SHOTS}/10_self_destructed.png")
    pg.click('#viewerClose')
    check("camera tracks stop when viewer closes", pg.evaluate("!document.getElementById('cameraPreview').srcObject"))
    # view once: second attempt refused
    pg.fill('#decryptText', encrypted3); pg.fill('#decryptPassword', pw3); pg.click('#decryptBtn'); pg.wait_for_selector('#decryptErr.show')
    check("view-once item cannot be decrypted a second time", 'already been decrypted' in pg.inner_text('#decryptErr'))

    # ---- 4. protected image with 3 PrintScreen attempts ends session
    pw4 = do_encrypt(pg, text="Caption under the image", file='/tmp/test.png', sens="internal", timer=60, prot=True)
    encrypted4 = pg.input_value('#encryptedText')
    pg.click('.tab[data-tab="decrypt"]'); pg.fill('#decryptText', encrypted4); pg.fill('#decryptPassword', pw4); pg.click('#decryptBtn')
    pg.wait_for_selector('#cameraGate:not([hidden])'); pg.click('#cameraStart')
    pg.wait_for_selector('#viewer:not([hidden]) canvas.pcanvas'); pg.wait_for_timeout(500)
    pg.screenshot(path=f"{SHOTS}/11_protected_image.png")
    pg.evaluate("window.__fakeCameraCanvas.getContext('2d').clearRect(0, 0, 64, 48)")
    wait_js(pg, "document.getElementById('viewerBody').textContent.includes('camera view became blocked')", timeout=5000)
    check("sustained camera obstruction ends the expiring view", 'camera view became blocked' in pg.inner_text('#viewerBody').lower())
    check("camera stream stops after obstruction destroys the view", pg.evaluate("!document.getElementById('cameraPreview').srcObject"))
    pg.click('#viewerClose')

    pw4c = do_encrypt(pg, text="Protected capture deterrent", sens="internal", prot=True)
    encrypted4c = pg.input_value('#encryptedText')
    pg.click('.tab[data-tab="decrypt"]'); pg.fill('#decryptText', encrypted4c); pg.fill('#decryptPassword', pw4c); pg.click('#decryptBtn')
    pg.wait_for_selector('#viewer:not([hidden]) canvas.pcanvas'); pg.wait_for_timeout(300)
    for _ in range(3): pg.keyboard.press('PrintScreen'); pg.wait_for_timeout(120)
    check("3 capture attempts end the protected session", 'repeated screen-capture' in pg.inner_text('#viewerBody'))
    pg.click('#viewerClose')

    # ---- 4b. protected DOCX: real deflate-compressed OOXML, text extracted
    pw4b = do_encrypt(pg, text="", file='/tmp/sample.docx', sens="confidential", prot=True)
    encrypted4b = pg.input_value('#encryptedText')
    pg.click('.tab[data-tab="decrypt"]'); pg.fill('#decryptText', encrypted4b); pg.fill('#decryptPassword', pw4b); pg.click('#decryptBtn')
    pg.wait_for_selector('#viewer:not([hidden]) canvas.pcanvas'); pg.wait_for_timeout(400)
    check("protected DOCX never exposes raw text in the DOM", DOCX_PARA_1 not in pg.inner_text('#viewer'))
    docx_ok = pg.evaluate("""() => {
      const c = document.querySelector('.pcanvas'); const ctx = c.getContext('2d');
      // crude check: canvas isn't just the blank/placeholder background colour everywhere
      const d = ctx.getImageData(0, 0, c.width, Math.min(c.height, 40)).data;
      let nonBg = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 20 || d[i+1] > 20 || d[i+2] > 25) nonBg++;
      return nonBg > 50;
    }""")
    check("protected DOCX renders extracted text onto the canvas", docx_ok)
    check("viewer footer explains DOCX text extraction", 'word document' in pg.inner_text('#viewerFoot').lower())
    pg.click('#viewerClose')

    # ---- 4c. protected PDF: hand-built FlateDecode content stream, text extracted
    pw4c = do_encrypt(pg, text="", file='/tmp/sample.pdf', sens="confidential", prot=True)
    encrypted4c = pg.input_value('#encryptedText')
    pg.click('.tab[data-tab="decrypt"]'); pg.fill('#decryptText', encrypted4c); pg.fill('#decryptPassword', pw4c); pg.click('#decryptBtn')
    pg.wait_for_selector('#viewer:not([hidden]) canvas.pcanvas'); pg.wait_for_timeout(400)
    check("protected PDF never exposes raw text in the DOM", 'Official Transcript' not in pg.inner_text('#viewer'))
    check("viewer footer explains PDF text extraction", 'pdf' in pg.inner_text('#viewerFoot').lower())
    pg.screenshot(path=f"{SHOTS}/11b_protected_pdf.png")
    pg.click('#viewerClose')

    # ---- 4d. DevTools-open heuristic is treated as a capture attempt
    pw4d = do_encrypt(pg, text="Watch for devtools", sens="internal", prot=True)
    encrypted4d = pg.input_value('#encryptedText')
    pg.click('.tab[data-tab="decrypt"]'); pg.fill('#decryptText', encrypted4d); pg.fill('#decryptPassword', pw4d); pg.click('#decryptBtn')
    pg.wait_for_selector('#viewer:not([hidden]) canvas.pcanvas'); pg.wait_for_timeout(300)
    pg.evaluate("Object.defineProperty(window,'outerWidth',{value: window.innerWidth + 400, configurable:true})")
    wait_js(pg, "document.getElementById('viewerNote').textContent.toLowerCase().includes('devtools')", timeout=3000)
    check("DevTools-open heuristic is detected and logged as a capture attempt", 'devtools' in pg.inner_text('#viewerNote').lower())
    pg.evaluate("Object.defineProperty(window,'outerWidth',{value: window.innerWidth, configurable:true})")
    pg.click('#viewerClose')

    # ---- 5. protected mode refuses unsupported file types
    pg.click('.tab[data-tab="encrypt"]')
    open('/tmp/data.bin', 'wb').write(os.urandom(2048))
    pg.fill('#encryptMessage', ''); pg.set_input_files('#encryptFile', '/tmp/data.bin')
    if not pg.is_checked('#optProtected'): pg.click('#optProtected')
    pg.click('#encryptBtn')
    check("protected view refuses unsupported file types", 'only show text' in pg.inner_text('#encryptErr').lower())
    pg.click('#encryptChipClear')
    if pg.is_checked('#optProtected'): pg.click('#optProtected')

    # ---- 6. normal file, download works and bytes match
    pw6 = do_encrypt(pg, text="", file='/tmp/note.txt', sens="internal")
    with pg.expect_download() as d: pg.click('#encryptDownload')
    dl = d.value; path = dl.path(); encrypted_bytes = open(path, 'rb').read()
    check("encrypted file download is a CSV3 container", encrypted_bytes[:4] == b'CSV3' and dl.suggested_filename.endswith('.cenc'))
    pg.click('.tab[data-tab="decrypt"]'); pg.fill('#decryptText', ''); pg.set_input_files('#decryptFile', path)
    pg.fill('#decryptPassword', pw6); pg.click('#decryptBtn'); pg.wait_for_selector('#viewerDownload')
    with pg.expect_download() as d2: pg.click('#viewerDownload')
    check("decrypted download is byte-identical to the original", open(d2.value.path(), 'rb').read() == open('/tmp/note.txt', 'rb').read())
    pg.screenshot(path=f"{SHOTS}/12_opened_file.png")
    pg.click('#viewerClose')

    # ---- 7. owner recovery with a throw-away test key pair
    kp = pg.evaluate("""async () => {
      const k = await crypto.subtle.generateKey({name:'RSA-OAEP', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256'}, true, ['encrypt','decrypt']);
      return { pub: await crypto.subtle.exportKey('jwk', k.publicKey), priv: await crypto.subtle.exportKey('jwk', k.privateKey) }; }""")
    json.dump(kp['priv'], open('/tmp/test-private.json', 'w'))
    ctx2, pg2, errs2 = new_ctx(browser)
    pub = dict(kp['pub']); pub['alg'] = 'RSA-OAEP-256'
    pg2.route("**/data/recovery-public-key.json", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(pub)))
    pg2.goto(URL); pg2.wait_for_timeout(500)
    pw7 = do_encrypt(pg2, text="Recoverable record", sens="confidential", recovery=True)
    encrypted7 = pg2.input_value('#encryptedText')
    pg2.click('.tab[data-tab="recover"]'); pg2.set_input_files('#recKey', '/tmp/test-private.json'); pg2.fill('#recText', encrypted7); pg2.click('#recBtn')
    pg2.wait_for_selector('#recOut:not([hidden])')
    check("owner recovery returns the exact password", pg2.input_value('#recPw') == pw7)
    pg2.screenshot(path=f"{SHOTS}/13_recover.png")
    pw8 = do_encrypt(pg2, text="No recovery here", sens="internal", recovery=False)
    encrypted8 = pg2.input_value('#encryptedText')
    pg2.click('.tab[data-tab="recover"]'); pg2.fill('#recText', encrypted8); pg2.click('#recBtn'); pg2.wait_for_selector('#recErr.show')
    check("recovery refused when the sender did not enable it", 'without owner recovery' in pg2.inner_text('#recErr'))
    ctx2.close()

    # ---- 8. no network calls except same-origin static files
    reqs = []
    ctx3, pg3, errs3 = new_ctx(browser)
    pg3.on("request", lambda r: reqs.append(r.url))
    pg3.goto(URL); pg3.wait_for_timeout(800)
    do_encrypt(pg3, text="network check", sens="internal")
    external = [u for u in reqs if not u.startswith("http://127.0.0.1:8765/") and not u.startswith("data:") and not u.startswith("blob:")]
    check("zero external requests; CSP produced no errors", not external and not errs and not errs3, (external, errs, errs3))
    ctx3.close()

    # nice screenshots for the report
    ctx4, pg4, _ = new_ctx(browser)
    pg4.goto(URL); pg4.wait_for_timeout(700)
    pg4.evaluate("CSPadlock.renderAt(0.0)"); pg4.wait_for_timeout(150)
    pg4.screenshot(path=f"{SHOTS}/01_home.png", full_page=False)
    pg4.fill('#encryptMessage', 'Result sheet — 300 Level, First Semester (sample)')
    pg4.select_option('#encryptSensitivity', 'restricted')
    pg4.click('#optTimer'); pg4.fill('#optSeconds', '30'); pg4.click('#optOnce'); pg4.click('#optProtected')
    pg4.evaluate("document.getElementById('pwField').type='text'; document.getElementById('pwShow').textContent='HIDE'")
    pg4.locator('#view-encrypt').screenshot(path=f"{SHOTS}/02_encrypt_panel.png")
    pg4.click('#encryptBtn'); pg4.wait_for_selector('#pwModal:not([hidden])'); pg4.wait_for_timeout(200)
    pg4.screenshot(path=f"{SHOTS}/03_copy_gate.png")
    pg4.click('.tab[data-tab="decrypt"]') if False else None
    ctx4.close()
    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n{len(results) - len(fails)}/{len(results)} checks passed")
sys.exit(1 if fails else 0)
