"""Pretend Firestore REST server for testing the notice board.

Serves the site from SITE, swaps config.js for a test config (polling every 5 s), and
answers /v1/projects/test/databases/(default)/documents/{board/content | posters/<id>}
from dev/fake-data/content.json and dev/fake-data/posters/<id>.txt (a data: URL).
updateTime follows content.json's modified time, so editing that file is a "publish".

    python dev/fake-firestore.py . 8793     (or the tg-noticeboard-fakefire preview entry)
"""
import json, os, sys, time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fake-data')
SITE = sys.argv[1]
PORT = int(sys.argv[2])
PREFIX = '/v1/projects/test/databases/(default)/documents/'
LOG = os.path.join(HERE, 'requests.log')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=SITE, **kw)

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        with open(LOG, 'a') as f:
            f.write(f'{time.strftime("%H:%M:%S")} {self.path}\n')
        if path == '/config.js':
            body = (f'window.TG_FIREBASE = {{ apiKey: "test", projectId: "test", '
                    f'restBase: "http://localhost:{PORT}/v1", pollSecs: 5 }};').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith(PREFIX):
            if 'key=test' not in (url.query or ''):
                return self.send_json(403, {'error': 'missing key'})
            doc = path[len(PREFIX):]
            if doc == 'board/content':
                f = os.path.join(HERE, 'content.json')
                if not os.path.exists(f):
                    return self.send_json(404, {'error': {'code': 404, 'status': 'NOT_FOUND'}})
                stamp = datetime.fromtimestamp(os.path.getmtime(f), timezone.utc).isoformat()
                return self.send_json(200, {'name': doc, 'updateTime': stamp,
                                            'fields': {'json': {'stringValue': open(f, encoding='utf-8').read()}}})
            if doc.startswith('posters/'):
                f = os.path.join(HERE, 'posters', doc.split('/', 1)[1] + '.txt')
                if not os.path.exists(f):
                    return self.send_json(404, {'error': {'code': 404, 'status': 'NOT_FOUND'}})
                return self.send_json(200, {'name': doc, 'fields': {'data': {'stringValue': open(f).read()}}})
            return self.send_json(404, {})
        return super().do_GET()

    def log_message(self, *a):
        pass


ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
