"""LaTeX Runner CV Edition: local web IDE server for the CV repository.

Serves the single-page IDE and a small JSON/SSE API over one project folder.
Everything runs locally: no cloud service is contacted by the server. The CV
Edition replaces the source Runner's Numerics workspace by the Applications
workspace (``cv_workspace.py``): an application register, block documents
edited as forms, and one active document that is compiled and previewed.

Safety rules enforced here:
  * every filesystem route is jailed inside the project root;
  * paths the project marks as protected cannot be deleted or renamed;
  * writes to confirm-first paths require an explicit confirmation flag;
  * state-changing and command endpoints require the IDE session cookie, and
    DNS-rebinding hosts are rejected while the server is loopback-bound.

The listener binds to 127.0.0.1 by default because ``/api/run/stream`` executes
commands in the project; use ``--host`` deliberately if that must change.
"""
from __future__ import annotations

import argparse
import hashlib
import http.cookies
import ipaddress
import json
import mimetypes
import os
import pathlib
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional

HERE = pathlib.Path(__file__).parent.resolve()
STATIC_ROOT = (HERE / "static").resolve()
sys.path.insert(0, str(HERE))

import project  # noqa: E402

PROJECT = project.current()
REPO_ROOT = PROJECT.root

import ai_overview  # noqa: E402
import bibtex_bridge  # noqa: E402
import comments_store  # noqa: E402
import cv_workspace  # noqa: E402
import document_statistics  # noqa: E402
import git_bridge  # noqa: E402
import outline_parser  # noqa: E402
import runner_bridge  # noqa: E402
import runners_store  # noqa: E402
import settings_store  # noqa: E402
import synctex_bridge  # noqa: E402
import workspace_state  # noqa: E402

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

FIGURE_EXTS = (".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".eps", ".tiff")
MAX_REQUEST_BODY = 10 * 1024 * 1024
SESSION_COOKIE = "LaTeXRunner"
COMPILE_LOCK = threading.Lock()
JOB_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
PASS_LINE = re.compile(r"^Output written on ")
STEP_LINE = re.compile(r"^Running '(?:\"[^\"]*[\\/])?([A-Za-z0-9_.-]+)")

# Windows registry MIME lookups are unreliable; pin the types the UI needs.
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
}


def _session_token(root: pathlib.Path) -> str:
    """A per-project token that survives server restarts.

    An open browser tab keeps its cookie; with a stable token a restarted
    server still accepts its saves instead of answering 403 until reload.
    """
    base = os.environ.get("LOCALAPPDATA") or str(pathlib.Path.home() / ".cache")
    folder = pathlib.Path(base) / "LaTeX-Runner"
    key = hashlib.sha256(str(root).casefold().encode("utf-8")).hexdigest()[:20]
    path = folder / ("session-%s.token" % key)
    try:
        text = path.read_text(encoding="ascii").strip()
        if re.fullmatch(r"[A-Za-z0-9_-]{32,128}", text):
            return text
    except (OSError, UnicodeDecodeError):
        pass
    token = secrets.token_urlsafe(32)
    try:
        folder.mkdir(parents=True, exist_ok=True)
        path.write_text(token, encoding="ascii")
    except OSError:
        pass
    return token


SESSION_TOKEN = _session_token(REPO_ROOT)


class PathError(Exception):
    """Raised when a request references a path outside the project."""


