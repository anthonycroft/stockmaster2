"""Shared request handling for the API endpoints.

Each endpoint module defines plain functions such as get(req) / post(req) and
then exposes them with:

    handler = make_handler(get=get, post=post)     # what Vercel calls
    app = make_app(get=get, post=post)             # what dev_server.py calls

Authentication: for now there is a single owner. Requests must send
`Authorization: Bearer <STOCKMASTER_API_KEY>`. The key is set as an environment
variable (in Vercel, and in .env for local development).
"""

from __future__ import annotations

import hmac
import json
import os
import traceback
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

from .db import DatabaseError
from .store import OWNER_USER_ID, NotFound, ValidationError

MAX_BODY = 2_000_000


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass
class Req:
    method: str
    query: dict
    headers: dict
    body: bytes
    user_id: int | None = None

    def arg(self, name, required=True):
        value = (self.query.get(name) or [None])[0]
        if required and value in (None, ""):
            raise HttpError(400, f"Missing ?{name}=")
        return value

    def json(self) -> dict:
        try:
            data = json.loads(self.body.decode() or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HttpError(400, "Request body must be JSON.") from None
        if not isinstance(data, dict):
            raise HttpError(400, "Request body must be a JSON object.")
        return data


def authenticate(req: Req) -> int:
    expected = os.environ.get("STOCKMASTER_API_KEY", "")
    if not expected:
        raise HttpError(503, "The server has no STOCKMASTER_API_KEY configured.")
    auth = req.headers.get("authorization", "")
    supplied = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if not supplied or not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise HttpError(401, "Access key missing or incorrect.")
    return OWNER_USER_ID


def _respond(status: int, payload) -> tuple[int, dict, bytes]:
    headers = {"Content-Type": "application/json", "Cache-Control": "no-store"}
    return status, headers, json.dumps(payload).encode()


def make_app(**methods):
    """Returns app(method, path, headers, body) -> (status, headers, body)."""
    allowed = sorted(m.upper() for m in methods)

    def app(method: str, path: str, headers: dict, body: bytes):
        req = Req(method=method.upper(), query=parse_qs(urlparse(path).query),
                  headers={k.lower(): v for k, v in headers.items()}, body=body)
        fn = methods.get(req.method.lower())
        try:
            if fn is None:
                raise HttpError(405, f"Use {', '.join(allowed)}.")
            req.user_id = authenticate(req)
            status, payload = fn(req)
            return _respond(status, payload)
        except HttpError as exc:
            return _respond(exc.status, {"error": str(exc)})
        except ValidationError as exc:
            return _respond(400, {"error": str(exc)})
        except NotFound as exc:
            return _respond(404, {"error": str(exc)})
        except DatabaseError as exc:
            traceback.print_exc()
            return _respond(503, {"error": f"Database problem: {exc}"})
        except Exception:  # noqa: BLE001 - never leak a stack trace to the browser
            traceback.print_exc()
            return _respond(500, {"error": "Unexpected server error."})

    return app


def make_handler(**methods):
    """Wraps the app in the BaseHTTPRequestHandler class Vercel expects."""
    app = make_app(**methods)

    class handler(BaseHTTPRequestHandler):
        def _serve(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                status, headers, body = _respond(413, {"error": "Request too large."})
            else:
                body_in = self.rfile.read(length) if length else b""
                status, headers, body = app(self.command, self.path, dict(self.headers), body_in)
            self.send_response(status)
            for k, v in headers.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _serve

    return handler
