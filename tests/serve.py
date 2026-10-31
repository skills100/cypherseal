"""Static test server that sends the same CSP/security headers as production."""
import http.server, socketserver, sys, os, json
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
os.chdir(ROOT)
import re
headers = dict(re.findall(r'Header always set (\S+) "(.*)"', open('.htaccess').read()))
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a): pass
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', port), H) as s:
    s.serve_forever()
