"""Latest price and day change for a batch of symbols (for the ticker tape).

GET /api/quotes?symbols=^GSPC,^FTSE,GBPUSD=X,BTC-USD,AAPL

Response:
    {"quotes": {"^GSPC": {"price": 6812.4, "prev_close": 6784.1, "change": 28.3,
                          "change_pct": 0.42, "currency": "USD", "time": 1794160000}, ...},
     "errors": {"XYZ": "no data"}}

Symbols use Yahoo's conventions: ^GSPC (S&P 500), ^FTSE, GBPUSD=X, BTC-USD, GC=F.
Prices are typically delayed ~15 minutes; responses are cached on Vercel's CDN
for 5 minutes, so this costs at most one upstream fetch per symbol set per 5 min.
"""

from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

MAX_SYMBOLS = 40
TIMEOUT_S = 8
SYMBOL_RE = re.compile(r"^[A-Z0-9.\-^=]{1,15}$")
USER_AGENT = "Mozilla/5.0 (compatible; stockmaster2/1.0)"


def _get_json(url: str) -> dict:
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_quote(symbol: str) -> dict:
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol)}"
           "?range=5d&interval=1d")
    result = ((_get_json(url).get("chart") or {}).get("result") or [None])[0]
    if not result:
        raise ValueError("no data")
    meta = result.get("meta") or {}
    stamps = result.get("timestamp") or []
    closes = (((result.get("indicators") or {}).get("quote") or [{}])[0].get("close")) or []
    offset = meta.get("gmtoffset", 0)
    bars = [(datetime.fromtimestamp(t + offset, timezone.utc).date(), c)
            for t, c in zip(stamps, closes) if c is not None]

    price = meta.get("regularMarketPrice")
    if price is None and bars:
        price = bars[-1][1]
    if price is None:
        raise ValueError("no price")

    # Previous close = the last daily close before the latest trading day
    market_time = meta.get("regularMarketTime")
    latest_day = (datetime.fromtimestamp(market_time + offset, timezone.utc).date()
                  if market_time else (bars[-1][0] if bars else None))
    earlier = [c for d, c in bars if latest_day is None or d < latest_day]
    prev_close = earlier[-1] if earlier else meta.get("chartPreviousClose")

    change = (price - prev_close) if prev_close else None
    return {
        "price": round(float(price), 6),
        "prev_close": round(float(prev_close), 6) if prev_close else None,
        "change": round(change, 6) if change is not None else None,
        "change_pct": round(change / prev_close * 100, 4) if change is not None else None,
        "currency": meta.get("currency"),
        "time": market_time,
    }


def build_response(query: dict) -> tuple[int, dict]:
    raw = ",".join(query.get("symbols", [])).upper()
    symbols = list(dict.fromkeys(s.strip() for s in raw.split(",") if s.strip()))
    if not symbols:
        return 400, {"error": "pass ?symbols=^GSPC,AAPL"}
    bad = [s for s in symbols if not SYMBOL_RE.match(s)]
    if bad:
        return 400, {"error": f"invalid symbol(s): {', '.join(bad)}"}
    if len(symbols) > MAX_SYMBOLS:
        return 400, {"error": f"at most {MAX_SYMBOLS} symbols per request"}

    quotes, errors = {}, {}

    def one(sym):
        # Yahoo uses '-' where most providers use '.', e.g. BRK.B -> BRK-B
        yahoo = sym if ("^" in sym or "=" in sym) else sym.replace(".", "-")
        try:
            return sym, fetch_quote(yahoo), None
        except HTTPError as exc:
            return sym, None, f"HTTP {exc.code}"
        except (URLError, ValueError, KeyError, TimeoutError) as exc:
            return sym, None, str(exc) or exc.__class__.__name__

    with ThreadPoolExecutor(max_workers=10) as pool:
        for sym, q, err in pool.map(one, symbols):
            if q:
                quotes[sym] = q
            else:
                errors[sym] = err
    return (200 if quotes else 502), {"quotes": quotes, "errors": errors}


def _respond(status, payload):
    headers = {"Content-Type": "application/json"}
    if status == 200 and not payload.get("errors"):
        headers["Cache-Control"] = "public, max-age=60, s-maxage=300, stale-while-revalidate=3600"
    else:
        headers["Cache-Control"] = "public, s-maxage=60"
    return status, headers, json.dumps(payload).encode("utf-8")


def dev_app(method, path, headers, body):
    """Same endpoint in the (status, headers, body) form used by dev_server.py."""
    return _respond(*build_response(parse_qs(urlparse(path).query)))


class handler(BaseHTTPRequestHandler):  # Vercel's Python runtime looks for this name
    def do_GET(self):
        status, headers, body = _respond(*build_response(parse_qs(urlparse(self.path).query)))
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)
