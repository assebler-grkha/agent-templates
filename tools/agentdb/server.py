#!/usr/bin/env python3
"""AgentDB MCP Server - long-term agent memory (SQLite + FastMCP).

Vendored into agent-templates as an installable tool (`tools/agentdb`).
Provides 5 MCP tools, API-compatible with the legacy external server:
- agentdb_search / agentdb_store / agentdb_status / agentdb_list / agentdb_get

Differences from the legacy script:
- DB path resolves via `--db` > `$AGENTDB_PATH` > `$OPENCODE_AGENTDB_PATH` >
  legacy pathfinder.db (if present) > `~/.agent-templates/agentdb/memory.db`.
- Schema auto-initializes on first run (no FileNotFoundError on fresh install).

Usage:
    python server.py                  # stdio mode (for MCP)
    python server.py --db <path>      # custom database location
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sqlite3
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

try:
    from fastmcp import FastMCP
except ImportError:
    logger.exception("fastmcp not installed")
    print("fastmcp not installed. Run: pip install -r requirements.txt")
    raise

SCHEMA_DOCUMENTS = """
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  domain TEXT,
  content TEXT,
  metadata TEXT,
  embedding BLOB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
"""

SCHEMA_CONFIG = """
CREATE TABLE IF NOT EXISTS agentdb_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
)
"""

DEFAULTS = {"backend": "likelike", "version": "1.0.0"}

mcp = FastMCP(name="AgentDB", version="1.0.0")

DB_PATH = Path.home() / ".agent-templates" / "agentdb" / "memory.db"


def _resolve_db(cli_arg: str | None) -> Path:
    if cli_arg:
        return Path(cli_arg).expanduser()
    for env in ("AGENTDB_PATH", "OPENCODE_AGENTDB_PATH"):
        override = os.environ.get(env)
        if override:
            return Path(override).expanduser()
    legacy = (
        Path.home() / ".opencode-mcp" / "pathfinder-app" / ".agentdb" / "pathfinder.db"
    )
    if legacy.exists():
        return legacy
    return Path.home() / ".agent-templates" / "agentdb" / "memory.db"


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(SCHEMA_DOCUMENTS)
    conn.execute(SCHEMA_CONFIG)
    for key, value in DEFAULTS.items():
        conn.execute(
            "INSERT OR IGNORE INTO agentdb_config (key, value) VALUES (?, ?)",
            (key, value),
        )
    conn.commit()


def _get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    _ensure_schema(conn)
    return conn


def _clamp_limit(limit: int, default: int = 10, maximum: int = 200) -> int:
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        return default
    return max(1, min(limit, maximum))


@mcp.tool()
def agentdb_search(query: str, domain: str | None = None, limit: int = 10) -> str:
    """Search documents in AgentDB by keyword matching.

    Args:
        query: Search query (keywords, space-separated)
        domain: Optional domain filter (e.g., v2-module, core-component, data-flow)
        limit: Maximum number of results (default 10)

    Returns:
        JSON string with search results
    """
    limit = _clamp_limit(limit)
    conn = _get_conn()
    keywords = query.split()
    conditions = []
    params: list[str] = []

    for keyword in keywords:
        conditions.append("(content LIKE ? OR id LIKE ?)")
        params.extend([f"%{keyword}%", f"%{keyword}%"])

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"SELECT id, domain, content, metadata, created_at FROM documents {where}"

    if domain:
        sql += " AND domain = ?" if where else " WHERE domain = ?"
        params.append(domain)

    sql += f" ORDER BY created_at DESC LIMIT {limit}"

    results = conn.execute(sql, params).fetchall()
    conn.close()

    output = []
    for doc_id, doc_domain, content, metadata, created_at in results:
        output.append(
            {
                "id": doc_id,
                "domain": doc_domain,
                "content": content[:500] + ("..." if len(content) > 500 else ""),
                "metadata": json.loads(metadata) if metadata else {},
                "created_at": created_at,
            }
        )

    return json.dumps(
        {"query": query, "domain": domain, "total": len(output), "results": output},
        ensure_ascii=False,
        indent=2,
    )


@mcp.tool()
def agentdb_store(
    doc_id: str,
    domain: str,
    content: str,
    metadata: str | None = None,
) -> str:
    """Save or update a document in AgentDB.

    Args:
        doc_id: Unique document ID (e.g., task-module-2026-05-18-14-30)
        domain: Document domain (e.g., session-summary, bug-fix, v2-module)
        content: Document content
        metadata: Optional JSON string with metadata (tags, files, errors, decisions)

    Returns:
        Confirmation message
    """
    conn = _get_conn()
    now = datetime.now().isoformat()

    existing = conn.execute(
        "SELECT id FROM documents WHERE id = ?", (doc_id,)
    ).fetchone()

    if existing:
        conn.execute(
            "UPDATE documents SET content = ?, metadata = ?, created_at = ? WHERE id = ?",
            (content, metadata or "{}", now, doc_id),
        )
        msg = f"Updated: {doc_id} ({domain})"
    else:
        conn.execute(
            "INSERT INTO documents (id, domain, content, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
            (doc_id, domain, content, metadata or "{}", now),
        )
        msg = f"Saved: {doc_id} ({domain})"

    conn.commit()
    conn.close()
    return msg


@mcp.tool()
def agentdb_status() -> str:
    """Get AgentDB database status and statistics.

    Returns:
        JSON string with database statistics
    """
    conn = _get_conn()

    total = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    with_embeddings = conn.execute(
        "SELECT COUNT(*) FROM documents WHERE embedding IS NOT NULL"
    ).fetchone()[0]
    vectorization_pct = round((with_embeddings / total * 100) if total > 0 else 0, 1)

    last_doc = conn.execute(
        "SELECT id, domain, created_at FROM documents ORDER BY created_at DESC LIMIT 1"
    ).fetchone()

    domains = conn.execute(
        "SELECT domain, COUNT(*) as count FROM documents GROUP BY domain ORDER BY count DESC"
    ).fetchall()

    config = dict(conn.execute("SELECT key, value FROM agentdb_config").fetchall())

    conn.close()

    status = {
        "total_documents": total,
        "vectorized_documents": with_embeddings,
        "vectorization_percent": vectorization_pct,
        "last_save_date": last_doc[2] if last_doc else "Unknown",
        "last_doc_id": last_doc[0] if last_doc else "N/A",
        "last_doc_domain": last_doc[1] if last_doc else "N/A",
        "domains": {d: c for d, c in domains},
        "config": config,
        "database_path": str(DB_PATH),
    }

    return json.dumps(status, ensure_ascii=False, indent=2)


@mcp.tool()
def agentdb_list(domain: str | None = None, limit: int = 50) -> str:
    """List documents in AgentDB with optional domain filter.

    Args:
        domain: Optional domain filter
        limit: Maximum number of results (default 50)

    Returns:
        JSON string with document list
    """
    limit = _clamp_limit(limit, default=50)
    conn = _get_conn()

    if domain:
        docs = conn.execute(
            "SELECT id, domain, substr(content, 1, 100), created_at FROM documents WHERE domain = ? ORDER BY created_at DESC LIMIT ?",
            (domain, limit),
        ).fetchall()
    else:
        docs = conn.execute(
            "SELECT id, domain, substr(content, 1, 100), created_at FROM documents ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()

    conn.close()

    output = [
        {"id": d[0], "domain": d[1], "preview": d[2], "created_at": d[3]} for d in docs
    ]

    return json.dumps(
        {"total": len(output), "documents": output}, ensure_ascii=False, indent=2
    )


@mcp.tool()
def agentdb_get(doc_id: str) -> str:
    """Get a specific document by ID.

    Args:
        doc_id: Document ID

    Returns:
        JSON string with document content or error
    """
    conn = _get_conn()
    doc = conn.execute(
        "SELECT id, domain, content, metadata, created_at FROM documents WHERE id = ?",
        (doc_id,),
    ).fetchone()
    conn.close()

    if not doc:
        return json.dumps({"error": f"Document not found: {doc_id}"})

    return json.dumps(
        {
            "id": doc[0],
            "domain": doc[1],
            "content": doc[2],
            "metadata": json.loads(doc[3]) if doc[3] else {},
            "created_at": doc[4],
        },
        ensure_ascii=False,
        indent=2,
    )


def main() -> None:
    global DB_PATH
    ap = argparse.ArgumentParser(description="AgentDB MCP server (long-term memory)")
    ap.add_argument("--db", default=None, help="SQLite database path")
    args = ap.parse_args()
    DB_PATH = _resolve_db(args.db)
    mcp.run()


if __name__ == "__main__":
    main()
