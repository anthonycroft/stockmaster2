"""Transactions in one of the user's portfolios.

GET    /api/transactions?portfolio_id=1        -> {"portfolio": {...}, "transactions": [...]}
POST   /api/transactions?portfolio_id=1  {tx}  -> {"transaction": {...}}
PUT    /api/transactions?id=7            {tx}  -> {"transaction": {...}}
DELETE /api/transactions?id=7                  -> {"deleted": 7}

tx = {ticker, trade_date (YYYY-MM-DD), quantity (+buy / -sell), price, fees?, notes?}
Changes that would leave a negative position at any date are refused (400).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _lib import store  # noqa: E402
from _lib.web import make_app, make_handler  # noqa: E402


def get(req):
    portfolio, txs = store.list_transactions(req.user_id, req.arg("portfolio_id"))
    return 200, {"portfolio": portfolio, "transactions": txs}


def post(req):
    return 201, {"transaction": store.add_transaction(req.user_id, req.arg("portfolio_id"), req.json())}


def put(req):
    return 200, {"transaction": store.update_transaction(req.user_id, req.arg("id"), req.json())}


def delete(req):
    store.delete_transaction(req.user_id, req.arg("id"))
    return 200, {"deleted": int(req.arg("id"))}


app = make_app(get=get, post=post, put=put, delete=delete)
handler = make_handler(get=get, post=post, put=put, delete=delete)
