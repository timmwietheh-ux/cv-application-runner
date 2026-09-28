"""Git bridge for repository status, diffs, history, and safe porcelain workflows."""
from __future__ import annotations

import os
import pathlib
import re
import subprocess
import threading
import time
from copy import deepcopy
from functools import wraps
from typing import Any, Dict, List, Optional

from process_utils import hidden_subprocess_kwargs


_WRITE_LOCK = threading.RLock()
_READ_LOCK = threading.Lock()
_READ_CACHE = {}
# Bumped by every write; a read that overlapped a write must not be cached.
_READ_GENERATION = 0


def _invalidate_reads() -> None:
    global _READ_GENERATION
    with _READ_LOCK:
        _READ_CACHE.clear()
        _READ_GENERATION += 1


def cached_read(operation):
    """Serve identical reads for two seconds without holding a lock while Git runs."""
    @wraps(operation)
    def read(repo_root, *args):
        key = (operation.__name__, str(repo_root), args)
        with _READ_LOCK:
            previous = _READ_CACHE.get(key)
            if previous and time.monotonic() - previous[0] < 2:
                return deepcopy(previous[1])
            generation = _READ_GENERATION
        result = operation(repo_root, *args)
        if result.get('success'):
            with _READ_LOCK:
                if generation == _READ_GENERATION:
                    if len(_READ_CACHE) > 16:
                        _READ_CACHE.clear()
                    _READ_CACHE[key] = (time.monotonic(), deepcopy(result))
        return result
    return read


def git_write(operation):
    """Keep the commit/push sequence exclusive across this server's requests."""
    @wraps(operation)
    def guarded(*args, **kwargs):
        if not _WRITE_LOCK.acquire(blocking=False):
            return {"success": False, "stdout": "", "exit_code": 1,
                    "stderr": "Another Git operation is running. Please wait.",
                    "command": "git"}
        try:
            _invalidate_reads()
            return operation(*args, **kwargs)
        finally:
            _invalidate_reads()
            _WRITE_LOCK.release()
    return guarded


def run_git(repo_root: pathlib.Path, args: List[str], timeout: int = 20) -> Dict[str, Any]:
    """Run Git without an invisible terminal prompt.

    The IDE has no stdin surface for credential questions. Stored credentials and
    Git Credential Manager still work, while missing authentication fails with a
    useful error instead of leaving a backend request hanging indefinitely.
    """
    env = dict(os.environ)
    env.setdefault("GIT_TERMINAL_PROMPT", "0")
    env.setdefault("GCM_INTERACTIVE", "Never")
    if args and args[0] in ('status', 'log', 'diff', 'show', 'remote'):
        env['GIT_OPTIONAL_LOCKS'] = '0'
    try:
        proc = subprocess.run(
            ["git"] + args,
            cwd=str(repo_root),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env,
            **hidden_subprocess_kwargs(),
        )
        return {
            "success": proc.returncode == 0,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "exit_code": proc.returncode,
            "command": "git " + subprocess.list2cmdline(args),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "success": False,
            "stdout": (exc.stdout.decode("utf-8", errors="replace")
                       if isinstance(exc.stdout, bytes) else exc.stdout) or "",
            "stderr": "Git timed out after %d seconds." % timeout,
            "exit_code": 124,
            "command": "git " + subprocess.list2cmdline(args),
        }
    except Exception as exc:
        return {
            "success": False,
            "stdout": "",
            "stderr": str(exc),
            "exit_code": -1,
            "command": "git " + subprocess.list2cmdline(args),
        }


def _entry(path: str, status: str, **extra: str) -> Dict[str, str]:
    item = {"path": path, "status": status}
    item.update({key: value for key, value in extra.items() if value})
    return item


GIT_GROUPS = (
    ("manuscript", "LaTeX / Manuscript", ("Notes/", "LaTeX/", "Bibliography/", "Figures/"),
     ("main.tex",)),
    ("numerics", "Numerics / Scientific code", ("Numerics/", "Scripts/Analysis/", "Scripts/Plots/"), ()),
    ("runner", "LaTeX Runner", ("Scripts/editor/",),
     ("latex-runner.json", "start-editor.ps1", "start-editor.bat")),
    ("ai", "AI / Contracts / Governance", ("Docs/AI/", ".agents/", ".agent/", ".claude/", ".codex/", ".gemini/"),
     ("AGENTS.md", "CLAUDE.md", "GEMINI.md", "MEMORY.md", "HANDOFF.md")),
    ("tooling", "Tests / Tooling", ("Scripts/", ".github/", "tests/"),
     ("pyproject.toml", "package.json", "package-lock.json")),
)


