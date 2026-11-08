"""Tiny database layer with two interchangeable back ends.

    DATABASE_URL=file:stockmaster.db          -> local SQLite file (Python's sqlite3)
    DATABASE_URL=libsql://name-org.turso.io   -> Turso, over its HTTP API
    DATABASE_AUTH_TOKEN=...                   -> Turso token (not needed for a file)

Both back ends expose the same two calls, so the rest of the code doesn't care
which one it is talking to:

    db.execute(sql, params)      -> Result(rows=[{col: value}], rowcount, lastrowid)
    db.batch([(sql, params)...]) -> [Result, ...], all-or-nothing (one transaction)

The Turso back end uses only the standard library (no native packages), which
keeps the Vercel deployment simple.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from dataclasses import dataclass, field
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class DatabaseError(Exception):
    """Raised for any failure talking to the database."""


@dataclass
class Result:
    rows: list[dict] = field(default_factory=list)
    rowcount: int = 0
    lastrowid: int | None = None


# ---------------------------------------------------------------------------
# Local SQLite file
# ---------------------------------------------------------------------------

class SqliteDatabase:
    kind = "sqlite-file"

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA journal_mode = WAL")

    def _run(self, cur, sql, params) -> Result:
        cur.execute(sql, tuple(params or ()))
        rows = [dict(r) for r in cur.fetchall()] if cur.description else []
        return Result(rows=rows, rowcount=max(cur.rowcount, 0), lastrowid=cur.lastrowid)

    def execute(self, sql: str, params=()) -> Result:
        with self._lock:
            try:
                return self._run(self._conn.cursor(), sql, params)
            except sqlite3.Error as exc:
                raise DatabaseError(str(exc)) from exc

    def batch(self, statements) -> list[Result]:
        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute("BEGIN")
                results = [self._run(cur, sql, params) for sql, params in statements]
                cur.execute("COMMIT")
                return results
            except sqlite3.Error as exc:
                cur.execute("ROLLBACK")
                raise DatabaseError(str(exc)) from exc


# ---------------------------------------------------------------------------
# Turso (libSQL server) over HTTP - "Hrana over HTTP", POST /v2/pipeline
# ---------------------------------------------------------------------------

def _to_arg(value):
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}  # integers travel as strings
    if isinstance(value, float):
        return {"type": "float", "value": value}
    return {"type": "text", "value": str(value)}


def _from_value(v):
    t = v.get("type")
    if t == "null":
        return None
    if t == "integer":
        return int(v["value"])
    if t == "float":
        return float(v["value"])
    if t == "blob":
        return v.get("base64")
    return v.get("value")


def _to_result(res: dict) -> Result:
    cols = [c.get("name") for c in res.get("cols", [])]
    rows = [{c: _from_value(val) for c, val in zip(cols, row)} for row in res.get("rows", [])]
    rowid = res.get("last_insert_rowid")
    return Result(rows=rows, rowcount=res.get("affected_row_count", 0) or 0,
                  lastrowid=int(rowid) if rowid is not None else None)


class TursoHttpDatabase:
    kind = "turso"
    TIMEOUT_S = 10

    def __init__(self, url: str, token: str | None):
        if url.startswith("libsql://"):
            url = "https://" + url[len("libsql://"):]
        self.url = url.rstrip("/") + "/v2/pipeline"
        self.token = token

    def _pipeline(self, requests: list[dict]) -> list[dict]:
        body = json.dumps({"requests": requests + [{"type": "close"}]}).encode()
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        try:
            with urlopen(Request(self.url, data=body, headers=headers, method="POST"),
                         timeout=self.TIMEOUT_S) as resp:
                payload = json.loads(resp.read().decode())
        except HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            raise DatabaseError(f"database HTTP {exc.code}: {detail}") from exc
        except (URLError, TimeoutError) as exc:
            raise DatabaseError(f"database unreachable: {exc}") from exc
        return payload.get("results", [])

    @staticmethod
    def _stmt(sql, params):
        return {"sql": sql, "args": [_to_arg(p) for p in (params or ())]}

    def execute(self, sql: str, params=()) -> Result:
        first = self._pipeline([{"type": "execute", "stmt": self._stmt(sql, params)}])[0]
        if first.get("type") != "ok":
            raise DatabaseError((first.get("error") or {}).get("message", "query failed"))
        return _to_result(first["response"]["result"])

    def batch(self, statements) -> list[Result]:
        # A Hrana "batch" runs each step only if the previous one succeeded, so
        # BEGIN ... COMMIT is all-or-nothing; ROLLBACK runs if COMMIT didn't.
        n = len(statements)
        steps = [{"stmt": {"sql": "BEGIN"}}]
        for i, (sql, params) in enumerate(statements):
            steps.append({"stmt": self._stmt(sql, params),
                          "condition": {"type": "ok", "step": i}})
        steps.append({"stmt": {"sql": "COMMIT"}, "condition": {"type": "ok", "step": n}})
        steps.append({"stmt": {"sql": "ROLLBACK"},
                      "condition": {"type": "not", "cond": {"type": "ok", "step": n + 1}}})

        first = self._pipeline([{"type": "batch", "batch": {"steps": steps}}])[0]
        if first.get("type") != "ok":
            raise DatabaseError((first.get("error") or {}).get("message", "batch failed"))
        result = first["response"]["result"]
        step_results, step_errors = result["step_results"], result["step_errors"]
        for err in step_errors:
            if err:
                raise DatabaseError(err.get("message", "batch failed"))
        if step_results[n + 1] is None:  # COMMIT didn't run
            raise DatabaseError("transaction was not committed")
        return [_to_result(r) for r in step_results[1:n + 1]]


# ---------------------------------------------------------------------------

_db = None
_db_lock = threading.Lock()


def get_database():
    """One connection object per process, created on first use."""
    global _db
    if _db is None:
        with _db_lock:
            if _db is None:
                url = os.environ.get("DATABASE_URL", "").strip()
                if not url:
                    raise DatabaseError("DATABASE_URL is not set")
                if url.startswith("file:"):
                    _db = SqliteDatabase(url[len("file:"):])
                elif url.startswith(("libsql://", "https://", "http://")):
                    _db = TursoHttpDatabase(url, os.environ.get("DATABASE_AUTH_TOKEN"))
                else:
                    raise DatabaseError("DATABASE_URL must start with file:, libsql:// or https://")
    return _db