class RequestError(Exception):
    """A malformed or unauthorised HTTP request with an explicit status."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _body_int(body: Dict[str, Any], name: str, default: int = 1) -> int:
    """An integer field of a JSON body; malformed input is a client error, not a crash."""
    value = body.get(name, default)
    if isinstance(value, bool):
        raise RequestError("%s must be an integer" % name)
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise RequestError("%s must be an integer" % name) from exc


def activate_project(root: Optional[Any] = None) -> "project.Project":
    """Serve ``root`` (or the discovered project) from now on."""
    global PROJECT, REPO_ROOT, SESSION_TOKEN
    PROJECT = project.activate(root)
    REPO_ROOT = PROJECT.root
    SESSION_TOKEN = _session_token(REPO_ROOT)
    if PROJECT.features.get("applications"):
        cv_workspace.restore()
    return PROJECT


def resolve_repo_path(rel: str) -> pathlib.Path:
    """Resolve a project-relative path, refusing anything outside the root."""
    if not isinstance(rel, str):
        raise PathError("Path must be a string")
    cleaned = (rel or "").replace("\\", "/").strip().lstrip("/")
    if not cleaned:
        raise PathError("Missing path")
    root = REPO_ROOT.resolve()
    target = (root / cleaned).resolve()
    if target != root and root not in target.parents:
        raise PathError("Path escapes the project root")
    return target


def relative_key(target: pathlib.Path) -> str:
    try:
        return target.relative_to(REPO_ROOT.resolve()).as_posix()
    except ValueError:
        return target.as_posix()


def is_protected(rel_key: str) -> bool:
    """True when the path must not be deleted or renamed through the IDE."""
    return PROJECT.is_protected(rel_key)


def needs_write_confirmation(rel_key: str) -> bool:
    return PROJECT.needs_write_confirmation(rel_key)


def pdf_rel() -> str:
    return PROJECT.out_dir + "/" + PROJECT.main_stem + ".pdf"


def pdf_path() -> pathlib.Path:
    return REPO_ROOT / PROJECT.out_dir / (PROJECT.main_stem + ".pdf")


def resolve_figure(raw: str) -> Optional[pathlib.Path]:
    """Find the file behind an \\includegraphics argument (extension optional)."""
    cleaned = (raw or "").strip().replace("\\", "/").strip("\"'")
    if not cleaned:
        return None
    root = REPO_ROOT.resolve()
    bases = [root / cleaned] + [root / folder / cleaned for folder in PROJECT.figure_dirs]
    candidates: List[pathlib.Path] = []
    for base in bases:
        candidates.append(base)
        for ext in FIGURE_EXTS:
            candidates.append(pathlib.Path(str(base) + ext))
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if root not in resolved.parents:
            continue
        if resolved.is_file():
            return resolved
    return None


def figure_kind(path: pathlib.Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return "pdf"
    if suffix in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"):
        return "image"
    return "other"


def build_tree(directory: pathlib.Path, prefix: str = "") -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    try:
        entries = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError:
        return items
    for entry in entries:
        rel = f"{prefix}/{entry.name}".lstrip("/")
        if PROJECT.is_ignored(entry.name, rel) or entry.is_symlink():
            continue
        try:
            if entry.is_dir():
                items.append({
                    "name": entry.name,
                    "path": rel,
                    "type": "directory",
                    "children": build_tree(entry, rel),
                })
            else:
                items.append({
                    "name": entry.name,
                    "path": rel,
                    "type": "file",
                    "size": entry.stat().st_size,
                })
        except OSError:
            continue
    return items


def stamp_of(path: pathlib.Path) -> Optional[str]:
    return workspace_state.stamp(path)


def workspace_snapshot() -> Dict[str, Any]:
    state = dict(workspace_state.snapshot(REPO_ROOT, ignored=PROJECT.ignored,
                                          ignored_paths=PROJECT.ignored_paths))
    state.update(pdf=stamp_of(pdf_path()), aux=stamp_of(REPO_ROOT / PROJECT.out_dir / (PROJECT.main_stem + ".aux")),
                 comments=stamp_of(comments_store.comments_file()))
    return state


# --------------------------------------------------------------------------- #
# Request handler
# --------------------------------------------------------------------------- #

class IDERequestHandler(BaseHTTPRequestHandler):
    server_version = "LaTeXRunner/" + project.APP_VERSION
    protocol_version = "HTTP/1.0"  # one response per connection keeps SSE simple

    # ----------------------------------------------------------------- utils
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        message = fmt % args
        if "/api/" in message and " 200 " not in message:
            sys.stderr.write("[runner] %s\n" % message)

    def _headers(self, status: int, content_type: str, length: int, extra: Optional[Dict[str, str]] = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def _json(self, payload: Any, status: int = 200, extra: Optional[Dict[str, str]] = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(body), extra)
        self._write(body)

    def _fail(self, message: str, status: int = 400, **extra: Any) -> None:
        payload = {"success": False, "error": message}
        payload.update(extra)
        self._json(payload, status=status)

    def _write(self, data: bytes) -> bool:
        try:
            self.wfile.write(data)
            return True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return False

    def _cookie_name(self) -> str:
        # Cookies are shared across ports of one host; a per-port name keeps two
        # runners (for example notes and thesis) from logging each other out.
        try:
            port = int(self.server.server_address[1])
        except (AttributeError, IndexError, TypeError, ValueError):
            return SESSION_COOKIE
        return "%s_%d" % (SESSION_COOKIE, port)

    def _session_cookie_header(self) -> str:
        return "%s=%s; Path=/; HttpOnly; SameSite=Strict" % (self._cookie_name(), SESSION_TOKEN)

    def _host_is_allowed(self) -> bool:
        """Reject DNS-rebinding hosts while the server is loopback-bound."""
        bound_host = str(self.server.server_address[0])
        try:
            if not ipaddress.ip_address(bound_host).is_loopback:
                return True
        except ValueError:
            if bound_host.casefold() != "localhost":
                return True

        raw_host = self.headers.get("Host", "")
        try:
            request_host = urllib.parse.urlsplit("//" + raw_host).hostname or ""
        except ValueError:
            return False
        if request_host.casefold() == "localhost":
            return True
        try:
            return ipaddress.ip_address(request_host).is_loopback
        except ValueError:
            return False

    def _has_session(self) -> bool:
        cookie = http.cookies.SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except http.cookies.CookieError:
            return False
        for name in (self._cookie_name(), SESSION_COOKIE):
            token = cookie.get(name)
            if token and secrets.compare_digest(token.value, SESSION_TOKEN):
                return True
        return False

    def _require_session(self) -> None:
        if not self._has_session():
            raise RequestError(
                "The editor session expired. Reconnecting…",
                403,
            )

    def _body(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError as exc:
            raise RequestError("Invalid Content-Length header") from exc
        if length <= 0:
            return {}
        if length > MAX_REQUEST_BODY:
            raise RequestError("Request body is too large", 413)
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise RequestError("Request body must contain valid UTF-8 JSON") from exc
        if not isinstance(body, dict):
            raise RequestError("Request body must be a JSON object")
        return body

    def _send_file(
        self,
        path: pathlib.Path,
        content_type: Optional[str] = None,
        extra: Optional[Dict[str, str]] = None,
    ) -> None:
        if content_type is None:
            content_type = MIME_TYPES.get(path.suffix.lower()) or \
                mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        # Read fully first: a compile may replace the PDF while it is streamed.
        with path.open("rb") as handle:
            data = handle.read()
        self._headers(200, content_type, len(data), extra=extra)
        view = memoryview(data)
        for start in range(0, len(data), 256 * 1024):
            if not self._write(view[start:start + 256 * 1024]):
                break

    def _start_sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def _sse_send(self, payload: Dict[str, Any], event: Optional[str] = None) -> bool:
        chunk = ""
        if event:
            chunk += "event: %s\n" % event
        chunk += "data: %s\n\n" % json.dumps(payload, ensure_ascii=False)
        try:
            self.wfile.write(chunk.encode("utf-8"))
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, ValueError, OSError):
            return False

    def _stream_process(
        self,
        command: str,
        is_powershell: bool = False,
        execution_lock: Optional[threading.Lock] = None,
        job_id: str = "",
        compile_job: bool = False,
    ) -> None:
        self._start_sse()
        acquired = execution_lock is None or execution_lock.acquire(blocking=False)
        if not acquired:
            self._sse_send({"line": "[A compile is already running.]\n"})
            self._sse_send({"exitCode": 75, "busy": True}, event="done")
            return
        exit_code = -1
        if job_id and not JOB_ID.fullmatch(job_id):
            self._sse_send({"line": "[invalid job id]\n"})
            self._sse_send({"exitCode": -1}, event="done")
            if execution_lock is not None:
                execution_lock.release()
            return
        started = time.monotonic()
        passes = 0
        steps = 0
        events = runner_bridge.stream_command(
            REPO_ROOT, command, is_powershell=is_powershell, job_id=job_id or None)
        try:
            for event in events:
                if "line" in event:
                    line = event["line"]
                    if not self._sse_send({"line": line}):
                        return  # finally closes the generator and its process tree
                    if compile_job:
                        step = STEP_LINE.match(line)
                        if step:
                            steps += 1
                            self._sse_send({"program": step.group(1), "step": steps}, event="step")
                        elif PASS_LINE.match(line):
                            passes += 1
                            self._sse_send({"pass": passes,
                                            "seconds": round(time.monotonic() - started, 1)}, event="pass")
                elif "exit" in event:
                    exit_code = event["exit"]
            self._sse_send({"exitCode": exit_code, "passes": passes,
                            "seconds": round(time.monotonic() - started, 1)}, event="done")
        finally:
            events.close()
            if execution_lock is not None:
                execution_lock.release()
            if compile_job:
                synctex_bridge.warm(REPO_ROOT, pdf_path())

    # ------------------------------------------------------------------ HTTP
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Allow", "GET, POST, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802,C901
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        def arg(name: str, default: str = "") -> str:
            return query.get(name, [default])[0]

        def number(name: str, default: float = 0.0) -> float:
            try:
                return float(arg(name, str(default)))
            except ValueError as exc:
                raise RequestError("Parameter %s must be a number" % name) from exc

        try:
            if not self._host_is_allowed():
                raise RequestError("Unrecognised Host header", 403)

            # ---------------------------------------------------- static UI
            if path in ("/", "/cv", "/cv.html", "/index.html", "/code"):
                index = STATIC_ROOT / ("index.html" if path == "/code" else "cv.html")
                if not index.exists():
                    return self._fail("The Runner interface is missing", 500)
                return self._send_file(index, "text/html; charset=utf-8",
                                       extra={"Set-Cookie": self._session_cookie_header()})

            if path.startswith("/static/"):
                try:
                    target = (STATIC_ROOT / urllib.parse.unquote(path[len("/static/"):])).resolve()
                except OSError:
                    return self._fail("Not found", 404)
                if STATIC_ROOT not in target.parents or not target.is_file():
                    return self._fail("Not found", 404)
                return self._send_file(target)

            if path == "/favicon.ico":
                icon = STATIC_ROOT / "img" / "latex-runner.ico"
                if icon.is_file():
                    return self._send_file(icon, "image/x-icon")
                icon = STATIC_ROOT / "img" / "favicon.svg"
                if icon.is_file():
                    return self._send_file(icon, "image/svg+xml")
                self._headers(204, "image/x-icon", 0)
                return

            # ------------------------------------------------------ health
            if path == "/api/health":
                return self._json({
                    "success": True,
                    "app": project.APP_ID,
                    "version": project.APP_VERSION,
                    "root": str(REPO_ROOT),
                    "pdf": pdf_path().exists(),
                })

            if path == "/api/session":
                # Re-issues the cookie after a restart. A cross-site page could
                # trigger this too, but SameSite=Strict keeps the cookie off
                # every request such a page could make afterwards.
                return self._json({"success": True}, extra={"Set-Cookie": self._session_cookie_header()})

            if path == "/api/project":
                settings = settings_store.load_settings()
                return self._json({"success": True, **PROJECT.public(),
                                   "compileCommand": settings.get("compiler", {}).get("command", PROJECT.compile_command)})

            if path == "/api/numerics/workspace":
                # The CV Edition has no Numerics workspace; the frontend asks anyway.
                return self._json({"success": True, "enabled": False, "root": "Numerics",
                                   "pipelines": [], "groups": [], "figures": [], "measurements": []})

            # ---------------------------------------------- applications
            if path.startswith("/api/cv/"):
                return self._cv_get(path, arg)

            # --------------------------------------------------------- pdf
            if path == "/api/pdf":
                if PROJECT.features.get("applications"):
                    self._require_session()
                target = pdf_path()
                if not target.exists():
                    return self._fail("No compiled PDF yet. Press Recompile.", 404)
                data = target.read_bytes()
                # LaTeX writes the PDF while it runs; serve only a finished file.
                if b"%%EOF" not in data[-2048:]:
                    return self._fail("The PDF is still being written. Try again in a moment.", 409,
                                      incomplete=True)
                self._headers(200, "application/pdf", len(data))
                view = memoryview(data)
                for start in range(0, len(data), 256 * 1024):
                    if not self._write(view[start:start + 256 * 1024]):
                        break
                return None

            if path == "/api/pdf/info":
                target = pdf_path()
                return self._json({"success": True, "exists": target.exists(),
                                   "stamp": stamp_of(target), "path": pdf_rel()})

            # ----------------------------------------------------- figures
            if path == "/api/figures/image":
                if PROJECT.features.get("applications"):
                    self._require_session()
                found = resolve_figure(arg("path"))
                if not found:
                    return self._fail("Image not found", 404)
                return self._send_file(found)

            if path == "/api/figures/meta":
                if PROJECT.features.get("applications"):
                    self._require_session()
                found = resolve_figure(arg("path"))
                if not found:
                    return self._fail("Image not found", 404)
                return self._json({
                    "success": True,
                    "path": relative_key(found),
                    "kind": figure_kind(found),
                    "size": found.stat().st_size,
                })

            # ------------------------------------------------------- files
            if path == "/api/files/tree":
                return self._json({"success": True, "tree": build_tree(REPO_ROOT)})

            if path == "/api/files/read":
                if PROJECT.features.get("applications"):
                    self._require_session()
                target = resolve_repo_path(arg("path"))
                if not target.is_file():
                    return self._fail("File not found", 404)
                if target.stat().st_size > 8 * 1024 * 1024:
                    return self._fail("File is too large to open in the editor", 413)
                return self._json({
                    "success": True,
                    "path": relative_key(target),
                    **workspace_state.read_document(target),
                    "readOnly": needs_write_confirmation(relative_key(target)),
                })

            # ----------------------------------------------------- outline
            if path == "/api/statistics":
                return self._statistics(None, arg("repository", "1") != "0")

            if path == "/api/outline":
                return self._json({"success": True,
                                   **outline_parser.get_document_outline(REPO_ROOT, PROJECT.main)})

            # ------------------------------------------------------ bibtex
            if path in ("/api/bibtex", "/api/bibtex/key"):
                entries: Dict[str, Any] = {}
                for bib in PROJECT.bibliography:
                    try:
                        entries.update(bibtex_bridge.parse_bib_file(resolve_repo_path(bib)))
                    except PathError:
                        continue
                if path == "/api/bibtex":
                    return self._json({"success": True,
                                       "entries": bibtex_bridge.completions_from(entries)})
                entry = entries.get(arg("k"))
                if not entry:
                    return self._fail("Citation key not found", 404)
                return self._json({"success": True, "entry": entry})

            # ----------------------------------------------------- synctex
            if path == "/api/synctex/inverse":
                return self._json(synctex_bridge.query_inverse_synctex(
                    REPO_ROOT, int(number("page", 1)), number("x"), number("y"),
                    pdf_rel_path=pdf_rel(), word=arg("word")[:120],
                    context=arg("context")[:500], context_offset=int(number("offset"))))

            if path == "/api/synctex/forward":
                source = resolve_repo_path(arg("file", PROJECT.main))
                return self._json(synctex_bridge.query_forward_synctex(
                    REPO_ROOT, relative_key(source), int(number("line", 1)), int(number("col", 1)),
                    pdf_rel_path=pdf_rel(), page_hint=int(number("page", 0))))

            # ----------------------------------------------------- compile
            if path == "/api/compile/stream":
                self._require_session()
                # The command follows the active document; a command saved in
                # the settings of another document must not be reused here.
                try:
                    cv_workspace.precompile()
                except cv_workspace.WorkspaceError as exc:
                    self._start_sse()
                    self._sse_send({"line": "[The block document could not be rendered: %s]\n" % exc})
                    self._sse_send({"exitCode": 1, "renderError": str(exc)}, event="done")
                    return None
                return self._stream_process(PROJECT.compile_command, execution_lock=COMPILE_LOCK,
                                            job_id=arg("job"), compile_job=True)

            if path == "/api/compile/log":
                log_rel = PROJECT.out_dir + "/" + PROJECT.main_stem + ".log"
                return self._json({"success": True, **runner_bridge.parse_latex_log(REPO_ROOT, log_rel)})

            if path == "/api/run/stream":
                self._require_session()
                command = arg("cmd").strip()
                if not command:
                    return self._fail("Missing command")
                return self._stream_process(command, is_powershell=arg("ps") == "1", job_id=arg("job"))

            # --------------------------------------------------------- git
            if path == "/api/git/status":
                return self._json(git_bridge.get_git_status(REPO_ROOT))
            if path == "/api/git/log":
                return self._json({"success": True, "commits": git_bridge.get_git_log(REPO_ROOT)})
            if path == "/api/git/diff":
                target = resolve_repo_path(arg("file"))
                return self._json(git_bridge.get_file_diff(REPO_ROOT, relative_key(target)))
            if path == "/api/git/graph":
                limit = max(1, min(200, int(number("limit", 60))))
                return self._json(git_bridge.get_commit_graph(REPO_ROOT, limit))
            if path == "/api/git/commit-detail":
                return self._json(git_bridge.get_commit_detail(REPO_ROOT, arg("sha")))

            # --------------------------------------------- runners / AI docs
            if path == "/api/runners":
                return self._json({"success": True, **runners_store.inspect_runners(REPO_ROOT)})

            if path == "/api/ai/overview":
                if not PROJECT.features.get("aiWorkspace"):
                    return self._json({"success": True, "enabled": False})
                return self._json({"success": True, "enabled": True,
                                   **ai_overview.get_ai_overview(REPO_ROOT, PROJECT.ai)})

            # ---------------------------------------------- comments/config
            if path == "/api/comments":
                return self._json({"success": True, "comments": comments_store.load_comments()})
            if path == "/api/settings":
                return self._json({"success": True, "settings": settings_store.load_settings()})

            return self._fail("Route not found: " + path, 404)

        except RequestError as exc:
            self._fail(str(exc), exc.status, session=exc.status == 403 and "session" in str(exc))
        except PathError as exc:
            self._fail(str(exc), 403)
        except FileNotFoundError:
            self._fail("File not found", 404)
        except Exception as exc:  # pragma: no cover - defensive
            self._fail("%s: %s" % (type(exc).__name__, exc), 500)

    def _cv_get(self, path, arg):
        """Read-only routes for the Applications workspace."""
        self._require_session()
        try:
            if path == "/api/cv/overview":
                return self._json(cv_workspace.overview())
            if path == "/api/cv/document":
                return self._json(cv_workspace.read_document(arg("app"), arg("doc")))
            if path == "/api/cv/profile":
                return self._json(cv_workspace.read_profile())
            if path == "/api/cv/stamp":
                return self._json(cv_workspace.document_stamp(arg("app"), arg("doc")))
            if path == "/api/cv/pdf":
                return self._send_file(cv_workspace.pdf_file(arg("app"), arg("doc")), "application/pdf")
            if path == "/api/cv/download":
                target = cv_workspace.download_file(arg("app"), arg("doc"))
                return self._send_file(target, "application/pdf", {"Content-Disposition":
                    'attachment; filename="%s"' % target.name})
            if path == "/api/cv/text":
                target = cv_workspace.text_file(arg("app"), arg("doc"))
                return self._send_file(target, "text/markdown; charset=utf-8", {"Content-Disposition":
                    'attachment; filename="%s"' % target.name})
            if path == "/api/cv/package":
                target = cv_workspace.package_file(arg("app"), arg("name"))
                disposition = "attachment" if arg("download") == "1" else "inline"
                return self._send_file(target, "application/pdf", {"Content-Disposition":
                    '%s; filename="%s"' % (disposition, target.name)})
            return self._fail("CV route not found: " + path, 404)
        except (cv_workspace.WorkspaceError, ValueError, FileNotFoundError) as exc:
            return self._fail(str(exc), 404)

    def _cv_post(self, path, body):
        """Session-protected application edits and builds."""
        try:
            if path == "/api/cv/activate":
                return self._json(cv_workspace.activate(str(body.get("app") or ""), str(body.get("doc") or "")))
            if path == "/api/cv/save":
                result = cv_workspace.write_document(str(body.get("app") or ""),
                    str(body.get("doc") or ""), body.get("data"), body.get("version"))
                return self._json(result, status=409 if result.get("conflict") else 200)
            if path == "/api/cv/profile":
                result = cv_workspace.write_profile(body.get("data"), body.get("version"))
                return self._json(result, status=409 if result.get("conflict") else 200)
            if path == "/api/cv/create":
                return self._json(cv_workspace.create_application(body))
            if path == "/api/cv/application":
                return self._json(cv_workspace.update_application(str(body.get("app") or ""), body.get("changes")))
            if path == "/api/cv/duplicate":
                return self._json(cv_workspace.duplicate_document(str(body.get("app") or ""),
                    str(body.get("doc") or ""), str(body.get("id") or ""), str(body.get("label") or "")))
            if path == "/api/cv/build":
                if not COMPILE_LOCK.acquire(blocking=False):
                    return self._fail("A LaTeX build is already running", 409)
                try:
                    return self._json(cv_workspace.build_document(str(body.get("app") or ""), str(body.get("doc") or "")))
                finally:
                    COMPILE_LOCK.release()
            if path == "/api/cv/package":
                if not COMPILE_LOCK.acquire(blocking=False):
                    return self._fail("A LaTeX build is already running", 409)
                try:
                    return self._json(cv_workspace.build_package(str(body.get("app") or ""), body.get("docs")))
                finally:
                    COMPILE_LOCK.release()
            if path == "/api/cv/export":
                return self._json(cv_workspace.export(str(body.get("app") or ""), str(body.get("doc") or "")))
            return self._fail("CV route not found: " + path, 404)
        except (cv_workspace.WorkspaceError, ValueError, RuntimeError) as exc:
            return self._fail(str(exc), 400)

    def _statistics(self, overrides=None, include_repository: bool = True) -> None:
        try:
            self._json({"success": True, **document_statistics.get_statistics(
                REPO_ROOT, overrides, include_repository=include_repository, main=PROJECT.main,
                aux=PROJECT.out_dir + "/" + PROJECT.main_stem + ".aux",
                figure_dirs=PROJECT.figure_dirs or ("Figures",))})
        except ValueError as exc:
            self._fail(str(exc), 400)

    def do_POST(self) -> None:  # noqa: N802,C901
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            if not self._host_is_allowed():
                raise RequestError("Unrecognised Host header", 403)
            # These endpoints only calculate local read-only metadata. Keeping
            # them sessionless lets a browser recover after a server restart
            # invalidates the cookie it had cached.
            if path in ("/api/workspace/state", "/api/statistics"):
                body = self._body()
                if path == "/api/statistics":
                    return self._statistics(body.get("overrides"), bool(body.get("repository", True)))
                paths = body.get('paths', [])
                if (not isinstance(paths, list) or len(paths) > 200 or
                        any(not isinstance(item, str) for item in paths)):
                    return self._fail('Expected at most 200 text file paths')
                files = {}
                for item in paths:
                    try:
                        files[item] = workspace_state.document_stamp(resolve_repo_path(item))
                    except PathError:
                        files[item] = None
                return self._json({'success': True, 'files': files,
                                   'state': workspace_snapshot(),
                                   'compiling': COMPILE_LOCK.locked(),
                                   'session': self._has_session()})

            self._require_session()
            body = self._body()

            if path.startswith("/api/cv/"):
                return self._cv_post(path, body)

            if path == "/api/calculation-map/save":
                if not PROJECT.features.get("calculationMap"):
                    return self._fail("The calculation map is not enabled for this project", 404)
                try:
                    result = calculation_map.save(body.get('data'), body.get('version'))
                except ValueError as exc:
                    raise RequestError(str(exc), 400) from exc
                return self._json(result, status=409 if result.get('conflict') else 200)
            if path == "/api/calculation-map/build":
                if not PROJECT.features.get("calculationMap"):
                    return self._fail("The calculation map is not enabled for this project", 404)
                try:
                    return self._json(calculation_map.build())
                except ValueError as exc:
                    raise RequestError(str(exc), 400) from exc
                except RuntimeError as exc:
                    # LaTeX or pdftocairo failed. The previous export stays in place.
                    raise RequestError(str(exc), 500) from exc

            # ------------------------------------------------------- write
            if path == "/api/files/write":
                target = resolve_repo_path(body.get("path", ""))
                key = relative_key(target)
                if target.is_dir():
                    return self._fail("Cannot write over a directory", 400)
                if needs_write_confirmation(key) and not body.get("allowProtectedWrite"):
                    return self._fail(
                        "%s is declared read-only in the repository agreement." % key,
                        403, protected=True, path=key)
                result = workspace_state.write_document(target, body.get('content', ''), body.get('version'))
                if result.get('conflict'):
                    return self._json({**result, 'path': key}, status=409)
                return self._json({**result, 'path': key})

            # ------------------------------------------------------ create
            if path == "/api/files/create":
                target = resolve_repo_path(body.get("path", ""))
                key = relative_key(target)
                if target.exists():
                    return self._fail("%s already exists" % key, 409)
                if needs_write_confirmation(key) and not body.get("allowProtectedWrite"):
                    return self._fail(
                        "%s is declared read-only in the repository agreement." % key,
                        403, protected=True, path=key)
                if body.get("isDir"):
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("", encoding="utf-8")
                return self._json({"success": True, "path": key})

            # ------------------------------------------------------ rename
            if path == "/api/files/rename":
                source = resolve_repo_path(body.get("from", ""))
                destination = resolve_repo_path(body.get("to", ""))
                source_key = relative_key(source)
                destination_key = relative_key(destination)
                if not source.exists():
                    return self._fail("%s does not exist" % source_key, 404)
                if is_protected(source_key):
                    return self._fail(
                        "%s is protected; rename it outside the IDE if that is intended." % source_key, 403)
                if is_protected(destination_key):
                    return self._fail(
                        "%s is protected; move files there outside the IDE if that is intended."
                        % destination_key,
                        403,
                    )
                if destination.exists():
                    return self._fail("%s already exists" % destination_key, 409)
                destination.parent.mkdir(parents=True, exist_ok=True)
                source.rename(destination)
                return self._json({"success": True, "from": source_key, "to": destination_key})

            # ------------------------------------------------------ delete
            if path == "/api/files/delete":
                target = resolve_repo_path(body.get("path", ""))
                key = relative_key(target)
                if not target.exists():
                    return self._fail("%s does not exist" % key, 404)
                if is_protected(key):
                    return self._fail(
                        "%s is protected project material and cannot be deleted here." % key,
                        403)
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
                return self._json({"success": True, "path": key})

            # ---------------------------------------------------- comments
            if path == "/api/comments":
                text = str(body.get("text", "")).strip()
                if not text:
                    return self._fail("A comment message is required")
                comment = comments_store.add_comment(
                    file_path=body.get("file", ""),
                    start_line=_body_int(body, "startLine"),
                    start_col=_body_int(body, "startCol"),
                    end_line=_body_int(body, "endLine"),
                    end_col=_body_int(body, "endCol"),
                    selected_text=body.get("selectedText", ""),
                    text=text[:20_000],
                    author=body.get("author", "Owner"),
                )
                return self._json({"success": True, "comment": comment})

            if path == "/api/comments/status":
                status = body.get("status", "open")
                if status not in ("open", "resolved"):
                    return self._fail("Comment status must be open or resolved")
                updated = comments_store.update_comment_status(body.get("id", ""), status)
                if not updated:
                    return self._fail("Comment not found", 404)
                return self._json({"success": True, "comment": updated})

            if path == "/api/comments/reply":
                reply_text = str(body.get("text", "")).strip()
                if not reply_text:
                    return self._fail("A reply message is required")
                updated = comments_store.add_reply(
                    body.get("id", ""), reply_text[:20_000], body.get("author", "Owner"))
                if not updated:
                    return self._fail("Comment not found", 404)
                return self._json({"success": True, "comment": updated})

            # ---------------------------------------------------- settings
            if path == "/api/settings":
                return self._json({"success": True, "settings": settings_store.save_settings(body)})

            # ----------------------------------------------------- runners
            if path == "/api/runners":
                runners_store.save_runners(body)
                return self._json({"success": True, **runners_store.inspect_runners(REPO_ROOT)})

            if path == "/api/runners/reset":
                runners_store.save_runners(runners_store.default_document())
                return self._json({"success": True, **runners_store.inspect_runners(REPO_ROOT)})

            # ---------------------------------------------------- processes
            if path == "/api/process/stop":
                job_id = str(body.get("job", ""))
                if not JOB_ID.fullmatch(job_id):
                    return self._fail("Invalid job id")
                stopped = runner_bridge.stop_command(job_id)
                return self._json({"success": True, "stopped": stopped, "job": job_id})

            # --------------------------------------------------------- git
            if path == "/api/git/stage":
                target = resolve_repo_path(body.get("path", ""))
                return self._json(git_bridge.git_stage(REPO_ROOT, relative_key(target)))
            if path == "/api/git/stage-all":
                return self._json(git_bridge.git_stage_all(REPO_ROOT))
            if path == "/api/git/unstage":
                target = resolve_repo_path(body.get("path", ""))
                return self._json(git_bridge.git_unstage(REPO_ROOT, relative_key(target)))
            if path == "/api/git/unstage-all":
                return self._json(git_bridge.git_unstage_all(REPO_ROOT))
            if path == "/api/git/commit-and-push":
                message = body.get("message", "")
                if not isinstance(message, str):
                    return self._fail("The commit message must be text")
                return self._json(git_bridge.git_commit_and_push(REPO_ROOT, message))
            if path == "/api/git/commit":
                message = (body.get("message") or "").strip()
                if not message:
                    return self._fail("A commit message is required")
                return self._json(git_bridge.git_commit(REPO_ROOT, message))
            if path == "/api/git/pull":
                return self._json(git_bridge.git_pull(REPO_ROOT))
            if path == "/api/git/push":
                return self._json(git_bridge.git_push(REPO_ROOT))
            if path == "/api/git/fetch":
                return self._json(git_bridge.git_fetch(REPO_ROOT))

            return self._fail("Route not found: " + path, 404)

        except RequestError as exc:
            self._fail(str(exc), exc.status, session=exc.status == 403 and "session" in str(exc))
        except PathError as exc:
            self._fail(str(exc), 403)
        except Exception as exc:  # pragma: no cover - defensive
            self._fail("%s: %s" % (type(exc).__name__, exc), 500)

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            if not self._host_is_allowed():
                raise RequestError("Unrecognised Host header", 403)
            self._require_session()
            parsed = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            if parsed.path == "/api/comments":
                comment_id = query.get("id", [""])[0]
                return self._json({"success": comments_store.delete_comment(comment_id)})
            self._fail("Route not found", 404)
        except RequestError as exc:
            self._fail(str(exc), exc.status, session=exc.status == 403 and "session" in str(exc))
        except PathError as exc:
            self._fail(str(exc), 403)
        except Exception as exc:  # pragma: no cover - defensive
            self._fail("%s: %s" % (type(exc).__name__, exc), 500)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

class LocalServer(ThreadingHTTPServer):
    """Threaded HTTP server that refuses to share its port.

    Python sets SO_REUSEADDR, which on Windows lets a second server bind the
    same port; requests then alternate between two processes. Exclusive use
    turns that into a clear "port in use" error instead.
    """

    daemon_threads = True
    allow_reuse_address = os.name != "nt"
    request_queue_size = 32

    def server_bind(self) -> None:
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def find_chrome() -> Optional[str]:
    """Locate Google Chrome (or Edge) on Windows, falling back to PATH."""
    candidates = [
        os.path.join(os.environ.get("PROGRAMFILES", r"C:\Program Files"),
                     "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
                     "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""),
                     "Google", "Chrome", "Application", "chrome.exe"),
    ]
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).is_file():
            return candidate
    return shutil.which("chrome") or shutil.which("google-chrome")


def open_browser(url: str, app_mode: bool = False) -> None:
    """Open the IDE, preferring Chrome; never let this kill the server."""
    chrome = find_chrome()
    try:
        if chrome:
            args = [chrome, "--app=" + url] if app_mode else [chrome, "--new-window", url]
            subprocess.Popen(args, close_fds=True)
            print("   Browser    : Google Chrome%s" % (" (app window)" if app_mode else ""))
            return
        webbrowser.open(url)
        print("   Browser    : system default (Chrome was not found)")
    except OSError as exc:
        print("   Browser    : could not be launched (%s); open %s manually" % (exc, url))


def existing_instance(url: str) -> Optional[Dict[str, Any]]:
    """Health data of a LaTeX Runner already listening at ``url``, if any."""
    try:
        with urllib.request.urlopen(url + "/api/health", timeout=2) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("app") == project.APP_ID else None


def run_server(port: int = 8050, host: str = "127.0.0.1",
               open_ui: bool = False, app_mode: bool = False, root: Optional[str] = None) -> int:
    active = activate_project(root)
    url = "http://%s:%d" % ("localhost" if host in ("127.0.0.1", "") else host, port)
    try:
        httpd = LocalServer((host, port), IDERequestHandler)
    except OSError as exc:
        running = existing_instance(url)
        if running and pathlib.Path(running.get("root", "")).resolve() == active.root:
            print("%s is already running for %s at %s" % (project.APP_NAME, active.name, url))
            if open_ui:
                open_browser(url, app_mode)
            return 0
        print("[ERROR] Port %d is in use (%s)." % (port, exc))
        if running:
            print("        Another LaTeX Runner serves %s there." % running.get("root"))
        print("        Start with another port, for example: --port %d" % (port + 1))
        return 1
    print("=" * 64)
    print(" %s %s" % (project.APP_NAME, project.APP_VERSION))
    print("   Project    : %s" % active.name)
    print("   Folder     : %s" % active.root)
    print("   Main file  : %s  ->  %s" % (active.main, pdf_rel()))
    print("   URL        : %s" % url)
    print("   Stop with  : Ctrl+C")
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host.casefold() == "localhost"
    if not loopback:
        print("   WARNING    : remote binding exposes file, Git, and command APIs without user authentication")
    # The socket is already bound, so the first request cannot race the server.
    if open_ui:
        threading.Timer(0.4, open_browser, args=(url, app_mode)).start()
    print("=" * 64)
    # Warming SyncTeX may invoke an external parser on a large document. Do it
    # beside the request loop so the health endpoint and browser UI become
    # available immediately after the socket is bound.
    threading.Thread(
        target=synctex_bridge.warm,
        args=(REPO_ROOT, pdf_path()),
        name="synctex-warm",
        daemon=True,
    ).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping %s…" % project.APP_NAME)
    finally:
        httpd.server_close()
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Start LaTeX Runner, the local LaTeX IDE")
    parser.add_argument("--root", help="project folder (default: the folder holding latex-runner.json)")
    parser.add_argument("--port", type=int, default=8050, help="port to listen on (default: 8050)")
    parser.add_argument(
        "--host", default="127.0.0.1",
        help="interface to bind (default: 127.0.0.1; the run endpoint executes commands)")
    parser.add_argument("--open", action="store_true", help="open the IDE in Google Chrome once ready")
    parser.add_argument("--app", action="store_true", help="with --open, use a chromeless Chrome app window")
    args = parser.parse_args(argv)
    try:
        return run_server(port=args.port, host=args.host, open_ui=args.open or args.app,
                          app_mode=args.app, root=args.root)
    except ValueError as exc:
        print("[ERROR] %s" % exc)
        return 2


if __name__ == "__main__":
    sys.exit(main())