def classify_git_path(path: str) -> tuple[str, str]:
    normalized = str(path or "").replace("\\", "/")
    if normalized.startswith("./"):
        normalized = normalized[2:]
    normalized = normalized.lstrip("/")
    for group_id, label, prefixes, exact in GIT_GROUPS:
        if normalized in exact or any(normalized.startswith(prefix) for prefix in prefixes):
            return group_id, label
    return "other", "Other"


def group_git_changes(staged, modified, untracked, conflicts=None) -> List[Dict[str, Any]]:
    """Merge index/worktree states so every changed path is shown exactly once."""
    by_path: Dict[str, Dict[str, Any]] = {}

    def record(path, **values):
        item = by_path.setdefault(path, {"path": path, "isStaged": False, "hasWorktree": False,
                                         "isUntracked": False, "conflict": False})
        for key, value in values.items():
            if value not in (None, ""):
                item[key] = value
        return item

    for item in staged or []:
        record(item["path"], isStaged=True, stagedStatus=item.get("stagedStatus") or item.get("status") or "M",
               worktreeStatus=item.get("worktreeStatus") or ".", oldPath=item.get("oldPath"))
    for item in modified or []:
        record(item["path"], hasWorktree=True, worktreeStatus=item.get("worktreeStatus") or item.get("status") or "M",
               stagedStatus=item.get("stagedStatus") or ".", oldPath=item.get("oldPath"))
    for path in untracked or []:
        record(path, hasWorktree=True, isUntracked=True, worktreeStatus="U")
    for item in conflicts or []:
        record(item["path"], hasWorktree=True, conflict=True, worktreeStatus="C",
               stagedStatus=item.get("stagedStatus") or item.get("status") or "C")

    grouped: Dict[str, Dict[str, Any]] = {}
    order = [item[0] for item in GIT_GROUPS] + ["other"]
    labels = {item[0]: item[1] for item in GIT_GROUPS}
    labels["other"] = "Other"
    for path in sorted(by_path, key=str.lower):
        group_id, label = classify_git_path(path)
        group = grouped.setdefault(group_id, {"id": group_id, "label": label, "entries": []})
        item = by_path[path]
        item["status"] = "C" if item["conflict"] else (
            "U" if item["isUntracked"] else (
                item.get("worktreeStatus") if item.get("worktreeStatus") not in (None, ".")
                else item.get("stagedStatus", "M")
            )
        )
        group["entries"].append(item)
    return [grouped[group_id] for group_id in order if group_id in grouped]


def get_git_status(repo_root: pathlib.Path) -> Dict[str, Any]:
    """Return a live, filename-safe status model based on porcelain v2 + NUL records.

    Status is intentionally not cached. Files may change outside the runner and a
    cached clean result must never hide real working-tree changes in the Git panel.
    """
    res = run_git(repo_root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])
    if not res["success"]:
        return {"success": False, "error": res["stderr"], **res}

    records = res["stdout"].split("\0")
    branch = "unknown"
    oid = ""
    upstream = ""
    ahead = 0
    behind = 0
    staged: List[Dict[str, str]] = []
    modified: List[Dict[str, str]] = []
    untracked: List[str] = []
    conflicts: List[Dict[str, str]] = []

    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        if record.startswith("# branch.oid "):
            oid = record[len("# branch.oid "):].strip()
            continue
        if record.startswith("# branch.head "):
            branch = record[len("# branch.head "):].strip()
            continue
        if record.startswith("# branch.upstream "):
            upstream = record[len("# branch.upstream "):].strip()
            continue
        if record.startswith("# branch.ab "):
            match = re.search(r"\+(\d+)\s+-(\d+)", record)
            if match:
                ahead, behind = int(match.group(1)), int(match.group(2))
            continue
        if record.startswith("? "):
            untracked.append(record[2:])
            continue
        if record.startswith("! "):
            continue

        kind = record[0]
        if kind == "1":
            parts = record.split(" ", 8)
            if len(parts) < 9:
                continue
            xy, path = parts[1], parts[8]
            old_path = ""
        elif kind == "2":
            parts = record.split(" ", 9)
            if len(parts) < 10:
                continue
            xy, path = parts[1], parts[9]
            old_path = records[index] if index < len(records) else ""
            index += 1
        elif kind == "u":
            parts = record.split(" ", 10)
            if len(parts) < 11:
                continue
            xy, path, old_path = parts[1], parts[10], ""
            conflicts.append(_entry(path, xy, stagedStatus=xy[0], worktreeStatus=xy[1]))
        else:
            continue

        staged_code = xy[0] if len(xy) > 0 else "."
        worktree_code = xy[1] if len(xy) > 1 else "."
        if staged_code != ".":
            staged.append(_entry(
                path, staged_code, stagedStatus=staged_code,
                worktreeStatus=worktree_code, oldPath=old_path,
            ))
        if worktree_code != ".":
            modified.append(_entry(
                path, worktree_code, stagedStatus=staged_code,
                worktreeStatus=worktree_code, oldPath=old_path,
            ))

    remote_res = run_git(repo_root, ["remote"])
    remotes = [line.strip() for line in remote_res["stdout"].splitlines() if line.strip()]
    detached = branch == "(detached)"
    return {
        "success": True,
        "branch": branch,
        "oid": oid,
        "detached": detached,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "remotes": remotes,
        "canPush": branch == "main" and "origin" in remotes and bool(oid) and oid != "(initial)",
        "staged": staged,
        "modified": modified,
        "untracked": untracked,
        "conflicts": conflicts,
        "groups": group_git_changes(staged, modified, untracked, conflicts),
    }


