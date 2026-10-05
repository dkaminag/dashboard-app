#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import tempfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "10000"))
STORE = Path(os.environ.get("PHASE19P_STORE_DIR", "/tmp/phase19p-evidence"))
READ_TOKEN = os.environ.get("PHASE19P_EVIDENCE_BEARER_TOKEN", "")
UPLOAD_TOKEN = os.environ.get("PHASE19P_UPLOAD_BEARER_TOKEN", "")
MAX_BUNDLE_BYTES = int(os.environ.get("PHASE19P_MAX_BUNDLE_BYTES", str(100 * 1024 * 1024)))
SHA64 = re.compile(r"^[0-9a-f]{64}$")


def _auth_ok(header: str | None, expected: str) -> bool:
    if not expected or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[7:], expected)


def _json(handler: BaseHTTPRequestHandler, status: int, body: dict) -> None:
    payload = json.dumps(body, sort_keys=True).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(payload)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(payload)


class Handler(BaseHTTPRequestHandler):
    server_version = "Phase19PEvidenceOrigin/1.0"

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return _json(self, HTTPStatus.BAD_REQUEST, {"error": "query_or_fragment_not_allowed"})
        if parsed.path == "/health":
            return _json(self, HTTPStatus.OK, {"status": "ok", "storage": "ephemeral"})
        prefix = "/evidence/"
        if not parsed.path.startswith(prefix) or not parsed.path.endswith(".zip"):
            return _json(self, HTTPStatus.NOT_FOUND, {"error": "not_found"})
        digest = parsed.path[len(prefix):-4]
        if not SHA64.fullmatch(digest):
            return _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_sha256"})
        if not _auth_ok(self.headers.get("Authorization"), READ_TOKEN):
            return _json(self, HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        path = STORE / f"{digest}.zip"
        if not path.is_file():
            return _json(self, HTTPStatus.NOT_FOUND, {"error": "bundle_not_found"})
        data = path.read_bytes()
        actual = hashlib.sha256(data).hexdigest()
        if actual != digest:
            return _json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "stored_bundle_digest_mismatch"})
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-SHA256", actual)
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            return _json(self, HTTPStatus.BAD_REQUEST, {"error": "query_or_fragment_not_allowed"})
        prefix = "/admin/bundle/"
        if not parsed.path.startswith(prefix) or not parsed.path.endswith(".zip"):
            return _json(self, HTTPStatus.NOT_FOUND, {"error": "not_found"})
        digest = parsed.path[len(prefix):-4]
        if not SHA64.fullmatch(digest):
            return _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_sha256"})
        if not _auth_ok(self.headers.get("Authorization"), UPLOAD_TOKEN):
            return _json(self, HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return _json(self, HTTPStatus.LENGTH_REQUIRED, {"error": "content_length_required"})
        try:
            length = int(raw_length)
        except ValueError:
            return _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_content_length"})
        if length <= 0 or length > MAX_BUNDLE_BYTES:
            return _json(self, HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "bundle_size_rejected"})
        data = self.rfile.read(length)
        if len(data) != length:
            return _json(self, HTTPStatus.BAD_REQUEST, {"error": "short_upload"})
        actual = hashlib.sha256(data).hexdigest()
        if actual != digest:
            return _json(self, HTTPStatus.BAD_REQUEST, {"error": "sha256_mismatch", "actual": actual})
        STORE.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix="upload-", dir=STORE)
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            target = STORE / f"{digest}.zip"
            os.replace(tmp_name, target)
            for old in STORE.glob("*.zip"):
                if old != target:
                    old.unlink(missing_ok=True)
        finally:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
        return _json(self, HTTPStatus.CREATED, {"stored": True, "sha256": digest, "bytes": length})


def main() -> None:
    if not READ_TOKEN or not UPLOAD_TOKEN:
        raise SystemExit("PHASE19P_EVIDENCE_BEARER_TOKEN and PHASE19P_UPLOAD_BEARER_TOKEN are required")
    STORE.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
