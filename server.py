"""
OPCIONAL: O OCR pode ser feito diretamente do browser (js/app.js).
Este servidor apenas é necessário se quiseres usar o proxy OCR.space
em vez de chaves do lado do cliente.
"""

import http.server, urllib.request, urllib.parse, json, os, ssl, sys

PORT = 8080
OCR_SPACE_KEY = os.environ.get('OCR_SPACE_KEY', '')

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path != '/api/ocr':
            self.send_response(404); self.end_headers(); return
        content_len = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(content_len))
        img_data = body.get('image', '')
        label = body.get('label', 'IMG')
        if img_data.startswith('data:'):
            raw_b64 = img_data.split(',', 1)[1]
        else:
            raw_b64 = img_data
        print(f'[DEBUG] {label} base64 len={len(raw_b64)}')
        self._proxy_ocr(raw_b64, label)

    def _proxy_ocr(self, raw_b64, label='OCR'):
        # Try with full data URI first (error said "Invalid base64 Data URI")
        for prefix in ['data:image/jpeg;base64,', '']:
            val = prefix + raw_b64
            try:
                data = urllib.parse.urlencode({
                    'apikey': OCR_SPACE_KEY,
                    'base64Image': val,
                    'language': 'eng',
                    'isOverlayRequired': 'false',
                    'OCREngine': '2',
                    'filetype': 'jpg'
                }).encode()
                req = urllib.request.Request(
                    'https://api.ocr.space/parse/image',
                    data=data,
                    headers={'Content-Type': 'application/x-www-form-urlencoded'}
                )
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
                    ocr = json.loads(resp.read())
                    raw_text = (ocr.get('ParsedResults') or [{}])[0].get('ParsedText', '')
                    print(f'[{label} OK] prefix={bool(prefix)}')
                    print(f'[{label} TEXT] {raw_text[:500]}')
                    self.send_response(200)
                    self._cors()
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps(ocr).encode())
                    return
            except urllib.error.HTTPError as e:
                err = e.read().decode('utf-8', errors='replace')
                print(f'[OCR TRY prefix={bool(prefix)}] HTTP {e.code}: {err[:200]}')
                continue
            except Exception as e:
                print(f'[OCR TRY prefix={bool(prefix)}] {e}')
                continue
        # Both failed
        self.send_response(500)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'error': 'OCR.space rejected both attempts'}).encode())

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    srv = http.server.HTTPServer(('0.0.0.0', PORT), Handler)
    print(f'Servidor: http://0.0.0.0:{PORT}')
    print(f'Proxy:    http://0.0.0.0:{PORT}/api/ocr')
    try: srv.serve_forever()
    except KeyboardInterrupt: srv.shutdown()
