/* ==========================================================================
   blue-markup.js — review colour for new or revised LaTeX text.

   Agent-written text is coloured blue until the author has read it. The house
   forms are `{\color{blue} …}` for paragraphs and captions, `\color{blue}` as
   the first token of a display, and `\textcolor{blue}{…}` for headings.

   accept: an icon in the glyph margin of every line that opens a blue region
           removes the colour and keeps the text (hover previews the region).
   mark:   "Mark selection blue" (context menu, Ctrl+Alt+B) writes the same
           house forms around the selected paragraphs, displays and headings.

   The text functions are pure and run in Node (tests/blue-markup.test.cjs).
   Every edit is one undo step, so Ctrl+Z restores the previous text.
   ========================================================================== */
(function (root) {
  "use strict";

  var TOKEN_RE = /\\(textcolor|color)[ \t]*\{blue\}/g;
  var HEADING_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|addpart|addchap|addsec|minisec)(?![A-Za-z@])\*?/g;
  var CAPTION_RE = /\\caption(?![A-Za-z@])\*?/g;
  var ITEM_RE = /^\\item(?![A-Za-z@])/;
  var DISPLAY_ENVS = /^(equation|align|alignat|gather|multline|flalign|eqnarray|displaymath|math)\*?$/;
  var FLOAT_ENVS = /^(figure|table|wrapfigure|wraptable|sidewaysfigure|sidewaystable|SCfigure|SCtable)\*?$/;
  var VERBATIM_ENVS = /^(verbatim|Verbatim|BVerbatim|lstlisting|minted|comment)\*?$/;
  /* Declarations whose effect a surrounding group limits. Removing or adding
     braces around them would change the text after the group. */
  var DECLARATIONS = {
    bfseries: 1, mdseries: 1, itshape: 1, slshape: 1, scshape: 1, upshape: 1, em: 1,
    rmfamily: 1, sffamily: 1, ttfamily: 1, normalfont: 1, boldmath: 1, unboldmath: 1,
    tiny: 1, scriptsize: 1, footnotesize: 1, small: 1, normalsize: 1, large: 1, Large: 1,
    LARGE: 1, huge: 1, Huge: 1, color: 1, centering: 1, raggedright: 1, raggedleft: 1,
    selectfont: 1, fontsize: 1, setlength: 1, linespread: 1,
  };
  /* Mandatory brace arguments of common commands. A brace after the last one
     opens a group. Unknown commands are assumed to take one more argument. */
  var ARITY = {
    item: 0, par: 0, noindent: 0, indent: 0, nopagebreak: 0, pagebreak: 0, newline: 0, linebreak: 0,
    smallskip: 0, medskip: 0, bigskip: 0, quad: 0, qquad: 0, ldots: 0, dots: 0, cdots: 0, relax: 0,
    phantomsection: 0, clearpage: 0, newpage: 0, hfill: 0, vfill: 0, centering: 0, displaystyle: 0,
    textstyle: 0, ignorespaces: 0, protect: 0,
    label: 1, ref: 1, eqref: 1, pageref: 1, cref: 1, Cref: 1, autoref: 1, nameref: 1,
    cite: 1, citep: 1, citet: 1, textcite: 1, parencite: 1, footnote: 1, index: 1, url: 1,
    textbf: 1, textit: 1, emph: 1, texttt: 1, textrm: 1, textsf: 1, textsc: 1, textup: 1, underline: 1,
    mathrm: 1, mathbf: 1, mathit: 1, mathcal: 1, mathsf: 1, mathbb: 1, boldsymbol: 1, operatorname: 1,
    text: 1, mbox: 1, hbox: 1, fbox: 1, sqrt: 1, hat: 1, bar: 1, tilde: 1, vec: 1, dot: 1, ddot: 1,
    widehat: 1, widetilde: 1, overline: 1, phantom: 1, hphantom: 1, vphantom: 1,
    part: 1, chapter: 1, section: 1, subsection: 1, subsubsection: 1, paragraph: 1, subparagraph: 1,
    addchap: 1, addsec: 1, caption: 1, begin: 1, end: 1, input: 1, include: 1, includegraphics: 1,
    hspace: 1, vspace: 1, color: 1, ac: 1, acs: 1, acf: 1, acl: 1, acp: 1, si: 1, num: 1,
    frac: 2, tfrac: 2, dfrac: 2, binom: 2, textcolor: 2, colorbox: 2, href: 2, SI: 2, qty: 2,
  };
  /* Commands that print nothing: a block made only of these stays black. */
  var INVISIBLE = {
    label: 1, index: 1, nopagebreak: 1, pagebreak: 1, phantomsection: 1, noindent: 1, par: 1,
    smallskip: 1, medskip: 1, bigskip: 1, vspace: 1, clearpage: 1, newpage: 1, relax: 1,
  };
  var GLYPH_CLASS = "blue-accept-glyph";
  var PREVIEW_CLASS = "blue-scope-preview";

  /* ---------------------------------------------------------------------- */
  /* Lexical analysis                                                        */
  /* ---------------------------------------------------------------------- */

  function isLetter(c) { return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "@"; }
  function isWordChar(c) { return isLetter(c) || (c >= "0" && c <= "9"); }
  function isHSpace(c) { return c === " " || c === "\t"; }
  function isSpace(c) { return c === " " || c === "\t" || c === "\n" || c === "\r"; }

  /* kind[i]: 0 code, 1 comment or verbatim, 2 character escaped by a backslash.
     match[i]: partner of a brace (both directions), -1 if unmatched. */
  function analyse(text) {
    var n = text.length;
    var kind = new Uint8Array(n);
    var i = 0, m;
    while (i < n) {
      var c = text[i];
      if (c === "\\") {
        if (text.startsWith("\\begin", i) && (m = /^\\begin[ \t]*\{([^{}\n]*)\}/.exec(text.slice(i, i + 80))) &&
            VERBATIM_ENVS.test(m[1])) {
          var bodyStart = i + m[0].length;
          var endAt = text.indexOf("\\end{" + m[1] + "}", bodyStart);
          if (endAt < 0) endAt = n;
          for (var k = bodyStart; k < endAt; k++) kind[k] = 1;
          i = endAt;
          continue;
        }
        if (text.startsWith("\\verb", i) && !isLetter(text[i + 5] || "")) {
          var at = i + 5;
          if (text[at] === "*") at++;
          var delim = text[at];
          if (delim && delim !== "\n") {
            var close = text.indexOf(delim, at + 1);
            var stop = text.indexOf("\n", at + 1);
            if (close >= 0 && (stop < 0 || close < stop)) {
              for (var v = at; v <= close; v++) kind[v] = 1;
              i = close + 1;
              continue;
            }
          }
        }
        if (i + 1 < n) kind[i + 1] = 2;
        i += 2;
        continue;
      }
      if (c === "%") {
        while (i < n && text[i] !== "\n") kind[i++] = 1;
        continue;
      }
      i++;
    }

    var match = new Int32Array(n).fill(-1);
    var stack = [];
    for (i = 0; i < n; i++) {
      if (kind[i] !== 0) continue;
      if (text[i] === "{") stack.push(i);
      else if (text[i] === "}" && stack.length) {
        var open = stack.pop();
        match[open] = i;
        match[i] = open;
      }
    }

    var L = { text: text, n: n, kind: kind, match: match };
    L.envs = findEnvironments(L);
    L.envByBegin = Object.create(null);
    L.envs.forEach(function (env) { L.envByBegin[env.begin] = env; });
    L.headings = findCommands(L, HEADING_RE);
    L.captions = findCommands(L, CAPTION_RE);
    L.displays = findBracketDisplays(L);
    L.inlineMath = findInlineMath(L);
    return L;
  }

  function findEnvironments(L) {
    var text = L.text, envs = [], stack = [];
    var re = /\\(begin|end)[ \t]*\{([^{}\n]*)\}/g, m;
    while ((m = re.exec(text))) {
      if (L.kind[m.index] !== 0) continue;
      if (m[1] === "begin") {
        stack.push({ name: m[2], begin: m.index, beginEnd: m.index + m[0].length });
      } else {
        for (var s = stack.length - 1; s >= 0; s--) {
          if (stack[s].name !== m[2]) continue;
          var env = stack[s];
          stack.length = s;
          env.endStart = m.index;
          env.end = m.index + m[0].length;
          envs.push(env);
          break;
        }
      }
    }
    envs.sort(function (a, b) { return a.begin - b.begin; });
    return envs;
  }

  /* A command with an optional [...] and a mandatory {...} argument. */
  function findCommands(L, pattern) {
    var text = L.text, out = [], m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(text))) {
      if (L.kind[m.index] !== 0) continue;
      var p = skipHSpace(text, m.index + m[0].length);
      if (text[p] === "[") {
        var bracket = matchBracketForward(L, p);
        if (bracket < 0) continue;
        p = skipHSpace(text, bracket + 1);
      }
      if (text[p] !== "{" || L.kind[p] !== 0 || L.match[p] < 0) continue;
      out.push({ start: m.index, argOpen: p, argClose: L.match[p], end: L.match[p] + 1 });
    }
    return out;
  }

  function findBracketDisplays(L) {
    var text = L.text, out = [], open = -1;
    for (var i = 0; i + 1 < L.n; i++) {
      if (text[i] !== "\\" || L.kind[i] !== 0) continue;
      if (text[i + 1] === "[" && open < 0) open = i;
      else if (text[i + 1] === "]" && open >= 0) {
        out.push({ begin: open, beginEnd: open + 2, endStart: i, end: i + 2 });
        open = -1;
      }
      i++;
    }
    return out;
  }

  /* $…$, $$…$$ and \(…\); an unclosed dollar ends at the paragraph break. */
  function findInlineMath(L) {
    var text = L.text, out = [], open = -1, double = false;
    for (var i = 0; i < L.n; i++) {
      if (L.kind[i] !== 0) continue;
      var c = text[i];
      if (c === "\n" && open >= 0 && /^\n[ \t\r]*\n/.test(text.slice(i, i + 40))) { open = -1; continue; }
      if (c === "\\" && (text[i + 1] === "(" || text[i + 1] === ")")) {
        if (text[i + 1] === "(" && open < 0) { open = i; double = false; }
        else if (text[i + 1] === ")" && open >= 0) { out.push({ begin: open, end: i + 2 }); open = -1; }
        i++;
        continue;
      }
      if (c !== "$") continue;
      var isDouble = text[i + 1] === "$";
      if (open < 0) { open = i; double = isDouble; if (isDouble) i++; }
      else if (double === isDouble) {
        out.push({ begin: open, end: i + (isDouble ? 2 : 1) });
        open = -1;
        if (isDouble) i++;
      }
    }
    return out;
  }

  function skipHSpace(text, p) {
    while (p < text.length && isHSpace(text[p])) p++;
    return p;
  }

  function skipBackHSpace(text, p) {
    var k = p - 1;
    while (k >= 0 && isHSpace(text[k])) k--;
    return k;
  }

  function matchBracketForward(L, p) {
    for (var i = p + 1; i < L.n && i < p + 400; i++) {
      if (L.kind[i] !== 0) continue;
      if (L.text[i] === "{" && L.match[i] > i) { i = L.match[i]; continue; }
      if (L.text[i] === "]") return i;
      if (L.text[i] === "\n" && L.text[i + 1] === "\n") return -1;
    }
    return -1;
  }

  function matchBracketBack(L, p) {
    for (var i = p - 1; i >= 0 && i > p - 400; i--) {
      if (L.kind[i] !== 0) continue;
      if (L.text[i] === "}" && L.match[i] >= 0 && L.match[i] < i) { i = L.match[i]; continue; }
      if (L.text[i] === "[") return i;
      if (L.text[i] === "\n" && L.text[i - 1] === "\n") return -1;
    }
    return -1;
  }

  /* Index of the backslash when position i ends a control word, else -1. */
  function controlWordStart(L, i) {
    var k = i;
    if (L.text[k] === "*") k--;
    var last = k;
    /* The first letter after the backslash carries kind 2 (see analyse). */
    while (k >= 0 && isLetter(L.text[k]) && L.kind[k] !== 1) k--;
    if (k < last && k >= 0 && L.text[k] === "\\" && L.kind[k] === 0) return k;
    return -1;
  }

  function commandName(L, i) {
    var backslash = controlWordStart(L, i);
    return backslash < 0 ? null : L.text.slice(backslash + 1, i + 1).replace(/\*$/, "");
  }

  /* True when the brace at b is an argument (of \cmd, ^ or _), not a group.
     `\label{x}{…}` has used its one argument, so the second brace is a group. */
  function isArgumentBrace(L, b) {
    var text = L.text;
    var i = skipBackHSpace(text, b);
    if (i < 0) return false;
    var spaced = i < b - 1, groups = 0;
    var c = text[i];
    if (c === "^" || c === "_") return L.kind[i] === 0;
    for (var guard = 0; guard < 12; guard++) {
      if (isLetter(c) || c === "*") {
        var name = commandName(L, i);
        if (name === null) return false;
        if (ARITY[name] !== undefined) return groups < ARITY[name];
        return !(spaced && groups > 0);
      }
      if ((c !== "}" && c !== "]") || L.kind[i] !== 0) return false;
      var open = c === "}" ? L.match[i] : matchBracketBack(L, i);
      if (open < 0 || open > i) return false;
      if (c === "}") groups++;
      i = skipBackHSpace(text, open);
      if (i < 0) return false;
      c = text[i];
      if (c === "^" || c === "_") return false;
    }
    return false;
  }

  /* Does [from, to) print anything, or only labels and page-break hints? */
  function printsSomething(L, from, to) {
    var text = L.text;
    for (var i = from; i < to; i++) {
      if (L.kind[i] === 1 || isSpace(text[i])) continue;
      if (text[i] !== "\\" || !isLetter(text[i + 1] || "")) return true;
      var j = i + 1;
      while (j < to && isLetter(text[j])) j++;
      if (INVISIBLE[text.slice(i + 1, j)] !== 1) return true;
      j = skipHSpace(text, j);
      if (text[j] === "{" && L.match[j] > j) j = L.match[j] + 1;
      i = j - 1;
    }
    return false;
  }

  /* Start of the command whose argument chain contains the brace at b. */
  function commandStart(L, b) {
    var text = L.text, i = skipBackHSpace(text, b), start = b;
    for (var guard = 0; guard < 12 && i >= 0; guard++) {
      var c = text[i];
      if ((c === "^" || c === "_") && L.kind[i] === 0) return i;
      if (isLetter(c) || c === "*") {
        var backslash = controlWordStart(L, i);
        return backslash >= 0 ? backslash : start;
      }
      if ((c === "}" || c === "]") && L.kind[i] === 0) {
        var open = c === "}" ? L.match[i] : matchBracketBack(L, i);
        if (open < 0 || open > i) return start;
        start = open;
        i = skipBackHSpace(text, open);
        continue;
      }
      return start;
    }
    return start;
  }

  /* Does the group content [from, to) set a declaration at its own level? */
  function hasDeclaration(L, from, to) {
    var text = L.text;
    for (var i = from; i < to; i++) {
      if (L.kind[i] !== 0) continue;
      var c = text[i];
      if (c === "{" && L.match[i] > i) { i = L.match[i]; continue; }
      if (c !== "\\" || !isLetter(text[i + 1] || "")) continue;
      var env = L.envByBegin[i];
      if (env && env.end <= to) { i = env.end - 1; continue; }
      var j = i + 1;
      while (j < to && isLetter(text[j])) j++;
      var name = text.slice(i + 1, j);
      if (name === "color" && /^[ \t]*\{blue\}/.test(text.slice(j, j + 12))) { i = j - 1; continue; }
      if (DECLARATIONS[name] === 1) return true;
      i = j - 1;
    }
    return false;
  }

  /* End of the region a bare \color{blue} colours: its group or environment. */
  function bareScopeEnd(L, from) {
    var text = L.text, env = 0;
    for (var i = from; i < L.n; i++) {
      if (L.kind[i] !== 0) continue;
      var c = text[i];
      if (c === "{") { if (L.match[i] > i) i = L.match[i]; continue; }
      if (c === "}") return i;
      if (c !== "\\") continue;
      if (text.startsWith("\\begin", i) && !isLetter(text[i + 6] || "")) env++;
      else if (text.startsWith("\\end", i) && !isLetter(text[i + 4] || "")) {
        if (env === 0) return i;
        env--;
      } else if (env === 0 && (text[i + 1] === "]" || text[i + 1] === ")")) return i;
      i++;
    }
    return L.n;
  }

  /* ---------------------------------------------------------------------- */
  /* Finding blue regions                                                    */
  /* ---------------------------------------------------------------------- */

  function countHSpace(text, p) { return skipHSpace(text, p) - p; }

  function textcolorUnit(L, start, end) {
    var text = L.text;
    var p = skipHSpace(text, end);
    if (text[p] === "\n") p = skipHSpace(text, p + 1);
    if (text[p] !== "{" || L.kind[p] !== 0) return null;
    var close = L.match[p];
    if (close < 0) return null;
    var edits = hasDeclaration(L, p + 1, close)
      ? [[start, p]]
      : [[start, p + 1 + countHSpace(text, p + 1)], [close, close + 1]];
    return { kind: "textcolor", start: start, end: end, scopeStart: start, scopeEnd: close + 1, bounded: true, edits: edits };
  }

  function colorUnit(L, start, end) {
    var text = L.text, ws = countHSpace(text, end), open = start - 1;
    if (open >= 0 && text[open] === "{" && L.kind[open] === 0 && L.match[open] > open && !isArgumentBrace(L, open)) {
      var close = L.match[open];
      var edits = hasDeclaration(L, end, close)
        ? [[start, end + ws]]
        : [[open, end + ws], [close, close + 1]];
      return { kind: "group", start: start, end: end, scopeStart: open, scopeEnd: close + 1, bounded: true, edits: edits };
    }
    var scopeEnd = bareScopeEnd(L, end);
    return {
      kind: "bare", start: start, end: end, scopeStart: start, scopeEnd: scopeEnd,
      bounded: scopeEnd < L.n, edits: [[start, end + ws]],
    };
  }

  function unitsOf(L) {
    var units = [], m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(L.text))) {
      if (L.kind[m.index] !== 0) continue;
      var end = m.index + m[0].length;
      var unit = m[1] === "textcolor" ? textcolorUnit(L, m.index, end) : colorUnit(L, m.index, end);
      if (unit) units.push(unit);
    }
    return units;
  }

  function findUnits(text) { return unitsOf(analyse(text)); }

  /* ---------------------------------------------------------------------- */
  /* Accepting blue: remove the colour, keep the text                        */
  /* ---------------------------------------------------------------------- */

  function mergeIntervals(list) {
    list = list.filter(function (iv) { return iv[1] > iv[0]; })
      .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var out = [];
    list.forEach(function (iv) {
      var last = out[out.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else out.push([iv[0], iv[1]]);
    });
    return out;
  }

  /* A line that only held removed markup disappears with its line break. */
  function dropEmptiedLines(text, intervals) {
    var n = text.length, extra = [], seen = Object.create(null);
    intervals.forEach(function (iv) {
      var ls = text.lastIndexOf("\n", iv[0] - 1) + 1;
      while (ls <= iv[1] && ls < n) {
        var le = text.indexOf("\n", ls);
        if (le < 0) le = n;
        if (!seen[ls]) {
          seen[ls] = true;
          var hadText = false, keepsText = false, k = 0;
          for (var i = ls; i < le; i++) {
            if (isSpace(text[i])) continue;
            hadText = true;
            while (k < intervals.length && intervals[k][1] <= i) k++;
            var covered = k < intervals.length && intervals[k][0] <= i && i < intervals[k][1];
            if (!covered) { keepsText = true; break; }
          }
          if (hadText && !keepsText) extra.push(le < n ? [ls, le + 1] : [Math.max(0, ls - 1), le]);
        }
        ls = le + 1;
      }
    });
    return extra.length ? mergeIntervals(intervals.concat(extra)) : intervals;
  }

  /* Deleting between `\cmd` and a letter would glue them into a new name. */
  function toEdits(L, intervals) {
    return intervals.map(function (iv) {
      var before = iv[0] - 1, after = L.text[iv[1]] || "";
      var glue = before >= 0 && isLetter(L.text[before]) && isLetter(after) && controlWordStart(L, before) >= 0;
      return { start: iv[0], end: iv[1], text: glue ? " " : "" };
    });
  }

  function acceptEditsFor(L, units, chosen) {
    var intervals = [];
    units.forEach(function (unit) {
      var inside = chosen.some(function (c) {
        return c === unit || (c.bounded && c.scopeStart <= unit.start && unit.start < c.scopeEnd);
      });
      if (inside) unit.edits.forEach(function (ed) { intervals.push([ed[0], ed[1]]); });
    });
    return toEdits(L, dropEmptiedLines(L.text, mergeIntervals(intervals)));
  }

  /* select(unit, index) chooses the regions to accept; default: all. */
  function acceptEdits(text, select) {
    var L = analyse(text), units = unitsOf(L);
    var chosen = select ? units.filter(select) : units;
    return { edits: chosen.length ? acceptEditsFor(L, units, chosen) : [], count: chosen.length };
  }

  /* ---------------------------------------------------------------------- */
  /* Marking a selection blue                                                */
  /* ---------------------------------------------------------------------- */

  function envAt(L, s, e) {
    return L.envs.filter(function (env) {
      return (env.begin < s && s < env.end) || (env.begin < e && e < env.end);
    });
  }

  function strictlyInside(span, p) { return span.begin < p && p < span.end; }

  function inCaption(L, s, e) {
    return L.captions.some(function (cap) { return cap.argOpen < s && e <= cap.argClose; });
  }

  /* Grow [s, e) until it cuts no command, group, math span or environment. */
  function expandSelection(L, s, e) {
    var text = L.text;
    for (var round = 0; round < 40; round++) {
      var s0 = s, e0 = e;
      var captionOnly = inCaption(L, s, e);
      envAt(L, s, e).forEach(function (env) {
        if (VERBATIM_ENVS.test(env.name) || env.name === "document") return;
        var hasS = env.begin < s && s < env.end, hasE = env.begin < e && e < env.end;
        var partial = hasS !== hasE;
        if (DISPLAY_ENVS.test(env.name) || partial || (FLOAT_ENVS.test(env.name) && !captionOnly)) {
          s = Math.min(s, env.begin);
          e = Math.max(e, env.end);
        }
      });
      L.displays.concat(L.inlineMath).forEach(function (span) {
        if (strictlyInside(span, s) || strictlyInside(span, e)) {
          s = Math.min(s, span.begin);
          e = Math.max(e, span.end);
        }
      });
      L.headings.forEach(function (cmd) {
        var span = { begin: cmd.start, end: cmd.end };
        if (strictlyInside(span, s) || strictlyInside(span, e)) {
          s = Math.min(s, cmd.start);
          e = Math.max(e, cmd.end);
        }
      });
      if (!captionOnly) {
        L.captions.forEach(function (cmd) {
          var span = { begin: cmd.start, end: cmd.argOpen + 1 };
          if (strictlyInside(span, s) || strictlyInside(span, e) || (cmd.argOpen < s && s <= cmd.argClose && e > cmd.argClose)) {
            s = Math.min(s, cmd.start);
            e = Math.max(e, cmd.end);
          }
        });
      }
      /* Never split a control word. */
      if (s > 0 && text[s - 1] === "\\" && L.kind[s - 1] === 0) s--;
      if (e > 0 && e < L.n && text[e - 1] === "\\" && L.kind[e - 1] === 0) e++;
      if (s > 0 && isLetter(text[s]) && isLetter(text[s - 1])) {
        var cw = controlWordStart(L, s - 1);
        if (cw >= 0) s = cw;
      }
      if (e > 0 && e < L.n && isLetter(text[e]) && isLetter(text[e - 1]) && controlWordStart(L, e - 1) >= 0) {
        while (e < L.n && isLetter(text[e])) e++;
      }
      /* Snap a selection that ends inside a word to the whole word. */
      while (s > 0 && isWordChar(text[s - 1]) && isWordChar(text[s]) && L.kind[s - 1] !== 1) s--;
      if (s > 0 && text[s - 1] === "\\" && L.kind[s - 1] === 0) s--;
      while (e > 0 && e < L.n && isWordChar(text[e - 1]) && isWordChar(text[e]) && L.kind[e] !== 1) e++;
      /* Include the command that owns a leading argument. */
      if ((text[s] === "{" && L.kind[s] === 0 && isArgumentBrace(L, s)) ||
          (text[s] === "[" && L.kind[s] === 0 && controlWordStart(L, skipBackHSpace(text, s)) >= 0)) {
        s = commandStart(L, s);
      }
      /* Include the arguments of a trailing command. */
      var k = skipHSpace(text, e);
      if (k < L.n && L.kind[k] === 0 && e > s) {
        if (text[k] === "{" && L.match[k] > k && isArgumentBrace(L, k)) e = L.match[k] + 1;
        else if (text[k] === "[" && controlWordStart(L, skipBackHSpace(text, k)) >= 0) {
          var rb = matchBracketForward(L, k);
          if (rb > 0) e = rb + 1;
        }
      }
      /* Balance braces. */
      for (var i = s; i < e; i++) {
        if (L.kind[i] !== 0) continue;
        if (text[i] === "{" && L.match[i] >= e) { e = L.match[i] + 1; break; }
        if (text[i] === "{" && L.match[i] > i) { i = L.match[i]; continue; }
        if (text[i] === "}" && L.match[i] >= 0 && L.match[i] < s) { s = commandStart(L, L.match[i]); break; }
      }
      if (s === s0 && e === e0) break;
    }
    return [s, e];
  }

  /* Trim whitespace and comments at both ends of [s, e). */
  function trimRange(L, s, e) {
    var text = L.text;
    for (;;) {
      while (s < e && isSpace(text[s])) s++;
      if (s < e && L.kind[s] === 1) {
        while (s < e && text[s] !== "\n") s++;
        continue;
      }
      break;
    }
    for (;;) {
      while (e > s && isSpace(text[e - 1])) e--;
      if (e > s && L.kind[e - 1] === 1) {
        var ls = text.lastIndexOf("\n", e - 1) + 1;
        var pct = ls;
        while (pct < e && !(text[pct] === "%" && L.kind[pct] === 1)) pct++;
        if (pct < e) { e = pct; continue; }
      }
      break;
    }
    return [s, e];
  }

  function startsBlue(text, p) {
    return /^(\{\\color[ \t]*\{blue\}|\\color[ \t]*\{blue\}|\\textcolor[ \t]*\{blue\})/.test(text.slice(p, p + 24));
  }

  function commandAt(list, p) {
    for (var i = 0; i < list.length; i++) if (list[i].start === p) return list[i];
    return null;
  }

  function envAtBegin(L, p) { return L.envByBegin[p] || null; }

  function isParagraphBreak(text, i) { return text[i] === "\n" && /^\n[ \t\r]*\n/.test(text.slice(i, i + 40)); }

  /* Plan the inserts that colour [selStart, selEnd) in the house forms. */
  function markEdits(text, selStart, selEnd) {
    var L = analyse(text), units = unitsOf(L), inserts = [], skipped = 0, already = 0;
    var s = Math.min(selStart, selEnd), e = Math.max(selStart, selEnd);
    if (s === e) {
      s = text.lastIndexOf("\n", s - 1) + 1;
      e = text.indexOf("\n", e);
      if (e < 0) e = text.length;
    }
    var trimmed = trimRange(L, s, e);
    if (trimmed[0] >= trimmed[1]) return { edits: [], range: null, message: "Nothing to colour in the selection" };
    var range = expandSelection(L, trimmed[0], trimmed[1]);
    s = range[0]; e = range[1];

    function insert(at, str, order) { inserts.push({ at: at, text: str, order: order }); }
    function covered(a, b) { return units.some(function (u) { return u.scopeStart <= a && b <= u.scopeEnd; }); }

    function markDisplay(openEnd, blockStart, blockEnd) {
      if (covered(blockStart, blockEnd) || startsBlue(text, skipHSpace(text, openEnd))) { already++; return; }
      insert(openEnd, "\\color{blue}", 1);
    }
    function markArgument(cmd, form) {
      var inner = skipHSpace(text, cmd.argOpen + 1);
      if (covered(cmd.argOpen, cmd.argClose + 1) || startsBlue(text, inner)) { already++; return; }
      if (inner >= cmd.argClose) return;
      insert(cmd.argOpen + 1, form === "heading" ? "\\textcolor{blue}{" : "{\\color{blue}", 1);
      insert(cmd.argClose, "}", 0);
    }
    function markRun(a, b) {
      var t = trimRange(L, a, b);
      a = t[0]; b = t[1];
      if (a >= b || !printsSomething(L, a, b)) return;
      if (covered(a, b) || startsBlue(text, a)) { already++; return; }
      if (hasDeclaration(L, a, b)) { skipped++; return; }
      /* House form: `{\color{blue} Text` at a line start, tight inside a line. */
      var lineStart = text.lastIndexOf("\n", a - 1) + 1;
      var opensLine = !text.slice(lineStart, a).trim();
      insert(a, "{\\color{blue}" + (opensLine && text[a] !== "\\" ? " " : ""), 1);
      insert(b, "}", 0);
    }

    var p = s;
    while (p < e) {
      while (p < e && (isSpace(text[p]) || L.kind[p] === 1)) p++;
      if (p >= e) break;
      var env = text[p] === "\\" ? envAtBegin(L, p) : null;
      if (env && env.end <= e) {
        if (DISPLAY_ENVS.test(env.name)) {
          var openEnd = env.beginEnd;
          if (/^alignat/.test(env.name)) {
            var argAt = skipHSpace(text, openEnd);
            if (text[argAt] === "{" && L.match[argAt] > argAt) openEnd = L.match[argAt] + 1;
          }
          markDisplay(openEnd, env.begin, env.end);
        } else if (FLOAT_ENVS.test(env.name)) {
          L.captions.forEach(function (cap) {
            if (cap.start > env.begin && cap.end <= env.endStart) markArgument(cap, "caption");
          });
        } else if (!VERBATIM_ENVS.test(env.name)) {
          markRun(env.begin, env.end);
        }
        p = env.end;
        continue;
      }
      var display = null;
      L.displays.forEach(function (d) { if (d.begin === p) display = d; });
      if (display && display.end <= e) {
        markDisplay(display.beginEnd, display.begin, display.end);
        p = display.end;
        continue;
      }
      var heading = commandAt(L.headings, p);
      if (heading && heading.end <= e) { markArgument(heading, "heading"); p = heading.end; continue; }
      var caption = commandAt(L.captions, p);
      if (caption && caption.end <= e) { markArgument(caption, "caption"); p = caption.end; continue; }
      var item = ITEM_RE.exec(text.slice(p, p + 6));
      if (item) {
        p = skipHSpace(text, p + item[0].length);
        if (text[p] === "[") {
          var rb = matchBracketForward(L, p);
          if (rb > 0) p = rb + 1;
        }
        continue;
      }
      /* A run of text: up to a paragraph break, a block, an item or the end. */
      var q = p;
      while (q < e) {
        if (L.kind[q] === 0) {
          var c = text[q];
          if (c === "{" && L.match[q] > q) { q = L.match[q] + 1; continue; }
          if (isParagraphBreak(text, q)) break;
          if (c === "\\" && q > p) {
            var blockEnv = envAtBegin(L, q);
            if ((blockEnv && blockEnv.end <= e) || commandAt(L.headings, q) || commandAt(L.captions, q) ||
                ITEM_RE.test(text.slice(q, q + 6)) ||
                L.displays.some(function (d) { return d.begin === q; })) break;
          }
          if (c === "\\") { q += 2; continue; }
        }
        q++;
      }
      markRun(p, Math.min(q, e));
      p = Math.max(q, p + 1);
    }

    inserts.sort(function (a, b) { return a.at - b.at || a.order - b.order; });
    var edits = [];
    inserts.forEach(function (ins) {
      var last = edits[edits.length - 1];
      if (last && last.start === ins.at) last.text += ins.text;
      else edits.push({ start: ins.at, end: ins.at, text: ins.text });
    });
    var message = "";
    if (!edits.length) message = already ? "The selection is already blue" : "Nothing to colour in the selection";
    else if (skipped) message = skipped + " block(s) left black: they set a font or colour declaration";
    return { edits: edits, range: [s, e], skipped: skipped, already: already, message: message };
  }

  /* ---------------------------------------------------------------------- */
  /* Applying edits to plain text (tests, previews)                          */
  /* ---------------------------------------------------------------------- */

  function applyEdits(text, edits) {
    var out = text;
    edits.slice().sort(function (a, b) { return b.start - a.start; }).forEach(function (ed) {
      out = out.slice(0, ed.start) + ed.text + out.slice(ed.end);
    });
    return out;
  }

  function acceptAll(text) { return applyEdits(text, acceptEdits(text).edits); }

  function markRange(text, s, e) { return applyEdits(text, markEdits(text, s, e).edits); }

  /* ---------------------------------------------------------------------- */
  /* Monaco adapter                                                          */
  /* ---------------------------------------------------------------------- */

  var config = {
    isEnabled: function (model) { return model.getLanguageId() === "latex"; },
    notify: function () {},
    confirm: function (count) { return Promise.resolve(root.confirm ? root.confirm("Remove blue from " + count + " places?") : true); },
  };
  var tracked = typeof WeakMap === "function" ? new WeakMap() : null;

  function enabled(model) {
    try { return !!model && !model.isDisposed() && !!config.isEnabled(model); } catch (error) { return false; }
  }

  function refreshModel(monaco, model) {
    var entry = tracked && tracked.get(model);
    if (!entry || model.isDisposed()) return;
    var units = enabled(model) ? findUnits(model.getValue()) : [];
    var lines = Object.create(null);
    units.forEach(function (unit) { lines[model.getPositionAt(unit.start).lineNumber] = true; });
    entry.lines = lines;
    entry.ids = model.deltaDecorations(entry.ids, Object.keys(lines).map(function (line) {
      return {
        range: new monaco.Range(Number(line), 1, Number(line), 1),
        options: {
          glyphMarginClassName: GLYPH_CLASS,
          glyphMarginHoverMessage: { value: "Remove blue here, keep the text (Ctrl+Z undoes)" },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      };
    }));
  }

  function track(monaco, model) {
    if (!model || !tracked) return;
    if (tracked.has(model)) { refreshModel(monaco, model); return; }
    var entry = { ids: [], lines: Object.create(null), timer: 0, subscriptions: [] };
    tracked.set(model, entry);
    entry.subscriptions.push(model.onDidChangeContent(function () {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(function () { refreshModel(monaco, model); }, 160);
    }));
    entry.subscriptions.push(model.onDidChangeLanguage(function () { refreshModel(monaco, model); }));
    entry.subscriptions.push(model.onWillDispose(function () {
      clearTimeout(entry.timer);
      entry.subscriptions.forEach(function (sub) { sub.dispose(); });
      tracked.delete(model);
    }));
    refreshModel(monaco, model);
  }

  function rangeOf(monaco, model, start, end) {
    var a = model.getPositionAt(start), b = model.getPositionAt(end);
    return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
  }

  function execute(monaco, editor, edits, source) {
    var model = editor.getModel();
    if (!model || !edits.length) return false;
    editor.pushUndoStop();
    editor.executeEdits(source, edits.map(function (ed) {
      return { range: rangeOf(monaco, model, ed.start, ed.end), text: ed.text, forceMoveMarkers: true };
    }));
    editor.pushUndoStop();
    refreshModel(monaco, model);
    return true;
  }

  function attach(monaco, editor, options) {
    options = options || {};
    ["isEnabled", "notify", "confirm"].forEach(function (key) { if (options[key]) config[key] = options[key]; });
    var preview = editor.createDecorationsCollection([]);
    var previewLine = 0;
    var GLYPH_TARGET = monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;

    function lineUnits(model, line) {
      var text = model.getValue();
      return acceptEdits(text, function (unit) { return model.getPositionAt(unit.start).lineNumber === line; });
    }

    function hasGlyph(model, line) {
      var entry = tracked && tracked.get(model);
      return !!(entry && entry.lines[line]);
    }

    function clearPreview() { previewLine = 0; preview.clear(); }

    function acceptLine(line) {
      var model = editor.getModel();
      if (!enabled(model)) return false;
      clearPreview();
      return execute(monaco, editor, lineUnits(model, line).edits, "blue-markup.accept");
    }

    function acceptSelection() {
      var model = editor.getModel();
      if (!enabled(model)) { config.notify("Blue markup is handled in LaTeX files", "warn"); return; }
      var sel = editor.getSelection();
      var s = model.getOffsetAt(sel.getStartPosition()), e = model.getOffsetAt(sel.getEndPosition());
      var result = acceptEdits(model.getValue(), function (unit) {
        return s === e ? unit.scopeStart <= s && s <= unit.scopeEnd : unit.scopeStart < e && s < unit.scopeEnd;
      });
      if (!execute(monaco, editor, result.edits, "blue-markup.accept")) config.notify("No blue text in the selection", "info");
    }

    function acceptFile() {
      var model = editor.getModel();
      if (!enabled(model)) { config.notify("Blue markup is handled in LaTeX files", "warn"); return; }
      var count = findUnits(model.getValue()).length;
      if (!count) { config.notify("No blue text in this file", "info"); return; }
      Promise.resolve(config.confirm(count)).then(function (ok) {
        if (!ok || editor.getModel() !== model) return;
        var result = acceptEdits(model.getValue());
        if (execute(monaco, editor, result.edits, "blue-markup.accept")) {
          config.notify("Removed blue from " + result.count + " places (Ctrl+Z undoes)", "success");
        }
      });
    }

    function markSelection() {
      var model = editor.getModel();
      if (!enabled(model)) { config.notify("Blue markup is handled in LaTeX files", "warn"); return; }
      var sel = editor.getSelection();
      var result = markEdits(model.getValue(), model.getOffsetAt(sel.getStartPosition()), model.getOffsetAt(sel.getEndPosition()));
      if (!execute(monaco, editor, result.edits, "blue-markup.mark")) {
        config.notify(result.message, "info");
        return;
      }
      if (result.skipped) config.notify(result.message, "warn");
    }

    track(monaco, editor.getModel());
    editor.onDidChangeModel(function () { clearPreview(); track(monaco, editor.getModel()); });

    editor.onMouseDown(function (event) {
      var target = event.target;
      if (!target || target.type !== GLYPH_TARGET || !target.position || !event.event.leftButton) return;
      var el = target.element;
      /* Another glyph (a review comment) on the same line keeps its own click. */
      if (el && el.classList && el.classList.contains("cgmr") && !el.classList.contains(GLYPH_CLASS)) return;
      if (!hasGlyph(editor.getModel(), target.position.lineNumber)) return;
      event.event.preventDefault();
      acceptLine(target.position.lineNumber);
    });

    editor.onMouseMove(function (event) {
      var target = event.target, model = editor.getModel();
      var line = target && target.type === GLYPH_TARGET && target.position &&
        hasGlyph(model, target.position.lineNumber) ? target.position.lineNumber : 0;
      if (line === previewLine) return;
      previewLine = line;
      if (!line) { preview.clear(); return; }
      var text = model.getValue();
      var units = findUnits(text).filter(function (unit) { return model.getPositionAt(unit.start).lineNumber === line; });
      preview.set(units.map(function (unit) {
        return { range: rangeOf(monaco, model, unit.scopeStart, unit.scopeEnd), options: { className: PREVIEW_CLASS } };
      }));
    });
    editor.onMouseLeave(clearPreview);

    editor.addAction({
      id: "blue-markup.mark",
      label: "Mark selection blue",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyB],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 3,
      run: markSelection,
    });
    editor.addAction({
      id: "blue-markup.acceptSelection",
      label: "Remove blue from selection",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 4,
      run: acceptSelection,
    });
    editor.addAction({
      id: "blue-markup.acceptFile",
      label: "Remove all blue in this file",
      run: acceptFile,
    });

    return {
      markSelection: markSelection,
      acceptSelection: acceptSelection,
      acceptFile: acceptFile,
      acceptLine: acceptLine,
      refresh: function () { track(monaco, editor.getModel()); },
    };
  }

  root.BlueMarkup = {
    findUnits: findUnits,
    acceptEdits: acceptEdits,
    markEdits: markEdits,
    applyEdits: applyEdits,
    acceptAll: acceptAll,
    markRange: markRange,
    attach: attach,
  };
})(typeof window !== "undefined" ? window : globalThis);