def get_git_log(repo_root: pathlib.Path, limit: int = 30) -> List[Dict[str, Any]]:
    """Get commit history."""
    fmt = "%H%x1f%h%x1f%an%x1f%ad%x1f%s"
    res = run_git(repo_root, ["log", f"-n{limit}", f"--format={fmt}", "--date=short"])
    if not res["success"]:
        return []

    commits: List[Dict[str, Any]] = []
    for line in res["stdout"].splitlines():
        parts = line.split("\x1f")
        if len(parts) >= 5:
            commits.append({
                "hash": parts[0],
                "short_hash": parts[1],
                "author": parts[2],
                "date": parts[3],
                "message": parts[4],
            })
    return commits


@cached_read
def get_commit_graph(repo_root: pathlib.Path, limit: int = 60) -> Dict[str, Any]:
    """Commit history with lane assignments for a branch-graph drawing."""
    fmt = "%H%x1f%h%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s"
    res = run_git(
        repo_root,
        ["log", "--all", "--date-order", f"-n{limit}", f"--format={fmt}", "--date=short"],
    )
    if not res["success"]:
        return {"success": False, "error": res["stderr"], "commits": [], "laneCount": 0}

    commits: List[Dict[str, Any]] = []
    for line in res["stdout"].splitlines():
        parts = line.split("\x1f")
        if len(parts) < 7:
            continue
        refs = [r.strip() for r in parts[5].split(",") if r.strip()] if parts[5] else []
        commits.append({
            "hash": parts[0],
            "short": parts[1],
            "parents": parts[2].split() if parts[2] else [],
            "author": parts[3],
            "date": parts[4],
            "refs": refs,
            "message": parts[6],
        })

    known = {commit["hash"] for commit in commits}
    lanes: List[Optional[str]] = []

    def free_lane() -> int:
        for lane_index, value in enumerate(lanes):
            if value is None:
                return lane_index
        lanes.append(None)
        return len(lanes) - 1

    for commit in commits:
        if commit["hash"] in lanes:
            lane = lanes.index(commit["hash"])
            for lane_index in range(len(lanes)):
                if lane_index != lane and lanes[lane_index] == commit["hash"]:
                    lanes[lane_index] = None
        else:
            lane = free_lane()
        commit["lane"] = lane

        visible_parents = [parent for parent in commit["parents"] if parent in known]
        if visible_parents:
            lanes[lane] = visible_parents[0]
            for parent in visible_parents[1:]:
                if parent not in lanes:
                    lanes[free_lane()] = parent
        else:
            lanes[lane] = None
        while lanes and lanes[-1] is None:
            lanes.pop()

    lane_count = max((commit["lane"] for commit in commits), default=-1) + 1
    return {"success": True, "commits": commits, "laneCount": max(1, lane_count)}


def get_commit_detail(repo_root: pathlib.Path, sha: str) -> Dict[str, Any]:
    """Full metadata and diffstat for one commit (used by the graph menu)."""
    if not re.fullmatch(r"[0-9a-fA-F]{4,40}", sha or ""):
        return {"success": False, "error": "Invalid commit id"}
    show = run_git(repo_root, ["show", "--stat", "--format=fuller", sha])
    return {
        "success": show["success"],
        "sha": sha,
        "text": show["stdout"] or show["stderr"],
    }


def get_file_diff(repo_root: pathlib.Path, rel_path: str) -> Dict[str, Any]:
    """Get diff and both versions (HEAD vs working copy) for Monaco."""
    diff_res = run_git(repo_root, ["diff", "HEAD", "--", rel_path])
    head_content_res = run_git(repo_root, ["show", f"HEAD:{rel_path}"])

    working_file = repo_root / rel_path
    working_content = ""
    if working_file.exists():
        try:
            working_content = working_file.read_text(encoding="utf-8", errors="replace")
        except Exception:
            working_content = ""

    return {
        "success": True,
        "path": rel_path,
        "diff": diff_res["stdout"],
        "head_content": head_content_res["stdout"] if head_content_res["success"] else "",
        "working_content": working_content,
    }


