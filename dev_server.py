"""Run Stockmaster locally: static site + the /api endpoints, no Vercel needed.

    python dev_server.py            # then open http://localhost:8000

Settings come from a `.env` file next to this script (see .env.example). With
no .env it uses a local SQLite file, stockmaster.db, and the access key "dev".
"""

import importlib.util
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
API_DIR = ROOT / "api"


def load_env():
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    os.environ.setdefault("DATABASE_URL", f"file:{ROOT / 'stockmaster.db'}")
    os.environ.setdefault("STOCKMASTER_API_KEY", "dev")


_modules = {}


def api_app(name):
    """Load api/<name>.py once and return its app() function (or None)."""
    if name not in _modules:
        path = API_DIR / f"{name}.py"
        if not name.replace("_", "").isalnum() or name.startswith("_") or not path.exists():
            _modules[name] = None
        else:
            spec = importlib.util.spec_from_file_location(f"api_{name}", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            _modules[name] = getattr(module, "app", None)
    return _modules[name]


class DevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _api(self):
        name = urlparse(self.path).path[len("/api/"):].strip("/")
        app = api_app(name)
        if app is None:
            self.send_error(404, "No such API endpoint")
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        status, headers, payload = app(self.command, self.path, dict(self.headers), body)
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    def _route(self, static_ok=False):
        if self.path.startswith("/api/"):
            self._api()
        elif static_ok:
            super().do_GET()
        else:
            self.send_error(405)

    def do_GET(self):
        self._route(static_ok=True)

    do_POST = do_PUT = do_PATCH = do_DELETE = _route

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")  # always serve fresh files while developing
        super().end_headers()


def main():
    load_env()
    sys.path.insert(0, str(API_DIR))
    port = int(os.environ.get("PORT", "8000"))
    print(f"Stockmaster dev server on http://localhost:{port}")
    print(f"  database:   {os.environ['DATABASE_URL']}")
    print(f"  access key: {os.environ['STOCKMASTER_API_KEY']}")
    ThreadingHTTPServer(("127.0.0.1", port), DevHandler).serve_forever()


if __name__ == "__main__":
    main()
