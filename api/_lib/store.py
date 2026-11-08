"""Schema, migrations and all portfolio/transaction data operations.

Every query is scoped to a user_id. For now there is a single owner (user 1);
real logins can be added later without changing the tables.

Money is stored as REAL (SQLite has no DECIMAL type). Quantities are signed:
buys positive, sales negative. Prices are always positive.
"""

from __future__ import annotations

import re
import threading
from datetime import date

from .db import get_database

OWNER_USER_ID = 1

# Each migration is a list of statements, applied once, in order.
MIGRATIONS = [
    [  # 1: initial schema
        """CREATE TABLE IF NOT EXISTS users (
            id           INTEGER PRIMARY KEY,
            email        TEXT UNIQUE,
            display_name TEXT,
            created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )""",
        """CREATE TABLE IF NOT EXISTS portfolios (
            id         INTEGER PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users(id),
            name       TEXT NOT NULL COLLATE NOCASE,
            currency   TEXT NOT NULL DEFAULT 'USD',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
            UNIQUE (user_id, name)
        )""",
        """CREATE TABLE IF NOT EXISTS transactions (
            id           INTEGER PRIMARY KEY,
            portfolio_id INTEGER NOT NULL REFERENCES portfolios(id),
            ticker       TEXT NOT NULL,
            trade_date   TEXT NOT NULL,
            quantity     REAL NOT NULL CHECK (quantity <> 0),
            price        REAL NOT NULL CHECK (price > 0),
            fees         REAL NOT NULL DEFAULT 0 CHECK (fees >= 0),
            notes        TEXT,
            created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
            updated_at   TEXT
        )""",
        "CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions (portfolio_id, trade_date)",
        "INSERT OR IGNORE INTO users (id, display_name) VALUES (1, 'Owner')",
    ],
]

_migrated = False
_migrate_lock = threading.Lock()


def db():
    """The database, with migrations applied (checked once per process)."""
    global _migrated
    database = get_database()
    if not _migrated:
        with _migrate_lock:
            if not _migrated:
                database.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
                row = database.execute("SELECT MAX(version) AS v FROM schema_version").rows[0]
                current = row["v"] or 0
                for version, statements in enumerate(MIGRATIONS, start=1):
                    if version > current:
                        database.batch([(s, ()) for s in statements] +
                                       [("INSERT INTO schema_version (version) VALUES (?)", (version,))])
                _migrated = True
    return database


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

class ValidationError(ValueError):
    """Bad input - reported to the user as a 400."""


class NotFound(LookupError):
    """Unknown or not-owned record - reported as a 404."""


TICKER_RE = re.compile(r"^[A-Z0-9.\-]{1,12}$")


def clean_name(name) -> str:
    name = " ".join(str(name or "").split())
    if not name:
        raise ValidationError("Enter a portfolio name.")
    if len(name) > 60:
        raise ValidationError("Portfolio names can be at most 60 characters.")
    return name


def clean_transaction(data: dict) -> dict:
    """Validate and normalise one transaction from the client."""
    ticker = str(data.get("ticker", "")).strip().upper()
    if not TICKER_RE.match(ticker):
        raise ValidationError("Enter a valid ticker, e.g. AAPL.")
    try:
        trade_date = date.fromisoformat(str(data.get("trade_date", "")))
    except ValueError:
        raise ValidationError("Enter the trade date as YYYY-MM-DD.") from None
    if trade_date > date.today():
        raise ValidationError("The trade date can't be in the future.")
    try:
        quantity = float(data.get("quantity"))
        price = float(data.get("price"))
        fees = float(data.get("fees") or 0)
    except (TypeError, ValueError):
        raise ValidationError("Quantity, price and fees must be numbers.") from None
    if quantity == 0:
        raise ValidationError("Quantity can't be zero (positive = buy, negative = sale).")
    if price <= 0:
        raise ValidationError("Price must be greater than zero.")
    if fees < 0:
        raise ValidationError("Fees can't be negative.")
    notes = (str(data.get("notes") or "").strip() or None)
    if notes and len(notes) > 500:
        raise ValidationError("Notes can be at most 500 characters.")
    return {"ticker": ticker, "trade_date": trade_date.isoformat(),
            "quantity": round(quantity, 6), "price": round(price, 6),
            "fees": round(fees, 2), "notes": notes}


