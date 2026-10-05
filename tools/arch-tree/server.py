"""arch-tree MCP + Web server: concept graph (actor/system/subsystem/datastore + flows)
with manual CBM evidence bindings. Shared JSON file, atomic saves with .bak."""

from __future__ import annotations

import argparse
import json
import shutil
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

from fastmcp import FastMCP

BASE = Path(__file__).resolve().parent
DEFAULT_DATA = BASE / "data" / "arch-tree.nobel.check.json"
WEB_DIR = BASE / "web"

mcp = FastMCP("arch-tree")
DATA_FILE = DEFAULT_DATA


def _load() -> dict:
    return json.loads(DATA_FILE.read_text(encoding="utf-8"))


def _save(tree: dict) -> None:
    tmp = DATA_FILE.with_suffix(".tmp")
    bak = DATA_FILE.with_suffix(".bak")
    if DATA_FILE.exists():
        shutil.copyfile(DATA_FILE, bak)
    tmp.write_text(json.dumps(tree, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DATA_FILE)


@mcp.tool()
def list_nodes(node_type: str = "") -> str:
    """List concept nodes, optionally filtered by type."""
    tree = _load()
    nodes = tree.get("nodes", [])
    if node_type:
        nodes = [n for n in nodes if n.get("type") == node_type]
    return json.dumps(nodes, ensure_ascii=False, indent=2)


@mcp.tool()
def get_node(node_id: str) -> str:
    """Get one concept node with its CBM bindings."""
    tree = _load()
    for n in tree.get("nodes", []):
        if n.get("id") == node_id:
            return json.dumps(n, ensure_ascii=False, indent=2)
    return json.dumps({"error": "not found", "id": node_id})


@mcp.tool()
def create_node(
    node_id: str,
    title: str,
    node_type: str,
    notes: str = "",
    x: float = 100,
    y: float = 100,
) -> str:
    """Create a concept node (actor|system|subsystem|datastore)."""
    tree = _load()
    if any(n.get("id") == node_id for n in tree.get("nodes", [])):
        return json.dumps({"error": "exists", "id": node_id})
    tree.setdefault("nodes", []).append(
        {
            "id": node_id,
            "title": title,
            "type": node_type,
            "notes": notes,
            "pos": {"x": x, "y": y},
            "bindings": [],
        }
    )
    _save(tree)
    return json.dumps({"ok": True, "id": node_id})


@mcp.tool()
def update_node(node_id: str, title: str = "", notes: str = "") -> str:
    """Update title/notes of a concept node."""
    tree = _load()
    for n in tree.get("nodes", []):
        if n.get("id") == node_id:
            if title:
                n["title"] = title
            if notes:
                n["notes"] = notes
            _save(tree)
            return json.dumps({"ok": True, "id": node_id})
    return json.dumps({"error": "not found", "id": node_id})


@mcp.tool()
def delete_node(node_id: str) -> str:
    """Delete a concept node and its incident edges."""
    tree = _load()
    tree["nodes"] = [n for n in tree.get("nodes", []) if n.get("id") != node_id]
    tree["edges"] = [
        e
        for e in tree.get("edges", [])
        if e.get("from") != node_id and e.get("to") != node_id
    ]
    _save(tree)
    return json.dumps({"ok": True, "id": node_id})


@mcp.tool()
def link(edge_id: str, from_id: str, to_id: str, label: str = "") -> str:
    """Create a flow edge between two concept nodes."""
    tree = _load()
    tree.setdefault("edges", []).append(
        {"id": edge_id, "from": from_id, "to": to_id, "label": label}
    )
    _save(tree)
    return json.dumps({"ok": True, "id": edge_id})


@mcp.tool()
def unlink(edge_id: str) -> str:
    """Delete a flow edge."""
    tree = _load()
    tree["edges"] = [e for e in tree.get("edges", []) if e.get("id") != edge_id]
    _save(tree)
    return json.dumps({"ok": True, "id": edge_id})


@mcp.tool()
def attach_evidence(
    node_id: str,
    kind: str,
    qn: str,
    file: str = "",
    lines: str = "",
    snapshot: str = "",
) -> str:
    """Attach a manual CBM evidence binding (table|symbol|route|file) to a node."""
    from datetime import date

    tree = _load()
    for n in tree.get("nodes", []):
        if n.get("id") == node_id:
            n.setdefault("bindings", []).append(
                {
                    "kind": kind,
                    "qn": qn,
                    "file": file,
                    "lines": lines,
                    "snapshot": snapshot,
                    "imported_at": date.today().isoformat(),
                }
            )
            _save(tree)
            return json.dumps(
                {"ok": True, "id": node_id, "bindings": len(n["bindings"])}
            )
    return json.dumps({"error": "not found", "id": node_id})


@mcp.tool()
def get_view() -> str:
    """Return full concept tree (nodes + edges) for reference/render."""
    return json.dumps(_load(), ensure_ascii=False, indent=2)


class _Handler(BaseHTTPRequestHandler):
    def _json(self, obj: object, code: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/api/tree", "/api/nodes"):
            self._json(_load())
        elif path == "/api/health":
            self._json({"ok": True})
        else:
            target = (
                WEB_DIR / "index.html"
                if path == "/"
                else WEB_DIR / path.lstrip("/").replace("..", "")
            )
            if target.is_file() and str(target).startswith(str(WEB_DIR)):
                ctype = "text/html; charset=utf-8"
                if target.suffix == ".js":
                    ctype = "text/javascript"
                body = target.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            payload = {}
        path = urlparse(self.path).path
        tree = _load()
        if path == "/api/nodes":
            tree.setdefault("nodes", []).append(payload)
            _save(tree)
            self._json({"ok": True, "id": payload.get("id")})
        elif path == "/api/edges":
            tree.setdefault("edges", []).append(payload)
            _save(tree)
            self._json({"ok": True, "id": payload.get("id")})
        elif path == "/api/save":
            if isinstance(payload, dict) and "nodes" in payload:
                _save(payload)
                self._json({"ok": True})
            else:
                self._json({"error": "expected {nodes, edges}"}, 400)
        else:
            self._json({"error": "unknown route"}, 404)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


def serve_web(port: int) -> None:
    HTTPServer(("127.0.0.1", port), _Handler).serve_forever()


def main() -> None:
    global DATA_FILE
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--web-only", action="store_true")
    args = ap.parse_args()
    DATA_FILE = Path(args.data)
    if args.web_only:
        serve_web(args.port)
        return
    t = threading.Thread(target=serve_web, args=(args.port,), daemon=True)
    t.start()
    mcp.run()


if __name__ == "__main__":
    main()
