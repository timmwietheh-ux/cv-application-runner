"""Overview of a project's AI governance material.

Feeds the IDE's AI workspace: the latest handoff entry, active and archived
change contracts with their parsed metadata and workflow stage, research
dossiers, prompts, top-level briefs, and the standing agreement documents.
Every location comes from the ``ai`` section of ``latex-runner.json``, so a
project without contracts simply shows what it has.
"""
from __future__ import annotations

import pathlib
import re
import time
from typing import Any, Dict, List, Optional

DEFAULTS: Dict[str, Any] = {
    "root": "Docs/AI",
    "contractsActive": "Docs/AI/Contracts/Active",
    "contractsArchive": "Docs/AI/Contracts/Archive",
    "prompts": "Docs/AI/Prompts",
    "research": "Docs/AI/Research",
    "handoff": "HANDOFF.md",
    "governance": [
        ["AGENTS.md", "Repository agreement"],
        ["CLAUDE.md", "Claude Code mirror"],
        ["MEMORY.md", "Durable project memory"],
        ["HANDOFF.md", "Current handoff"],
    ],
}

# Document families that live directly under the AI root.
DOSSIER_KINDS = {
    "DER": "Derivation dossier",
    "AUDIT": "Audit",
    "BRIEF": "Brief",
    "PLAN": "Plan",
    "REVIEW": "Review",
    "ROADMAP": "Roadmap",
}

META_RE = re.compile(r"^-\s+\*\*(?P<key>[^*]+?):?\*\*:?\s*(?P<value>.*)$")
TITLE_RE = re.compile(r"^#\s+(.*)$")
DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")

STATUS_CLASSES = [
    (r"discontinu", "archived"),
    (r"archiv", "archived"),
    (r"accept", "accepted"),
    (r"rework|reject", "rework"),
    (r"complete|done|closed|abgeschlossen|editor-executed", "complete"),
    (r"in[-\s]?progress|in arbeit|running|editor working", "progress"),
    (r"ready[-\s]?for[-\s]?editor|ready", "ready"),
    (r"draft|entwurf", "draft"),
]

# The four-stage contract loop, in order.
STAGES = [
    ("thinker", "Audit & contract"),
    ("gate", "Review & gate"),
    ("editor", "Editor"),
    ("review", "Final review"),
]


def classify_status(status: str) -> str:
    lowered = (status or "").lower()
    for pattern, name in STATUS_CLASSES:
        if re.search(pattern, lowered):
            return name
    return "unknown"


def workflow_phase(status: str, archived: bool = False) -> Dict[str, str]:
    """Translate contract prose into an honest Thinker--Editor workflow stage."""
    lowered = (status or "").lower()
    if archived or "archiv" in lowered or "discontinu" in lowered:
        return {"phase": "archive", "phaseLabel": "Archived", "nextAction": "No open gate"}
    if "rework" in lowered or "reject" in lowered:
        return {"phase": "rework", "phaseLabel": "Rework", "nextAction": "Return to the authorised editor scope"}
    if "final" in lowered and ("review" in lowered or "denker" in lowered):
        return {"phase": "review", "phaseLabel": "Final review", "nextAction": "Fresh independent final review"}
    if "accept" in lowered:
        return {"phase": "accepted", "phaseLabel": "Accepted", "nextAction": "Archive only with owner authority"}
    if "editor-complete" in lowered or "ready-for-review" in lowered or "editor-executed" in lowered:
        return {"phase": "review", "phaseLabel": "Final review", "nextAction": "Fresh independent final review"}
    if "in-progress" in lowered or "in progress" in lowered or "running" in lowered:
        return {"phase": "editor", "phaseLabel": "Editor running", "nextAction": "Finish editor evidence and handoff"}
    if "ready-for-editor" in lowered or "ready for editor" in lowered:
        return {"phase": "editor", "phaseLabel": "Ready for editor", "nextAction": "Execute only the authorised contract scope"}
    if "audit" in lowered or "gate" in lowered:
        return {"phase": "gate", "phaseLabel": "Review & gate", "nextAction": "Sharpen the contract, then release it"}
    if "draft" in lowered:
        return {"phase": "thinker", "phaseLabel": "Thinker draft", "nextAction": "Complete the scientific contract gates"}
    return {"phase": "unknown", "phaseLabel": "Needs inspection", "nextAction": "Open the contract and verify its current gate"}


