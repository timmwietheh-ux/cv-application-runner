"""Plain text with a little markup, turned into safe LaTeX.

Block fields hold what a person would type, not LaTeX. Every TeX special
character is escaped, so a stray ``&``, ``%`` or ``_`` can never break a build.
A small, predictable markup covers the rest:

    **bold**            -> \\textbf{bold}
    *italic*            -> \\emph{italic}
    [label](https://x)  -> \\href{https://x}{label}
    `code`              -> \\texttt{code}
    $x^2$               -> inline mathematics, passed through unchanged
    [[TODO: question]]  -> \\cvPlaceholder{question}, a visible red marker
    "quoted"            -> curly double quotes
    a - b               -> a spaced hyphen becomes an en dash
    ...                 -> an ellipsis

A no-break space (U+00A0) becomes ``~``. A blank line starts a new paragraph,
a single line break is an ordinary space.
"""
from __future__ import annotations

import re
from typing import List

_SPECIALS = {
    "\\": r"\textbackslash{}",
    "{": r"\{",
    "}": r"\}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "^": r"\textasciicircum{}",
    "~": r"\textasciitilde{}",
    "\u00a0": "~",
}

# Order matters: placeholders and maths first, so their content stays raw.
_TOKEN = re.compile(
    r"(?P<todo>\[\[\s*TODO\s*:?\s*(?P<todotext>.*?)\]\])"
    r"|(?P<math>\$(?P<mathtext>[^$\n]+?)\$)"
    r"|(?P<code>`(?P<codetext>[^`\n]+)`)"
    r"|(?P<link>\[(?P<linktext>[^\]\n]+)\]\((?P<url>[^)\s]+)\))"
    r"|(?P<bold>\*\*(?P<boldtext>.+?)\*\*)"
    r"|(?P<italic>(?<![\w*])\*(?P<italictext>[^*\n]+?)\*(?![\w*]))",
    re.S,
)


def escape(text: str) -> str:
    """Escape every TeX special character of plain ``text``."""
    return "".join(_SPECIALS.get(char, char) for char in str(text))


def _typography(text: str) -> str:
    text = re.sub(r'"([^"\n]+)"', "\u201c\\1\u201d", text)
    text = re.sub(r"(?<=\s)-(?=\s)", "\u2013", text)
    text = text.replace("...", "\u2026")
    return text


def _escape_url(url: str) -> str:
    return url.replace("\\", "/").replace("%", r"\%").replace("#", r"\#").replace("{", "").replace("}", "")


def _span(text: str) -> str:
    """Convert one paragraph (no blank lines) of marked-up text."""
    out: List[str] = []
    position = 0
    for match in _TOKEN.finditer(text):
        out.append(escape(_typography(text[position:match.start()])))
        if match.group("todo"):
            out.append(r"\cvPlaceholder{%s}" % escape(match.group("todotext").strip() or "missing"))
        elif match.group("math"):
            out.append("$%s$" % match.group("mathtext"))
        elif match.group("code"):
            out.append(r"\texttt{%s}" % escape(match.group("codetext")))
        elif match.group("link"):
            out.append(r"\href{%s}{%s}" % (_escape_url(match.group("url")), _span(match.group("linktext"))))
        elif match.group("bold"):
            out.append(r"\textbf{%s}" % _span(match.group("boldtext")))
        elif match.group("italic"):
            out.append(r"\emph{%s}" % _span(match.group("italictext")))
        position = match.end()
    out.append(escape(_typography(text[position:])))
    return "".join(out)


def to_latex(text: object) -> str:
    """Convert a field value to LaTeX. Blank lines become paragraph breaks."""
    if text is None:
        return ""
    value = str(text).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not value:
        return ""
    paragraphs = [re.sub(r"\s*\n\s*", " ", part).strip() for part in re.split(r"\n\s*\n", value)]
    return r"\par ".join(_span(part) for part in paragraphs if part)


def split_facts(value: object) -> List[str]:
    """Split a key-facts line at ``|`` or a middle dot into separate facts."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        parts = [str(item) for item in value]
    else:
        parts = re.split(r"\s*(?:\||\u00b7|\u2022)\s*", str(value))
    return [part.strip() for part in parts if part and part.strip()]


def facts_to_latex(value: object) -> str:
    """Key facts joined by the design's centred dot."""
    return r" \cvDot ".join(to_latex(part) for part in split_facts(value))


def has_placeholder(text: object) -> bool:
    return bool(text) and bool(re.search(r"\[\[\s*TODO", str(text)))


def plain(text: object) -> str:
    """The visible text of a marked-up value, for counting and searching."""
    if text is None:
        return ""
    value = str(text)
    value = re.sub(r"\[\[\s*TODO\s*:?\s*(.*?)\]\]", r"[TODO: \1]", value)
    value = re.sub(r"\[([^\]\n]+)\]\([^)\s]+\)", r"\1", value)
    value = re.sub(r"\*\*(.+?)\*\*", r"\1", value)
    value = re.sub(r"(?<![\w*])\*([^*\n]+?)\*(?![\w*])", r"\1", value)
    value = re.sub(r"`([^`\n]+)`", r"\1", value)
    return value