@git_write
def git_stage(repo_root: pathlib.Path, rel_path: str) -> Dict[str, Any]:
    return run_git(repo_root, ["add", "--", rel_path])


@git_write
def git_stage_all(repo_root: pathlib.Path) -> Dict[str, Any]:
    return run_git(repo_root, ["add", "-A", "--", "."])


@git_write
def git_unstage(repo_root: pathlib.Path, rel_path: str) -> Dict[str, Any]:
    head = run_git(repo_root, ["rev-parse", "--verify", "HEAD"])
    if head["success"]:
        return run_git(repo_root, ["restore", "--staged", "--", rel_path])
    return run_git(repo_root, ["rm", "--cached", "--ignore-unmatch", "--", rel_path])


@git_write
def git_unstage_all(repo_root: pathlib.Path) -> Dict[str, Any]:
    head = run_git(repo_root, ["rev-parse", "--verify", "HEAD"])
    if head["success"]:
        return run_git(repo_root, ["reset", "--quiet", "HEAD", "--", "."])
    return run_git(repo_root, ["rm", "-r", "--cached", "--ignore-unmatch", "--", "."])


@git_write
def git_commit(repo_root: pathlib.Path, message: str) -> Dict[str, Any]:
    staged = run_git(repo_root, ["diff", "--cached", "--quiet", "--exit-code"])
    if staged["exit_code"] == 0:
        return {
            "success": False,
            "stdout": "",
            "stderr": "Nothing is staged. Stage one or more files before committing.",
            "exit_code": 1,
            "command": "git commit",
        }
    if staged["exit_code"] != 1:
        return staged
    # Do not run automatic repacking in the foreground on the mapped drive.
    # This is per-command only; manual/scheduled Git maintenance is unchanged.
    return run_git(repo_root, ["-c", "maintenance.auto=false", "-c", "gc.auto=0",
                               "commit", "-m", message], timeout=60)


@git_write
def git_pull(repo_root: pathlib.Path) -> Dict[str, Any]:
    return run_git(repo_root, ["pull", "--ff-only"], timeout=120)


def _main_push_error(status: Dict[str, Any]) -> str:
    if status.get("branch") != "main" or status.get("detached"):
        return "This button pushes main only. Check out main first."
    if "origin" not in status.get("remotes", []):
        return "No origin remote is configured. Add origin before committing and pushing."
    if status.get("conflicts"):
        return "Resolve the merge conflicts before committing and pushing."
    return ""


@git_write
def git_push(repo_root: pathlib.Path) -> Dict[str, Any]:
    status = get_git_status(repo_root)
    if not status.get("success"):
        return status
    error = _main_push_error(status)
    if error:
        return {"success": False, "stdout": "", "exit_code": 1,
                "stderr": error, "command": "git push"}
    # An explicit non-forced refspec ignores push.default and remote push refspecs.
    return run_git(repo_root, ["-c", "push.followTags=false", "push", "--porcelain",
                               "--set-upstream", "origin",
                               "refs/heads/main:refs/heads/main"], timeout=120)


@git_write
def git_commit_and_push(repo_root: pathlib.Path, message: str = "") -> Dict[str, Any]:
    """Commit staged files, then push main; an empty index retries only the push."""
    steps: List[Dict[str, Any]] = []
    committed = False

    def result(operation, summary):
        return {**operation, "steps": steps, "committed": committed,
                "pushed": operation["success"], "summary": summary}

    status = get_git_status(repo_root)
    if not status.get("success"):
        return result(status, "Could not read Git status. Nothing was pushed.")
    error = _main_push_error(status)
    if status.get("staged") and not message.strip():
        error = "Write a commit message first."
    if error:
        return result({"success": False, "stdout": "", "stderr": error,
                       "exit_code": 1, "command": "git commit and push"}, error)

    if status.get("staged"):
        commit = git_commit(repo_root, message.strip())
        steps.append({**commit, "label": "Git commit"})
        if not commit["success"]:
            return result(commit, "Commit did not complete. Nothing was pushed; see console.")
        committed = True

    push = git_push(repo_root)
    steps.append({**push, "label": "Git push to origin/main"})
    if push["success"]:
        summary = "Committed and pushed to origin/main." if committed else "Pushed to origin/main."
    else:
        summary = ("Commit saved locally. Push to origin/main failed. " if committed else
                   "Push to origin/main failed. Local commits are still saved. ")
        summary += "Use Push to main to retry; see console for details."
    return result(push, summary)


@git_write
def git_fetch(repo_root: pathlib.Path) -> Dict[str, Any]:
    return run_git(repo_root, ["fetch", "--prune"], timeout=120)
