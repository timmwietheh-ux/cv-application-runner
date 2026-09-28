"""Process streaming and LaTeX log parsing for the local IDE."""
from __future__ import annotations

import os
import pathlib
import re
import signal
import shutil
import subprocess
import threading
from typing import Any, Dict, Generator, List, Optional

from process_utils import hidden_subprocess_kwargs

# Extensions worth resolving when tracking which source file the log is in.
SOURCE_EXTS = (
    ".tex", ".sty", ".cls", ".def", ".cfg", ".ltx", ".clo", ".fd", ".lua",
    ".bbl", ".bib", ".aux", ".toc", ".out",
)

_FILE_TOKEN = re.compile(r'"([^"]+)"|([^()\s{}]+)')
_ERROR = re.compile(r"^!\s+(.*)$")
_FILE_LINE_ERROR = re.compile(r"^(.+?\.(?:tex|sty|cls|def|ltx)):(\d+):\s*(.+)$")
_LINE_REF = re.compile(r"^l\.(\d+)\s?(.*)$")
_WARNING = re.compile(r"(LaTeX|Package|Class|Module)\s+([\w@.-]+)?\s*Warning:\s*(.+)$")
_PLAIN_WARNING = re.compile(r"^(LaTeX|pdfTeX|luaTeX|Font)\s+Warning:\s*(.+)$")
_INPUT_LINE = re.compile(r"on input line (\d+)")
_BAD_BOX = re.compile(
    r"^(Overfull|Underfull)\s+\\([hv]box)\s+\(([^)]*)\)"
    r"(?:\s+in (?:paragraph|alignment) at lines (\d+)--(\d+)"
    r"|\s+detected at line (\d+)|\s+has occurred while \\output is active)?"
)

MAX_ITEMS = 500
MAX_RAW = 500_000

_ACTIVE_PROCESSES: Dict[str, subprocess.Popen[str]] = {}
_ACTIVE_LOCK = threading.RLock()


def stop_command(job_id: str) -> bool:
    """Stop one named IDE job without disturbing parallel console sessions."""
    if not job_id:
        return False
    with _ACTIVE_LOCK:
        process = _ACTIVE_PROCESSES.get(job_id)
    if process is None:
        return False
    _terminate_process_tree(process)
    return True


def _terminate_process_tree(process: subprocess.Popen[str]) -> None:
    """Stop the command and any compiler/interpreter children it spawned."""
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
                **hidden_subprocess_kwargs(),
            )
        else:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        process.wait(timeout=5)
    except (OSError, subprocess.SubprocessError):
        try:
            process.kill()
            process.wait(timeout=2)
        except (OSError, subprocess.SubprocessError):
            pass


def _resolve_log_path(token: str, repo_root: pathlib.Path) -> Optional[str]:
    """Map a path token from the log onto a repository-relative path."""
    cleaned = token.strip().strip('"')
    if not cleaned or not cleaned.lower().endswith(SOURCE_EXTS):
        return None
    try:
        candidate = pathlib.Path(cleaned)
        resolved = candidate.resolve() if candidate.is_absolute() else (repo_root / cleaned).resolve()
        if resolved.is_file() and repo_root in resolved.parents:
            return resolved.relative_to(repo_root).as_posix()
    except (OSError, ValueError):
        return None
    return None


def _scan_file_stack(line: str, stack: List[Optional[str]], repo_root: pathlib.Path) -> None:
    """Update the open-file stack from one log line.

    LaTeX brackets every opened file in parentheses.  Tokens that do not
    resolve to a real repository file still push a placeholder so that the
    nesting depth — and therefore the enclosing file — stays correct.
    """
    index = 0
    length = len(line)
    while index < length:
        char = line[index]
        if char == "(":
            match = _FILE_TOKEN.match(line, index + 1)
            token = (match.group(1) or match.group(2)) if match else ""
            stack.append(_resolve_log_path(token, repo_root) if token else None)
            index = (match.end() if match else index + 1)
            continue
        if char == ")":
            if stack:
                stack.pop()
        index += 1


def _current_file(stack: List[Optional[str]]) -> str:
    for entry in reversed(stack):
        if entry:
            return entry
    return "main.tex"


