"""LaTeX structure parser: document outline, labels, figures and equations.

Headings, captions and environment bodies routinely span several lines and
nest braces (``\\subsection{\\textcolor{blue}{Envelope dynamics}}``), so the
scan works on whole files with balanced-group extraction rather than on single
lines, and follows ``\\input``/``\\include`` in document order.
"""
from __future__ import annotations

import bisect
import pathlib
import re
from typing import Any, Dict, List, Optional, Set, Tuple

LEVELS = {
    "part": 0,
    "chapter": 1,
    "section": 2,
    "subsection": 3,
    "subsubsection": 4,
    # Project-local visual heading defined in several manuscript modules.
    "subsubsubsection": 5,
    "paragraph": 6,
    "subparagraph": 7,
}

NUMBERED_BY_DEFAULT = {"part", "chapter", "section", "subsection", "subsubsection"}

MATH_ENVS = "equation|align|gather|multline|eqnarray|flalign|alignat|dmath"

TOKEN_RE = re.compile(
    r"\\(?P<include>input|include|subfile)\s*\{(?P<include_arg>[^}]*)\}"
    r"|\\(?P<sec>subsubsubsection|subsubsection|subsection|subparagraph|paragraph|"
    r"section|chapter|part)(?P<star>\*?)(?=\s*[\[{])"
    r"|\\label\s*\{(?P<label>[^}]*)\}"
    r"|\\begin\s*\{(?P<env>figure\*?|(?:" + MATH_ENVS + r")\*?)\}"
)

# Switches that carry no visible text: drop them entirely.
DROP_RE = re.compile(
    r"\\(?:color|normalfont|bfseries|itshape|rmfamily|sffamily|ttfamily|centering|"
    r"raggedright|raggedleft|tiny|scriptsize|footnotesize|small|normalsize|large|"
    r"Large|LARGE|huge|Huge|protect|noindent|allowbreak|linebreak|newline)\b\s*"
    r"(?:\{[^{}]*\})?"
)
# Two-argument wrappers whose *second* argument is the visible text.
WRAP2_RE = re.compile(
    r"\\(?:textcolor|texorpdfstring|colorbox|fcolorbox)\s*(?:\[[^\]]*\])?\s*"
    r"\{[^{}]*\}\s*\{([^{}]*)\}"
)
# Single-argument wrappers whose argument is the visible text.
WRAP1_RE = re.compile(
    r"\\(?:textls|emph|textbf|textit|textrm|texttt|textsc|textsf|textnormal|text|"
    r"mbox|hbox|uppercase|lowercase|MakeUppercase|MakeLowercase|underline|"
    r"mathrm|mathcal|mathbf|mathit|mathsf|bm|boldsymbol)\s*(?:\[[^\]]*\])?\s*"
    r"\{([^{}]*)\}"
)


def strip_comments(content: str) -> str:
    """Blank out %-comments while preserving line structure and escaped \\%."""
    out: List[str] = []
    for line in content.split("\n"):
        index = 0
        cut = None
        while index < len(line):
            char = line[index]
            if char == "\\":
                index += 2
                continue
            if char == "%":
                cut = index
                break
            index += 1
        out.append(line if cut is None else line[:cut])
    return "\n".join(out)


def extract_group(text: str, open_index: int, opener: str = "{") -> Optional[Tuple[str, int]]:
    """Return (contents, index_after) for the balanced group at ``open_index``.

    Returns None when the group never closes, so callers can skip malformed
    input instead of capturing the rest of the document.
    """
    closer = "}" if opener == "{" else "]"
    if open_index >= len(text) or text[open_index] != opener:
        return None
    depth = 0
    index = open_index
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                return text[open_index + 1:index], index + 1
        index += 1
    return None


def skip_space(text: str, index: int) -> int:
    while index < len(text) and text[index] in " \t\r\n":
        index += 1
    return index


MATH_SPAN_RE = re.compile(r"\$[^$]*\$")


def clean_latex_text(text: str, keep_math: bool = False) -> str:
    """Reduce a LaTeX title or caption to readable plain text.

    With ``keep_math`` the inline ``$...$`` spans survive verbatim, which keeps
    figure captions faithful; headings read better fully flattened.
    """
    if not text:
        return ""

    math: List[str] = []
    current = text
    if keep_math:
        def stash(match: "re.Match[str]") -> str:
            math.append(match.group(0))
            return "\x00M%d\x00" % (len(math) - 1)
        current = MATH_SPAN_RE.sub(stash, current)

    previous = None
    for _ in range(8):
        if current == previous:
            break
        previous = current
        current = DROP_RE.sub("", current)
        current = WRAP2_RE.sub(r"\1", current)
        current = WRAP1_RE.sub(r"\1", current)
    current = re.sub(r"\\[a-zA-Z@]+\*?", "", current)
    current = re.sub(r"\\[^a-zA-Z]", "", current)
    current = re.sub(r"[{}$]", "", current)
    current = current.replace("~", " ")
    current = re.sub(r"\s+", " ", current).strip()

    if math:
        current = re.sub(r"\x00M(\d+)\x00", lambda m: math[int(m.group(1))], current)
    return current