def _mtime(path: pathlib.Path) -> int:
    try:
        return int(path.stat().st_mtime)
    except OSError:
        return 0


def _first_heading(path: pathlib.Path, limit: int = 15) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for index, line in enumerate(handle):
                heading = TITLE_RE.match(line.rstrip())
                if heading:
                    return heading.group(1).strip()
                if index > limit:
                    break
    except OSError:
        pass
    return ""


def parse_contract(path: pathlib.Path, repo_root: pathlib.Path, archived: bool = False) -> Dict[str, Any]:
    """Read the leading metadata block of a change contract."""
    title = path.stem
    meta: Dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            current_key: Optional[str] = None
            for index, line in enumerate(handle):
                if index > 80:
                    break
                stripped = line.rstrip()
                if index < 6:
                    heading = TITLE_RE.match(stripped)
                    if heading:
                        title = heading.group(1).strip()
                        title = re.sub(r"^Change Contract:\s*", "", title)
                        continue
                match = META_RE.match(stripped)
                if match:
                    current_key = match.group("key").strip().lower()
                    meta[current_key] = match.group("value").strip()
                    continue
                # Continuation of a wrapped metadata bullet.
                if current_key and stripped.startswith("  ") and stripped.strip():
                    meta[current_key] = (meta[current_key] + " " + stripped.strip()).strip()
                    continue
                if stripped.startswith("---") or stripped.startswith("## "):
                    break
                current_key = None
    except OSError:
        pass

    status = meta.get("status", "").strip("` ")
    created = meta.get("created", "")
    if not created:
        date_match = DATE_RE.search(path.name)
        created = date_match.group(1) if date_match else ""
    result = {
        "path": path.relative_to(repo_root).as_posix(),
        "file": path.name,
        "title": title,
        "id": meta.get("contract id", path.stem),
        "status": status,
        "statusClass": classify_status(status),
        "created": created[:10],
        "createdBy": meta.get("created by", ""),
        "requestedBy": meta.get("requested by", ""),
        "editor": meta.get("editor", ""),
        "reviewer": meta.get("final reviewer", ""),
        "mtime": _mtime(path),
    }
    result.update(workflow_phase(status, archived))
    return result


def _scan_contracts(repo_root: pathlib.Path, folder: str, archived: bool = False) -> List[Dict[str, Any]]:
    directory = repo_root / folder
    if not folder or not directory.is_dir():
        return []
    items = []
    for path in sorted(directory.glob("*.md")):
        if path.name.upper() in ("README.MD", "TEMPLATE.MD"):
            continue
        items.append(parse_contract(path, repo_root, archived))
    items.sort(key=lambda item: (item["created"], item["id"]), reverse=True)
    return items


def _scan_dossiers(repo_root: pathlib.Path, folder: str) -> List[Dict[str, Any]]:
    directory = repo_root / folder
    if not folder or not directory.is_dir():
        return []
    items: List[Dict[str, Any]] = []
    for path in sorted(directory.glob("*.md")):
        prefix = path.name.split("-", 1)[0].upper()
        if prefix not in DOSSIER_KINDS:
            continue
        date_match = DATE_RE.search(path.name)
        items.append({
            "path": path.relative_to(repo_root).as_posix(),
            "file": path.name,
            "kind": prefix,
            "kindLabel": DOSSIER_KINDS[prefix],
            "title": _first_heading(path, 12) or path.stem,
            "date": date_match.group(1) if date_match else "",
            "mtime": _mtime(path),
        })
    items.sort(key=lambda item: (item["date"], item["file"]), reverse=True)
    return items


