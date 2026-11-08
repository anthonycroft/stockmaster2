"""Daily closing-price history for a batch of tickers.

GET /api/history?tickers=AAPL,MSFT&days=31

Response:
    {
      "data":   {"AAPL": [{"date": "2026-10-08", "close": 254.04}, ...], ...},
      "errors": {"XYZ": "no data"},
      "source": {"AAPL": "yahoo", ...}
    }

Prices come from Yahoo Finance's public chart endpoint (no key needed, one
request per ticker, fetched in parallel). If POLYGON_API_KEY is set in the
Vercel environment, Polygon is tried for any ticker Yahoo fails on.

Responses are cached on Vercel's CDN, so repeat page loads don't hit the
upstream APIs at all.
"""

from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

MAX_TICKERS = 50
MAX_DAYS = 400
DEFAULT_DAYS = 31
TIMEOUT_S = 8
CACHE_SECONDS = 60 * 60          # serve from CDN for an hour...
STALE_SECONDS = 60 * 60 * 24     # ...then serve stale while refreshing for a day

TICKER_RE = re.compile(r"^[A-Z0-9.\-^=]{1,12}$")
USER_AGENT = "Mozilla/5.0 (compatible; stockmaster2/1.0)"


def _get_json(url: str) -> dict:
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(req, timeout=TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_yahoo(ticker: str, start: date, end: date) -> list[dict]:
    # Yahoo uses '-' where most providers use '.', e.g. BRK.B -> BRK-B
    symbol = quote(ticker.replace(".", "-"))
    p1 = int(datetime.combine(start, datetime.min.time(), timezone.utc).timestamp())
    p2 = int(datetime.combine(end + timedelta(days=1), datetime.min.time(), timezone.utc).timestamp())
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?period1={p1}&period2={p2}&interval=1d&events=history"
    )
    payload = _get_json(url)
    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        raise ValueError("no data")
    r = result[0]
    stamps = r.get("timestamp") or []
    # Exchange-local date, so a US close is labelled with the US trading day
    offset = (r.get("meta") or {}).get("gmtoffset", 0)
    closes = ((r.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    rows = []
    for ts, close in zip(stamps, closes):
        if close is None:
            continue
        d = datetime.fromtimestamp(ts + offset, timezone.utc).date()
        rows.append({"date": d.isoformat(), "close": round(float(close), 4)})
    if not rows:
        raise ValueError("no data")
    return rows


def fetch_polygon(ticker: str, start: date, end: date, api_key: str) -> list[dict]:
    url = (
        f"https://api.polygon.io/v2/aggs/ticker/{quote(ticker)}/range/1/day/"
        f"{start.isoformat()}/{end.isoformat()}?adjusted=true&sort=asc&apiKey={api_key}"
    )
    payload = _get_json(url)
    rows = [
        {
            "date": datetime.fromtimestamp(r["t"] / 1000, timezone.utc).date().isoformat(),
            "close": r["c"],
        }
        for r in payload.get("results") or []
    ]
    if not rows:
        raise ValueError("no data")
    return rows


def fetch_one(ticker: str, start: date, end: date) -> tuple[str, list[dict] | None, str]:
    """Returns (ticker, rows or None, source-or-error)."""
    try:
        return ticker, fetch_yahoo(ticker, start, end), "yahoo"
    except (HTTPError, URLError, ValueError, KeyError, TimeoutError) as exc:
        err = _describe(exc)

    api_key = os.environ.get("POLYGON_API_KEY")
    if api_key:
        try:
            return ticker, fetch_polygon(ticker, start, end, api_key), "polygon"
        except (HTTPError, URLError, ValueError, KeyError, TimeoutError) as exc:
            err = f"{err}; polygon: {_describe(exc)}"
    return ticker, None, err


def _describe(exc: Exception) -> str:
    if isinstance(exc, HTTPError):
        return f"HTTP {exc.code}"
    return str(exc) or exc.__class__.__name__


def build_response(query: dict[str, list[str]]) -> tuple[int, dict]:
    raw = ",".join(query.get("tickers", [])).upper()
    tickers = sorted({t.strip() for t in raw.split(",") if t.strip()})
    if not tickers:
        return 400, {"error": "pass ?tickers=AAPL,MSFT"}
    bad = [t for t in tickers if not TICKER_RE.match(t)]
    if bad:
        return 400, {"error": f"invalid ticker(s): {', '.join(bad)}"}
    if len(tickers) > MAX_TICKERS:
        return 400, {"error": f"at most {MAX_TICKERS} tickers per request"}

    try:
        days = int((query.get("days") or [DEFAULT_DAYS])[0])
    except ValueError:
        return 400, {"error": "days must be a whole number"}
    days = max(1, min(days, MAX_DAYS))

    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=days)

    data, errors, source = {}, {}, {}
    with ThreadPoolExecutor(max_workers=10) as pool:
        for ticker, rows, info in pool.map(lambda t: fetch_one(t, start, end), tickers):
            if rows is None:
                errors[ticker] = info
            else:
                data[ticker] = rows
                source[ticker] = info

    status = 200 if data else 502
    return status, {"data": data, "errors": errors, "source": source,
                    "start": start.isoformat(), "end": end.isoformat()}


class handler(BaseHTTPRequestHandler):  # Vercel's Python runtime looks for this name
    def do_GET(self):
        t0 = time.monotonic()
        status, body = build_response(parse_qs(urlparse(self.path).query))
        payload = json.dumps(body).encode("utf-8")

        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if status == 200 and not body["errors"]:
            self.send_header(
                "Cache-Control",
                f"public, max-age=300, s-maxage={CACHE_SECONDS}, "
                f"stale-while-revalidate={STALE_SECONDS}",
            )
        else:
            # Don't let a partial/failed answer stick in the CDN for long
            self.send_header("Cache-Control", "public, s-maxage=60")
        self.send_header("Server-Timing", f"fetch;dur={(time.monotonic() - t0) * 1000:.0f}")
        self.end_headers()
        self.wfile.write(payload)


def dev_app(method, path, headers, body):
    """Same endpoint in the (status, headers, body) form used by dev_server.py."""
    status, payload = build_response(parse_qs(urlparse(path).query))
    return status, {"Content-Type": "application/json"}, json.dumps(payload).encode("utf-8")
