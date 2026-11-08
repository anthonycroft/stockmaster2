"""Bulk-create portfolios (browser-storage migration and the sample portfolio).

POST /api/import_portfolios
     {"portfolios": {"name": [tx, ...], ...}, "replace": false}
  -> {"imported": [...], "skipped": [...], "portfolios": [...]}
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _lib import store  # noqa: E402
from _lib.web import make_app, make_handler  # noqa: E402


def post(req):
    data = req.json()
    return 200, store.import_portfolios(req.user_id, data.get("portfolios"), bool(data.get("replace")))


dev_app = make_app(post=post)
class handler(make_handler(post=post)):  # Vercel looks for a class named 'handler'
    pass