def check_positions(transactions: list[dict]) -> None:
    """Refuse any set of trades that would hold a negative number of shares at
    any point in time (i.e. selling shares you didn't have)."""
    held: dict[str, float] = {}
    # Same-day trades: count buys before sells
    for t in sorted(transactions, key=lambda t: (t["trade_date"], -t["quantity"])):
        held[t["ticker"]] = held.get(t["ticker"], 0) + t["quantity"]
        if held[t["ticker"]] < -1e-9:
            raise ValidationError(
                f"That would mean selling {t['ticker']} you didn't hold on {t['trade_date']} "
                f"(position would be {held[t['ticker']]:g} shares).")


# ---------------------------------------------------------------------------
# Portfolios
# ---------------------------------------------------------------------------

PORTFOLIO_COLS = "p.id, p.name, p.currency, p.created_at"


def list_portfolios(user_id: int) -> list[dict]:
    return db().execute(
        f"""SELECT {PORTFOLIO_COLS}, COUNT(t.id) AS transaction_count
            FROM portfolios p LEFT JOIN transactions t ON t.portfolio_id = p.id
            WHERE p.user_id = ? GROUP BY p.id ORDER BY p.name""", (user_id,)).rows


def get_portfolio(user_id: int, portfolio_id) -> dict:
    rows = db().execute(f"SELECT {PORTFOLIO_COLS} FROM portfolios p WHERE p.id = ? AND p.user_id = ?",
                        (_int(portfolio_id), user_id)).rows
    if not rows:
        raise NotFound("Portfolio not found.")
    return rows[0]


def _find_portfolio_by_name(user_id: int, name: str):
    rows = db().execute(f"SELECT {PORTFOLIO_COLS} FROM portfolios p WHERE p.user_id = ? AND p.name = ?",
                        (user_id, name)).rows
    return rows[0] if rows else None


def create_portfolio(user_id: int, name) -> dict:
    name = clean_name(name)
    if _find_portfolio_by_name(user_id, name):
        raise ValidationError(f'You already have a portfolio called "{name}".')
    res = db().execute("INSERT INTO portfolios (user_id, name) VALUES (?, ?)", (user_id, name))
    return get_portfolio(user_id, res.lastrowid)


def rename_portfolio(user_id: int, portfolio_id, name) -> dict:
    p = get_portfolio(user_id, portfolio_id)
    name = clean_name(name)
    other = _find_portfolio_by_name(user_id, name)
    if other and other["id"] != p["id"]:
        raise ValidationError(f'You already have a portfolio called "{name}".')
    db().execute("UPDATE portfolios SET name = ? WHERE id = ?", (name, p["id"]))
    return get_portfolio(user_id, p["id"])


def delete_portfolio(user_id: int, portfolio_id) -> None:
    p = get_portfolio(user_id, portfolio_id)
    db().batch([("DELETE FROM transactions WHERE portfolio_id = ?", (p["id"],)),
                ("DELETE FROM portfolios WHERE id = ?", (p["id"],))])


# ---------------------------------------------------------------------------
# Transactions
# ---------------------------------------------------------------------------

TX_COLS = "id, ticker, trade_date, quantity, price, fees, notes, created_at, updated_at"


def list_transactions(user_id: int, portfolio_id) -> tuple[dict, list[dict]]:
    p = get_portfolio(user_id, portfolio_id)
    rows = db().execute(f"SELECT {TX_COLS} FROM transactions WHERE portfolio_id = ? "
                        "ORDER BY trade_date, id", (p["id"],)).rows
    return p, rows


def _get_transaction(user_id: int, tx_id) -> dict:
    rows = db().execute(
        """SELECT t.id, t.portfolio_id FROM transactions t
           JOIN portfolios p ON p.id = t.portfolio_id
           WHERE t.id = ? AND p.user_id = ?""", (_int(tx_id), user_id)).rows
    if not rows:
        raise NotFound("Transaction not found.")
    return rows[0]