def _scan_research(repo_root: pathlib.Path, folder: str) -> List[Dict[str, Any]]:
    """One entry per research dossier folder (its README or first Markdown file)."""
    directory = repo_root / folder
    if not folder or not directory.is_dir():
        return []
    items: List[Dict[str, Any]] = []
    for entry in sorted(directory.iterdir()):
        if entry.name.startswith(".") or entry.name.startswith("_"):
            continue
        if entry.is_dir():
            readme = entry / "README.md"
            if not readme.is_file():
                markdown = sorted(entry.glob("*.md"))
                if not markdown:
                    continue
                readme = markdown[0]
            files = 0
            try:
                files = sum(1 for _ in entry.rglob("*") if _.is_file())
            except OSError:
                pass
            date_match = DATE_RE.search(entry.name)
            items.append({
                "path": readme.relative_to(repo_root).as_posix(),
                "folder": entry.relative_to(repo_root).as_posix(),
                "title": _first_heading(readme, 20) or entry.name.replace("_", " "),
                "name": entry.name,
                "date": date_match.group(1) if date_match else "",
                "files": files,
                "mtime": max(_mtime(readme), _mtime(entry)),
                "kind": "RESEARCH",
            })
        elif entry.suffix.lower() == ".md":
            date_match = DATE_RE.search(entry.name)
            items.append({
                "path": entry.relative_to(repo_root).as_posix(),
                "folder": "",
                "title": _first_heading(entry, 20) or entry.stem,
                "name": entry.name,
                "date": date_match.group(1) if date_match else "",
                "files": 1,
                "mtime": _mtime(entry),
                "kind": "RESEARCH",
            })
    items.sort(key=lambda item: (item["date"] or time.strftime("%Y-%m-%d", time.localtime(item["mtime"])),
                                 item["mtime"]), reverse=True)
    return items


def _scan_prompts(repo_root: pathlib.Path, folder: str) -> List[Dict[str, Any]]:
    directory = repo_root / folder
    if not folder or not directory.is_dir():
        return []
    items: List[Dict[str, Any]] = []
    for path in sorted(directory.glob("*.md")):
        if path.name.upper() == "README.MD":
            continue
        title = path.stem
        target_model = ""
        role = ""
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                for index, line in enumerate(handle):
                    stripped = line.rstrip()
                    if index < 15:
                        heading = TITLE_RE.match(stripped)
                        if heading and title == path.stem:
                            title = heading.group(1).strip()
                        if "Target Model:" in stripped or "Target System:" in stripped:
                            target_model = re.sub(r"^.*Target (?:Model|System):\*?\*?\s*", "", stripped).strip().strip("*")
                        if "Role:" in stripped:
                            role = re.sub(r"^.*Role:\*?\*?\s*", "", stripped).strip().strip("*")
                    if index > 30:
                        break
        except OSError:
            pass
        date_match = DATE_RE.search(path.name)
        items.append({
            "path": path.relative_to(repo_root).as_posix(),
            "file": path.name,
            "title": title,
            "date": date_match.group(1) if date_match else "",
            "model": target_model,
            "role": role,
            "kind": "PROMPT",
            "mtime": _mtime(path),
        })
    items.sort(key=lambda item: (item["date"], item["mtime"], item["file"]), reverse=True)
    return items


