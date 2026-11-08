"""GET /api/session -> {"ok": true, "database": "turso" | "sqlite-file"}

Used by the front end to check an access key, and handy for a quick health check.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _lib import store  # noqa: E402
from _lib.web import make_app, make_handler  # noqa: E402


def get(req):
    database = store.db()  # also applies any pending migrations
    return 200, {"ok": True, "user_id": req.user_id, "database": database.kind}


dev_app = make_app(get=get)
handler = make_handler(get=get)
