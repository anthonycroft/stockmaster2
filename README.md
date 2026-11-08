# Stockmaster 2

Portfolio tracking and analysis: 30-day performance, equity curve, holdings with
average-cost P&L, a transaction ledger and a Dow 30 heatmap.

Live: https://stockmaster2.vercel.app

## How it fits together

| Part | What it is |
|---|---|
| `index.html`, `assets/` | Static front end (jQuery, D3, Bootstrap) |
| `api/history.py` | Daily closing prices for a batch of tickers (Yahoo chart data, optional Polygon fallback), cached on Vercel's CDN |
| `api/portfolios.py`, `api/transactions.py`, `api/import_portfolios.py`, `api/session.py` | Portfolio and transaction API |
| `api/_lib/db.py` | Database layer: a local SQLite file **or** Turso over HTTP, chosen by `DATABASE_URL` |
| `api/_lib/store.py` | Schema, migrations, validation (incl. no selling shares you didn't hold) |
| `dev_server.py` | Runs everything locally with no Vercel needed |

Portfolios are private to the owner: the API requires the access key in
`STOCKMASTER_API_KEY`. Tables already carry a `user_id`, ready for proper
logins later.

## Run locally

```bash
cp .env.example .env        # optional - defaults are a local stockmaster.db and key "dev"
python dev_server.py        # Python 3.10+, no packages to install
```

Open http://localhost:8000 and unlock with the key from `.env`.

## Configuration (Vercel → Settings → Environment Variables)

| Variable | Example |
|---|---|
| `DATABASE_URL` | `libsql://stockmaster-yourname.turso.io` |
| `DATABASE_AUTH_TOKEN` | token from the Turso dashboard |
| `STOCKMASTER_API_KEY` | a long random string - the key you unlock the site with |
| `POLYGON_API_KEY` | optional price fallback |

The tables are created automatically on first use.
