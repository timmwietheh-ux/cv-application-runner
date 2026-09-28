"""In-document review comments storage.

The JSON layout (``{"comments": [{id, file, startLine, startCol, endLine,
endCol, selectedText, text, author, status, createdAt, replies}]}``) is a
public interface: agents read and answer owner comments directly in the file.
"""
from __future__ import annotations

import datetime
import json
import pathlib
import threading
import uuid
from typing import Any, Dict, List, Optional

import project
from storage_utils import atomic_write_json

# Tests and tools may pin a file; otherwise the project's data folder is used.
COMMENTS_FILE: Optional[pathlib.Path] = None
_LOCK = threading.RLock()


def comments_file() -> pathlib.Path:
    return COMMENTS_FILE or project.current().data_dir / "comments.json"


def load_comments() -> List[Dict[str, Any]]:
    with _LOCK:
        path = comments_file()
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                comments = data.get("comments", []) if isinstance(data, dict) else []
                return comments if isinstance(comments, list) else []
            except (OSError, ValueError, TypeError):
                return []
        return []


def save_comments(comments: List[Dict[str, Any]]) -> None:
    if not isinstance(comments, list):
        raise ValueError("comments must be a list")
    with _LOCK:
        atomic_write_json(comments_file(), {"comments": comments})


def add_comment(
    file_path: str,
    start_line: int,
    start_col: int,
    end_line: int,
    end_col: int,
    selected_text: str,
    text: str,
    author: str = "Author",
) -> Dict[str, Any]:
    with _LOCK:
        comments = load_comments()
        new_comment = {
            "id": str(uuid.uuid4())[:8],
            "file": file_path.replace("\\", "/"),
            "startLine": start_line,
            "startCol": start_col,
            "endLine": end_line,
            "endCol": end_col,
            "selectedText": selected_text,
            "text": text,
            "author": author,
            "status": "open",
            "createdAt": datetime.datetime.now().isoformat(),
            "replies": [],
        }
        comments.append(new_comment)
        save_comments(comments)
        return new_comment


def update_comment_status(comment_id: str, status: str) -> Optional[Dict[str, Any]]:
    with _LOCK:
        comments = load_comments()
        target = None
        for c in comments:
            if c.get("id") == comment_id:
                c["status"] = status
                target = c
                break
        if target:
            save_comments(comments)
        return target


def add_reply(comment_id: str, text: str, author: str = "Author") -> Optional[Dict[str, Any]]:
    with _LOCK:
        comments = load_comments()
        target = None
        for c in comments:
            if c.get("id") == comment_id:
                reply = {
                    "id": str(uuid.uuid4())[:8],
                    "text": text,
                    "author": author,
                    "createdAt": datetime.datetime.now().isoformat(),
                }
                if "replies" not in c:
                    c["replies"] = []
                c["replies"].append(reply)
                target = c
                break
        if target:
            save_comments(comments)
        return target


def delete_comment(comment_id: str) -> bool:
    with _LOCK:
        comments = load_comments()
        initial_len = len(comments)
        comments = [c for c in comments if c.get("id") != comment_id]
        if len(comments) < initial_len:
            save_comments(comments)
            return True
        return False
