"""Platform-safe subprocess options for the local Runner backend."""
from __future__ import annotations

import os
import subprocess
from typing import Any, Dict


def hidden_subprocess_kwargs(new_process_group: bool = False) -> Dict[str, Any]:
    """Prevent console children from flashing or stealing focus on Windows."""
    if os.name != "nt":
        return {"start_new_session": True} if new_process_group else {}
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if new_process_group:
        flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 0)
    startup.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
    return {"creationflags": flags, "startupinfo": startup}
