"""Portfolios for the signed-in user.

GET    /api/portfolios                 -> {"portfolios": [...]}
POST   /api/portfolios      {name}     -> {"portfolio": {...}}
PATCH  /api/portfolios?id=1 {name}     -> {"portfolio": {...}}   (rename)
DELETE /api/portfolios?id=1            -> {"deleted": 1}         (and its transactions)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _lib import store  # noqa: E402
from _lib.web import make_app, make_handler  # noqa: E402


def get(req):
    return 200, {"portfolios": store.list_portfolios(req.user_id)}


def post(req):
    return 201, {"portfolio": store.create_portfolio(req.user_id, req.json().get("name"))}


def patch(req):
    return 200, {"portfolio": store.rename_portfolio(req.user_id, req.arg("id"), req.json().get("name"))}


def delete(req):
    store.delete_portfolio(req.user_id, req.arg("id"))
    return 200, {"deleted": int(req.arg("id"))}


dev_app = make_app(get=get, post=post, patch=patch, delete=delete)
handler = make_handler(get=get, post=post, patch=patch, delete=delete)
