// Shared price-data layer. Everything that needs prices goes through
// getHistory(), which makes ONE batched call to our own /api/history endpoint
// (the API key, if any, lives on the server) and memoises the result so the
// thumbnails, heatmap and valuation all share the same request.

// Dow 30 constituents (GOOGL replaced VZ on 29 June 2026)
const DJ30 = ["AAPL", "AMGN", "AMZN", "AXP", "BA", "CAT", "CRM", "CSCO", "CVX", "DIS",
  "GOOGL", "GS", "HD", "HON", "IBM", "JNJ", "JPM", "KO", "MCD", "MMM",
  "MRK", "MSFT", "NKE", "NVDA", "PG", "SHW", "TRV", "UNH", "V", "WMT"];

const HISTORY_DAYS = 45; // a little over 30 so a full month of trading days is always covered

const _historyCache = new Map();

function getHistory(tickers, days = HISTORY_DAYS) {
  const key = [...new Set(tickers.map(t => t.toUpperCase()))].sort().join(",") + "|" + days;
  if (!_historyCache.has(key)) {
    const url = `/api/history?tickers=${encodeURIComponent(key.split("|")[0])}&days=${days}`;
    const promise = fetch(url)
      .then(async resp => {
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok && !body.data) {
          throw new Error(body.error || `Price service returned ${resp.status}`);
        }
        if (body.errors && Object.keys(body.errors).length) {
          console.warn("No prices for:", body.errors);
        }
        return body.data || {};
      })
      .catch(err => {
        _historyCache.delete(key); // allow a retry next time
        throw err;
      });
    _historyCache.set(key, promise);
  }
  return _historyCache.get(key);
}

// Flatten {TICKER: [{date, close}]} into the [{stock, date, price}] shape the
// valuation code uses.
function toTimeSeries(history) {
  const out = [];
  for (const [stock, rows] of Object.entries(history)) {
    for (const r of rows) {
      out.push({ stock, date: moment(r.date, "YYYY-MM-DD").toDate(), dateKey: r.date, price: r.close });
    }
  }
  return out;
}

// Latest prices (delayed) for the tape and the market-movers panel. Shares one
// request per symbol set, re-fetched at most every few minutes.
const QUOTES_MAX_AGE_MS = 4.5 * 60 * 1000;
const _quoteCache = new Map();

function getQuotes(symbols) {
  const key = [...new Set(symbols.map(s => s.toUpperCase()))].sort().join(',');
  const hit = _quoteCache.get(key);
  if (hit && Date.now() - hit.at < QUOTES_MAX_AGE_MS) return hit.promise;
  const promise = fetch('/api/quotes?symbols=' + encodeURIComponent(key))
    .then(async resp => {
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok && !body.quotes) throw new Error(body.error || `Quote service returned ${resp.status}`);
      return body.quotes || {};
    })
    .catch(err => { _quoteCache.delete(key); throw err; });
  _quoteCache.set(key, { at: Date.now(), promise });
  return promise;
}