def add_transaction(user_id: int, portfolio_id, data: dict) -> dict:
    p, existing = list_transactions(user_id, portfolio_id)
    tx = clean_transaction(data)
    check_positions(existing + [tx])
    res = db().execute(
        "INSERT INTO transactions (portfolio_id, ticker, trade_date, quantity, price, fees, notes) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (p["id"], tx["ticker"], tx["trade_date"], tx["quantity"], tx["price"], tx["fees"], tx["notes"]))
    return {**tx, "id": res.lastrowid}


def update_transaction(user_id: int, tx_id, data: dict) -> dict:
    found = _get_transaction(user_id, tx_id)
    _, existing = list_transactions(user_id, found["portfolio_id"])
    tx = clean_transaction(data)
    check_positions([t for t in existing if t["id"] != found["id"]] + [tx])
    db().execute(
        "UPDATE transactions SET ticker = ?, trade_date = ?, quantity = ?, price = ?, fees = ?, "
        "notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
        (tx["ticker"], tx["trade_date"], tx["quantity"], tx["price"], tx["fees"], tx["notes"], found["id"]))
    return {**tx, "id": found["id"]}


def delete_transaction(user_id: int, tx_id) -> None:
    found = _get_transaction(user_id, tx_id)
    _, existing = list_transactions(user_id, found["portfolio_id"])
    # Deleting a buy could leave a later sale selling shares you never had
    try:
        check_positions([t for t in existing if t["id"] != found["id"]])
    except ValidationError as exc:
        raise ValidationError("Can't delete this trade: " + str(exc)[0].lower() + str(exc)[1:]) from None
    db().execute("DELETE FROM transactions WHERE id = ?", (found["id"],))


# ---------------------------------------------------------------------------
# Bulk import (portfolios saved in the browser, and the sample portfolio)
# ---------------------------------------------------------------------------

MAX_IMPORT_TRANSACTIONS = 5000


def import_portfolios(user_id: int, portfolios: dict, replace: bool = False) -> dict:
    """portfolios = {name: [{ticker, trade_date, quantity, price, ...}, ...]}

    Existing portfolios with the same name are skipped, unless replace=True,
    in which case their transactions are replaced. Each portfolio is written in
    one all-or-nothing transaction."""
    if not isinstance(portfolios, dict) or not portfolios:
        raise ValidationError("Nothing to import.")
    if sum(len(v or []) for v in portfolios.values()) > MAX_IMPORT_TRANSACTIONS:
        raise ValidationError(f"At most {MAX_IMPORT_TRANSACTIONS} transactions per import.")

    # Validate everything before writing anything
    cleaned = {}
    for raw_name, txs in portfolios.items():
        name = clean_name(raw_name)
        try:
            rows = [clean_transaction(t) for t in (txs or [])]
            check_positions(rows)
        except ValidationError as exc:
            raise ValidationError(f'Portfolio "{name}": {exc}') from None
        cleaned[name] = rows

    imported, skipped = [], []
    database = db()
    for name, rows in cleaned.items():
        existing = _find_portfolio_by_name(user_id, name)
        if existing and not replace:
            skipped.append(name)
            continue
        if existing:
            statements = [("DELETE FROM transactions WHERE portfolio_id = ?", (existing["id"],))]
            pid_sql, pid_args = "?", (existing["id"],)
        else:
            statements = [("INSERT INTO portfolios (user_id, name) VALUES (?, ?)", (user_id, name))]
            # the new portfolio's id, looked up inside the same transaction
            pid_sql, pid_args = "(SELECT id FROM portfolios WHERE user_id = ? AND name = ?)", (user_id, name)
        for t in rows:
            statements.append((
                "INSERT INTO transactions (portfolio_id, ticker, trade_date, quantity, price, fees, notes) "
                f"VALUES ({pid_sql}, ?, ?, ?, ?, ?, ?)",
                pid_args + (t["ticker"], t["trade_date"], t["quantity"], t["price"], t["fees"], t["notes"])))
        database.batch(statements)
        imported.append({"name": name, "transactions": len(rows), "replaced": bool(existing)})

    return {"imported": imported, "skipped": skipped,
            "portfolios": list_portfolios(user_id)}


def _int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise NotFound("Not found.") from None