def latest_handoff(repo_root: pathlib.Path, rel: str) -> Optional[Dict[str, Any]]:
    """The newest entry of the handoff file: heading, line and a short summary."""
    path = repo_root / rel if rel else None
    if path is None or not path.is_file():
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            lines = [line.rstrip("\n") for _, line in zip(range(400), handle)]
    except OSError:
        return None
    for index, line in enumerate(lines):
        if line.startswith("### ") or line.startswith("## "):
            heading = line.lstrip("#").strip()
            summary: List[str] = []
            for follow in lines[index + 1:index + 30]:
                if follow.startswith("#"):
                    break
                text = re.sub(r"\*\*|`|\$", "", follow).strip(" -")
                if text:
                    summary.append(text)
                if sum(len(item) for item in summary) > 420:
                    break
            date_match = DATE_RE.search(heading)
            return {
                "path": rel,
                "line": index + 1,
                "title": re.sub(r"^\d{4}-\d{2}-\d{2}\s*[—–-]\s*", "", heading),
                "date": date_match.group(1) if date_match else "",
                "summary": " ".join(summary)[:480],
                "mtime": _mtime(path),
            }
    return None


def get_ai_overview(repo_root: pathlib.Path, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = dict(DEFAULTS)
    cfg.update({key: value for key, value in (config or {}).items() if value is not None})
    active = _scan_contracts(repo_root, cfg.get("contractsActive", ""))
    archive = _scan_contracts(repo_root, cfg.get("contractsArchive", ""), archived=True)
    dossiers = _scan_dossiers(repo_root, cfg.get("root", ""))
    prompts = _scan_prompts(repo_root, cfg.get("prompts", ""))
    research = _scan_research(repo_root, cfg.get("research", ""))
    handoff = latest_handoff(repo_root, cfg.get("handoff", ""))

    governance = []
    for entry in cfg.get("governance") or []:
        if isinstance(entry, (list, tuple)) and entry:
            rel, description = str(entry[0]), str(entry[1]) if len(entry) > 1 else ""
        elif isinstance(entry, str):
            rel, description = entry, ""
        else:
            continue
        path = repo_root / rel
        if not path.is_file():
            continue
        governance.append({
            "path": rel,
            "file": rel.split("/")[-1],
            "description": description,
            "mtime": _mtime(path),
        })

    activity: List[Dict[str, Any]] = []
    for contract in active:
        activity.append({"path": contract["path"], "title": contract["title"], "kind": "CONTRACT",
                         "mtime": contract["mtime"], "detail": contract["phaseLabel"]})
    for contract in archive[:8]:
        activity.append({"path": contract["path"], "title": contract["title"], "kind": "ARCHIVE",
                         "mtime": contract["mtime"], "detail": contract.get("status", "")[:60]})
    for item in research:
        activity.append({"path": item["path"], "title": item["title"], "kind": "RESEARCH",
                         "mtime": item["mtime"], "detail": item["name"]})
    for item in prompts[:12]:
        activity.append({"path": item["path"], "title": item["title"], "kind": "PROMPT",
                         "mtime": item["mtime"], "detail": item.get("model", "")})
    for dossier in dossiers:
        activity.append({"path": dossier["path"], "title": dossier["title"], "kind": dossier["kind"],
                         "mtime": dossier.get("mtime", 0), "detail": dossier["kindLabel"]})
    for item in governance:
        activity.append({"path": item["path"], "title": item["file"], "kind": "GOV",
                         "mtime": item["mtime"], "detail": item["description"]})
    activity.sort(key=lambda item: (item["mtime"], item["path"]), reverse=True)

    stages = {key: 0 for key, _label in STAGES}
    for contract in active:
        phase = contract.get("phase")
        if phase in stages:
            stages[phase] += 1
        elif phase in ("accepted", "rework"):
            stages["review" if phase == "accepted" else "editor"] += 1

    return {
        "active": active,
        "archive": archive,
        "dossiers": dossiers,
        "prompts": prompts,
        "research": research,
        "governance": governance,
        "handoff": handoff,
        "activity": activity[:14],
        "stages": [{"key": key, "label": label, "count": stages[key]} for key, label in STAGES],
        "generatedAt": int(time.time()),
        "counts": {
            "active": len(active),
            "archive": len(archive),
            "dossiers": len(dossiers),
            "prompts": len(prompts),
            "research": len(research),
        },
    }