class _FileScanner:
    """Scans one .tex file and recurses through \\input in document order."""

    def __init__(self, repo_root: pathlib.Path, visited: Set[pathlib.Path]) -> None:
        self.repo_root = repo_root
        self.visited = visited
        self.outline: List[Dict[str, Any]] = []
        self.labels: List[Dict[str, Any]] = []
        self.figures: List[Dict[str, Any]] = []
        self.equations: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------ util
    @staticmethod
    def _line_starts(text: str) -> List[int]:
        starts = [0]
        for index, char in enumerate(text):
            if char == "\n":
                starts.append(index + 1)
        return starts

    @staticmethod
    def _line_of(starts: List[int], position: int) -> int:
        return bisect.bisect_right(starts, position)

    def _resolve_include(self, target: str, current: pathlib.Path) -> Optional[pathlib.Path]:
        candidate = target.strip().replace("\\", "/")
        if not candidate:
            return None
        names = [candidate] if candidate.endswith(".tex") else [candidate + ".tex", candidate]
        for name in names:
            for base in (self.repo_root, current.parent):
                try:
                    resolved = (base / name).resolve()
                except OSError:
                    continue
                if self.repo_root in resolved.parents and resolved.is_file():
                    return resolved
        return None

    # ------------------------------------------------------------------ scan
    def scan(self, file_path: pathlib.Path) -> None:
        try:
            resolved = file_path.resolve()
        except OSError:
            return
        if (
            self.repo_root not in resolved.parents
            or resolved in self.visited
            or not resolved.is_file()
        ):
            return
        self.visited.add(resolved)

        try:
            raw = resolved.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return

        try:
            rel_file = resolved.relative_to(self.repo_root).as_posix()
        except ValueError:
            rel_file = resolved.as_posix()

        text = strip_comments(raw)
        starts = self._line_starts(text)

        for match in TOKEN_RE.finditer(text):
            line_no = self._line_of(starts, match.start())

            if match.group("include"):
                target = self._resolve_include(match.group("include_arg"), resolved)
                if target:
                    self.scan(target)
                continue

            if match.group("sec"):
                self._read_heading(text, match, rel_file, line_no)
                continue

            if match.group("label") is not None:
                self.labels.append({
                    "label": match.group("label").strip(),
                    "file": rel_file,
                    "line": line_no,
                })
                continue

            env = match.group("env")
            if env:
                if env.startswith("figure"):
                    self._read_figure(text, match.end(), env, rel_file, line_no)
                else:
                    self._read_equation(text, match.end(), env, rel_file, line_no)

    def _read_heading(self, text: str, match: "re.Match[str]", rel_file: str, line_no: int) -> None:
        kind = match.group("sec")
        index = skip_space(text, match.end())

        short: Optional[str] = None
        if index < len(text) and text[index] == "[":
            optional = extract_group(text, index, "[")
            if optional:
                short, index = optional
                index = skip_space(text, index)

        group = extract_group(text, index)
        if not group:
            return  # e.g. \section inside a \newcommand body: not a heading
        raw_title = group[0]

        # The optional argument is the author's own short title: prefer it.
        title = clean_latex_text(short) or clean_latex_text(raw_title)
        self.outline.append({
            "type": kind,
            "level": LEVELS.get(kind, 2),
            "title": title,
            "raw_title": raw_title,
            "numbered": kind in NUMBERED_BY_DEFAULT and not match.group("star"),
            "file": rel_file,
            "line": line_no,
        })

    def _read_figure(self, text: str, body_start: int, env: str, rel_file: str, line_no: int) -> None:
        end_match = re.compile(r"\\end\s*\{" + re.escape(env) + r"\}").search(text, body_start)
        body = text[body_start:end_match.start()] if end_match else text[body_start:body_start + 4000]

        image = ""
        graphic = re.search(r"\\includegraphics\s*(?:\[[^\]]*\])?\s*\{", body)
        if graphic:
            group = extract_group(body, graphic.end() - 1)
            if group:
                image = group[0].strip()

        caption = ""
        caption_match = re.search(r"\\caption\s*(?:\[[^\]]*\])?\s*\{", body)
        if caption_match:
            group = extract_group(body, caption_match.end() - 1)
            if group:
                caption = clean_latex_text(group[0], keep_math=True)

        label = ""
        label_match = re.search(r"\\label\s*\{([^}]*)\}", body)
        if label_match:
            label = label_match.group(1).strip()

        self.figures.append({
            "file": rel_file,
            "start_line": line_no,
            "caption": caption,
            "image": image,
            "label": label,
        })

    def _read_equation(self, text: str, body_start: int, env: str, rel_file: str, line_no: int) -> None:
        end_match = re.compile(r"\\end\s*\{" + re.escape(env) + r"\}").search(text, body_start)
        body = text[body_start:end_match.start()] if end_match else text[body_start:body_start + 4000]
        label_match = re.search(r"\\label\s*\{([^}]*)\}", body)
        if not label_match:
            return
        source = ("\\begin{%s}%s\\end{%s}" % (env, body, env)).strip()
        self.equations.append({
            "label": label_match.group(1).strip(),
            "file": rel_file,
            "line": line_no,
            # Hovers show a preview only; keep the index payload small.
            "latex": source if len(source) <= 900 else source[:900] + "\n…",
        })


def get_document_outline(repo_root: pathlib.Path, entry_file: str = "main.tex") -> Dict[str, Any]:
    """Build the outline, label, figure and equation index for the document."""
    scanner = _FileScanner(repo_root.resolve(), set())
    scanner.scan(repo_root / entry_file)
    return {
        "outline": scanner.outline,
        "labels": scanner.labels,
        "figures": scanner.figures,
        "equations": scanner.equations,
    }