def parse_latex_log(repo_root: pathlib.Path, log_path: str = "build/main.log") -> Dict[str, Any]:
    """Parse main.log into structured errors, warnings and bad boxes."""
    full_path = repo_root / log_path
    if not full_path.exists():
        return {"errors": [], "warnings": [], "bad_boxes": [], "raw": "", "logPath": log_path}

    try:
        log_text = full_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {"errors": [], "warnings": [], "bad_boxes": [], "raw": str(exc), "logPath": log_path}

    lines = log_text.splitlines()
    errors: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []
    bad_boxes: List[Dict[str, Any]] = []
    stack: List[Optional[str]] = []
    seen_warnings = set()

    for index, line in enumerate(lines):
        current = _current_file(stack)

        # "./Notes/Notes.tex:120: Undefined control sequence."
        file_line = _FILE_LINE_ERROR.match(line)
        if file_line and not line.startswith("!"):
            resolved = _resolve_log_path(file_line.group(1), repo_root) or current
            errors.append({
                "message": file_line.group(3).strip(),
                "file": resolved,
                "line": int(file_line.group(2)),
                "context": "",
            })
            _scan_file_stack(line, stack, repo_root)
            continue

        error = _ERROR.match(line)
        if error:
            message = error.group(1).strip()
            target_line = 0
            context = ""
            for offset in range(index + 1, min(index + 25, len(lines))):
                reference = _LINE_REF.match(lines[offset])
                if reference:
                    target_line = int(reference.group(1))
                    context = reference.group(2).strip()
                    break
            errors.append({
                "message": message,
                "file": current,
                "line": target_line,
                "context": context,
            })
            _scan_file_stack(line, stack, repo_root)
            continue

        warning = _WARNING.search(line) or _PLAIN_WARNING.match(line)
        if warning:
            if warning.re is _WARNING:
                package = warning.group(2) or warning.group(1)
                message = warning.group(3).strip()
            else:
                package = warning.group(1)
                message = warning.group(2).strip()
            # The line number often lands on the next log line.
            lookahead = " ".join(lines[index:min(index + 3, len(lines))])
            input_line = _INPUT_LINE.search(lookahead)
            entry = {
                "pkg": package,
                "message": message,
                "file": current,
                "line": int(input_line.group(1)) if input_line else 0,
            }
            key = (entry["pkg"], entry["message"], entry["file"], entry["line"])
            if key not in seen_warnings:
                seen_warnings.add(key)
                warnings.append(entry)
            _scan_file_stack(line, stack, repo_root)
            continue

        box = _BAD_BOX.match(line)
        if box:
            start = box.group(4) or box.group(6) or "0"
            end = box.group(5) or start
            bad_boxes.append({
                "type": "%s \\%s" % (box.group(1), box.group(2)),
                "dim": box.group(3),
                "file": current,
                "start_line": int(start),
                "end_line": int(end),
            })
            _scan_file_stack(line, stack, repo_root)
            continue

        _scan_file_stack(line, stack, repo_root)

    return {
        "errors": errors[:MAX_ITEMS],
        "warnings": warnings[:MAX_ITEMS],
        "bad_boxes": bad_boxes[:MAX_ITEMS],
        "raw": log_text[-MAX_RAW:],
        "logPath": log_path,
    }


def stream_command(
    repo_root: pathlib.Path,
    command: str,
    is_powershell: bool = False,
    job_id: Optional[str] = None,
) -> Generator[Dict[str, Any], None, None]:
    """Run a command in the repository root, yielding output events.

    Yields ``{"line": str}`` for each output line and finally ``{"exit": int}``.
    stderr is merged into stdout so the console shows the true ordering.
    """
    if is_powershell:
        shell_exe = shutil.which("pwsh") or shutil.which("powershell") or "powershell"
        argv: Any = [shell_exe, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
        use_shell = False
    else:
        argv = command
        use_shell = True

    # Child interpreters block-buffer when stdout is a pipe, which would hold
    # the whole run back until exit; ask them to flush line by line instead.
    env = dict(os.environ)
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")

    try:
        popen_options: Dict[str, Any] = hidden_subprocess_kwargs(new_process_group=True)
        process = subprocess.Popen(
            argv,
            cwd=str(repo_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=use_shell,
            bufsize=1,
            env=env,
            **popen_options,
        )
    except (OSError, ValueError) as exc:
        yield {"line": "[could not start the process: %s]\n" % exc}
        yield {"exit": -1}
        return

    if job_id:
        with _ACTIVE_LOCK:
            duplicate = job_id in _ACTIVE_PROCESSES
            if not duplicate:
                _ACTIVE_PROCESSES[job_id] = process
        if duplicate:
            _terminate_process_tree(process)
            yield {"line": "[a job with this id is already running]\n"}
            yield {"exit": -1}
            return

    try:
        if process.stdout is not None:
            for line in iter(process.stdout.readline, ""):
                yield {"line": line}
        process.wait()
        yield {"exit": process.returncode}
    finally:
        if job_id:
            with _ACTIVE_LOCK:
                if _ACTIVE_PROCESSES.get(job_id) is process:
                    _ACTIVE_PROCESSES.pop(job_id, None)
        if process.stdout is not None:
            process.stdout.close()
        # Closing the generator on a disconnected SSE client lands here while
        # the child is still alive.  Kill the whole process group, not only the
        # intermediate cmd.exe/sh process created by ``shell=True``.
        _terminate_process_tree(process)
