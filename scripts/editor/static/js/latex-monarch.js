/* ==========================================================================
   latex-monarch.js — LaTeX language definition (Monarch tokenizer),
   Overleaf "Cobalt" theme, and language registration for Monaco.

   Monaco ships no LaTeX grammar, so the full lexical state machine lives here.
   Exposes window.LatexMonarch.register(monaco).
   ========================================================================== */
(function (global) {
  "use strict";

  var LANGUAGE_ID = "latex";
  var THEME_ID = "cobalt-overleaf";

  /* Environments whose bodies are typeset as mathematics. */
  var MATH_ENVS =
    "equation|align|gather|multline|flalign|alignat|eqnarray|displaymath|math|" +
    "IEEEeqnarray|dmath|dgroup";
  /* Math environments that legally nest inside another math environment. */
  var NESTED_MATH_ENVS =
    "split|aligned|alignedat|gathered|cases|dcases|rcases|array|matrix|pmatrix|" +
    "bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix|subequations";
  var VERBATIM_ENVS = "verbatim|Verbatim|lstlisting|minted|alltt|filecontents";

  /* Structural / document-shaping macros. */
  var STRUCTURE_MACROS =
    "documentclass|usepackage|RequirePackage|input|include|includeonly|import|" +
    "subfile|subfileinclude|bibliography|bibliographystyle|addbibresource|" +
    "printbibliography|newcommand|renewcommand|providecommand|DeclareMathOperator|" +
    "DeclareRobustCommand|newenvironment|renewenvironment|newtheorem|declaretheorem|" +
    "part|chapter|section|subsection|subsubsection|paragraph|subparagraph|" +
    "title|subtitle|author|date|thanks|maketitle|tableofcontents|listoffigures|" +
    "listoftables|appendix|frontmatter|mainmatter|backmatter|bibitem|includegraphics|" +
    "usetikzlibrary|graphicspath|setlength|addtolength|newlength|geometry|" +
    "hypersetup|setmainfont|setsansfont|setmonofont|newcolumntype";

  /* Cross-reference and citation macros. */
  var REFERENCE_MACROS =
    "citep|citet|citeauthor|citeyear|citenum|citealp|citealt|citation|cite|" +
    "textcite|parencite|footcite|autocite|fullcite|supercite|nocite|" +
    "label|eqref|pageref|autoref|nameref|crefrange|Crefrange|cref|Cref|ref|" +
    "vref|Vref|hyperref|href|url|acrshort|acrlong|gls";

  function group(alternatives) {
    return "(?:" + alternatives + ")";
  }

  var monarchLanguage = {
    defaultToken: "",
    tokenPostfix: ".tex",
    ignoreCase: false,

    brackets: [
      { open: "{", close: "}", token: "delimiter.curly" },
      { open: "[", close: "]", token: "delimiter.square" },
    ],

    tokenizer: {
      root: [
        /* Escaped specials first: \% \$ \& \# \_ \{ \} \~ \^ and \\ */
        [/\\[%$&#_{}~^]/, "constant.escape"],
        [/\\\\\*?/, "constant.escape"],

        /* Line comments (an escaped \% has already been consumed above). */
        [/%.*$/, "comment"],

        /* Verbatim-like environments swallow everything until their \end. */
        [
          new RegExp("(\\\\begin)(\\{)(" + VERBATIM_ENVS + ")(\\*?)(\\})"),
          [
            "keyword.structure",
            "delimiter.curly",
            "type.identifier",
            "type.identifier",
            { token: "delimiter.curly", next: "@verbatim" },
          ],
        ],

        /* Display / inline mathematics environments. */
        [
          new RegExp("(\\\\begin)(\\{)(" + MATH_ENVS + ")(\\*?)(\\})"),
          [
            "keyword.structure",
            "delimiter.curly",
            "type.identifier",
            "type.identifier",
            { token: "delimiter.curly", next: "@mathEnvironment" },
          ],
        ],

        /* Any other environment. */
        [
          /(\\(?:begin|end))(\s*)(\{)([^}]*)(\})/,
          [
            "keyword.structure",
            "white",
            "delimiter.curly",
            "type.identifier",
            "delimiter.curly",
          ],
        ],

        /* Citations and cross references, together with their key argument. */
        [
          new RegExp(
            "(\\\\" +
              group(REFERENCE_MACROS) +
              "\\*?)((?:\\[[^\\]]*\\])*)(\\{)([^}]*)(\\})"
          ),
          [
            "keyword.reference",
            "attribute.value",
            "delimiter.curly",
            "string.reference",
            "delimiter.curly",
          ],
        ],
        [new RegExp("\\\\" + group(REFERENCE_MACROS) + "\\*?"), "keyword.reference"],

        /* Structural macros. */
        [new RegExp("\\\\" + group(STRUCTURE_MACROS) + "\\*?"), "keyword.structure"],

        /* Mathematics delimiters. */
        [/\$\$/, { token: "delimiter.math", next: "@displayMathDollar" }],
        [/\\\[/, { token: "delimiter.math", next: "@displayMathBracket" }],
        [/\\\(/, { token: "delimiter.math", next: "@inlineMathParen" }],
        [/\$/, { token: "delimiter.math", next: "@inlineMathDollar" }],

        /* Every remaining control sequence. */
        [/\\[a-zA-Z@]+\*?/, "keyword"],
        [/\\./, "constant.escape"],

        /* Optional arguments and groups. */
        [/\[/, { token: "delimiter.square", next: "@optionalArgument" }],
        [/[{}]/, "delimiter.curly"],
        [/[&~]/, "operator"],

        [/[ \t\r\n]+/, "white"],
        [/[^\\%${}[\]&~]+/, ""],
      ],

      /* ---- Optional argument [ ... ] ------------------------------------ */
      optionalArgument: [
        [/\]/, { token: "delimiter.square", next: "@pop" }],
        [/%.*$/, "comment"],
        [/\\[a-zA-Z@]+\*?/, "keyword"],
        [/[{}]/, "delimiter.curly"],
        [/[^\]\\{}%]+/, "attribute.value"],
        [/./, "attribute.value"],
      ],

      /* ---- Verbatim ------------------------------------------------------ */
      verbatim: [
        [
          new RegExp("(\\\\end)(\\{)(" + VERBATIM_ENVS + ")(\\*?)(\\})"),
          [
            "keyword.structure",
            "delimiter.curly",
            "type.identifier",
            "type.identifier",
            { token: "delimiter.curly", next: "@pop" },
          ],
        ],
        [/[^\\]+/, "string.verbatim"],
        [/./, "string.verbatim"],
      ],

      /* ---- Mathematics --------------------------------------------------- */
      inlineMathDollar: [
        [/\$/, { token: "delimiter.math", next: "@pop" }],
        { include: "@mathContent" },
      ],
      displayMathDollar: [
        [/\$\$/, { token: "delimiter.math", next: "@pop" }],
        { include: "@mathContent" },
      ],
      displayMathBracket: [
        [/\\\]/, { token: "delimiter.math", next: "@pop" }],
        { include: "@mathContent" },
      ],
      inlineMathParen: [
        [/\\\)/, { token: "delimiter.math", next: "@pop" }],
        { include: "@mathContent" },
      ],
      mathEnvironment: [
        [
          new RegExp(
            "(\\\\end)(\\{)(" + MATH_ENVS + "|" + NESTED_MATH_ENVS + ")(\\*?)(\\})"
          ),
          [
            "keyword.structure",
            "delimiter.curly",
            "type.identifier",
            "type.identifier",
            { token: "delimiter.curly", next: "@pop" },
          ],
        ],
        [
          new RegExp("(\\\\begin)(\\{)(" + NESTED_MATH_ENVS + ")(\\*?)(\\})"),
          [
            "keyword.structure",
            "delimiter.curly",
            "type.identifier",
            "type.identifier",
            { token: "delimiter.curly", next: "@mathEnvironment" },
          ],
        ],
        { include: "@mathContent" },
      ],

      /* Shared body of every mathematics state. */
      mathContent: [
        [/\\[%$&#_{}~^]/, "constant.escape"],
        [/\\\\\*?/, "constant.escape"],
        [/%.*$/, "comment"],
        [
          new RegExp(
            "(\\\\" +
              group("label|tag|eqref|ref|cref|Cref|text|textrm|mbox|intertext") +
              "\\*?)(\\{)([^}]*)(\\})"
          ),
          ["keyword.reference", "delimiter.curly", "string.reference", "delimiter.curly"],
        ],
        [/\\[a-zA-Z@]+\*?/, "keyword.math"],
        [/\\./, "constant.escape"],
        [/[{}]/, "delimiter.curly"],
        [/[[\]]/, "delimiter.square"],
        [/\d+(?:\.\d+)?/, "number"],
        [/[+\-*/=<>!,;:'|&^_]/, "operator.math"],
        [/[ \t\r\n]+/, "white"],
        [/[^\\%${}[\]0-9+\-*/=<>!,;:'|&^_ \t\r\n]+/, "string.math"],
      ],
    },
  };

  /* ---------------------------------------------------------------------
     BibTeX. Monaco ships no grammar for it either, and references.bib is a
     first-class file in this repository.
     --------------------------------------------------------------------- */
  var bibtexLanguage = {
    defaultToken: "",
    tokenPostfix: ".bib",
    tokenizer: {
      root: [
        [/%.*$/, "comment"],
        [
          /(@)(string|preamble|comment)(\s*)([{(])/i,
          ["keyword.structure", "keyword.structure", "white", "delimiter.curly"],
        ],
        [
          /(@)([a-zA-Z]+)(\s*)([{(])(\s*)([^,\s{}]+)/,
          [
            "keyword.structure",
            "type.identifier",
            "white",
            "delimiter.curly",
            "white",
            "string.reference",
          ],
        ],
        [/([a-zA-Z][\w-]*)(\s*)(=)/, ["attribute.name", "white", "operator"]],
        [/"/, { token: "string", next: "@quoted" }],
        [/\{/, { token: "delimiter.curly", next: "@braced" }],
        [/[})\]]/, "delimiter.curly"],
        [/\d+/, "number"],
        [/[,#]/, "delimiter"],
      ],
      quoted: [
        [/\\./, "string.escape"],
        [/[^"\\]+/, "string"],
        [/"/, { token: "string", next: "@pop" }],
      ],
      braced: [
        [/\\[a-zA-Z]+/, "keyword"],
        [/\{/, { token: "delimiter.curly", next: "@braced" }],
        [/\}/, { token: "delimiter.curly", next: "@pop" }],
        [/[^{}\\]+/, "string"],
      ],
    },
  };

  /* Editor-side language configuration: brackets, comments, auto-closing. */
  var languageConfiguration = {
    comments: { lineComment: "%" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "$", close: "$" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "$", close: "$" },
    ],
    folding: {
      markers: {
        start: /^\s*%\s*#?region\b|^\s*\\begin\{/,
        end: /^\s*%\s*#?endregion\b|^\s*\\end\{/,
      },
    },
    indentationRules: {
      increaseIndentPattern: /^\s*\\begin\{(?!document)[^}]*\}\s*$/,
      decreaseIndentPattern: /^\s*\\end\{[^}]*\}\s*$/,
    },
  };

  /* --------------------------------------------------------------------- */
  /* Overleaf Cobalt theme. Token rules cover LaTeX plus the polyglot set   */
  /* (Python, Julia, Markdown, shell, C/C++, JSON, ...).                    */
  /* --------------------------------------------------------------------- */
  var cobaltTheme = {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "e8f2ff" },

      /* LaTeX */
      { token: "comment", foreground: "7090b0", fontStyle: "italic" },
      { token: "keyword", foreground: "ffee80" },
      { token: "keyword.structure", foreground: "ff9d00", fontStyle: "bold" },
      { token: "keyword.reference", foreground: "ff628c" },
      { token: "string.reference", foreground: "ff80e1" },
      { token: "type.identifier", foreground: "ffc600" },
      { token: "delimiter.curly", foreground: "0088ff" },
      { token: "delimiter.square", foreground: "80c0ff" },
      { token: "delimiter.math", foreground: "ff9d00", fontStyle: "bold" },
      { token: "keyword.math", foreground: "3ad900" },
      { token: "string.math", foreground: "9effff" },
      { token: "operator.math", foreground: "ff9d00" },
      { token: "constant.escape", foreground: "ffc600" },
      { token: "attribute.value", foreground: "80c0ff" },
      { token: "string.verbatim", foreground: "aab8c8" },

      /* Shared / other languages */
      { token: "string", foreground: "3ad900" },
      { token: "string.escape", foreground: "ffc600" },
      { token: "number", foreground: "ff628c" },
      { token: "regexp", foreground: "80ffc2" },
      { token: "operator", foreground: "ff9d00" },
      { token: "delimiter", foreground: "b8d4f0" },
      { token: "namespace", foreground: "80c0ff" },
      { token: "type", foreground: "80ffbb" },
      { token: "struct", foreground: "80ffbb" },
      { token: "class", foreground: "80ffbb" },
      { token: "function", foreground: "ffdd00" },
      { token: "variable", foreground: "ccffff" },
      { token: "variable.predefined", foreground: "ff80e1" },
      { token: "constant", foreground: "ff628c" },
      { token: "identifier", foreground: "e8f2ff" },
      { token: "tag", foreground: "9effff" },
      { token: "attribute.name", foreground: "ff9d00" },
      { token: "metatag", foreground: "ff628c" },
      { token: "annotation", foreground: "ffc600" },
      { token: "key", foreground: "ffee80" },
      { token: "predefined", foreground: "ff80e1" },
      { token: "invalid", foreground: "ff4d6d" },
    ],
    colors: {
      "editor.background": "#002240",
      "editor.foreground": "#e8f2ff",
      "editorLineNumber.foreground": "#3f6c9e",
      "editorLineNumber.activeForeground": "#ffc600",
      "editorCursor.foreground": "#ffc600",
      "editor.lineHighlightBackground": "#00325c66",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#0d4a8a",
      "editor.inactiveSelectionBackground": "#0d4a8a80",
      "editor.selectionHighlightBackground": "#0d4a8a66",
      "editor.wordHighlightBackground": "#0d4a8a66",
      "editor.wordHighlightStrongBackground": "#1f6fbf66",
      "editor.findMatchBackground": "#ff9d0066",
      "editor.findMatchHighlightBackground": "#ff9d0033",
      "editorWhitespace.foreground": "#0d3866",
      "editorIndentGuide.background": "#00335e",
      "editorIndentGuide.activeBackground": "#0088ff",
      "editorBracketMatch.background": "#0088ff33",
      "editorBracketMatch.border": "#0088ff",
      "editorGutter.background": "#002240",
      "editorGutter.modifiedBackground": "#ff9d00",
      "editorGutter.addedBackground": "#3ad900",
      "editorGutter.deletedBackground": "#ff4d6d",
      "editorOverviewRuler.border": "#00000000",
      "editorWidget.background": "#001b33",
      "editorWidget.border": "#0d3866",
      "editorSuggestWidget.background": "#001b33",
      "editorSuggestWidget.border": "#0d3866",
      "editorSuggestWidget.selectedBackground": "#0d4a8a",
      "editorSuggestWidget.highlightForeground": "#ffc600",
      "editorHoverWidget.background": "#001b33",
      "editorHoverWidget.border": "#0d3866",
      "editorError.foreground": "#ff4d6d",
      "editorWarning.foreground": "#ff9d00",
      "editorInfo.foreground": "#38bdf8",
      "scrollbarSlider.background": "#0d386688",
      "scrollbarSlider.hoverBackground": "#1f6fbfaa",
      "scrollbarSlider.activeBackground": "#0088ffaa",
      "minimap.background": "#001b33",
      "diffEditor.insertedTextBackground": "#3ad9001f",
      "diffEditor.removedTextBackground": "#ff4d6d1f",
      "diffEditor.border": "#0d3866",
    },
  };

  function register(monaco) {
    if (!monaco || !monaco.languages) return;
    var already = monaco.languages.getLanguages().some(function (l) {
      return l.id === LANGUAGE_ID;
    });
    if (!already) {
      monaco.languages.register({
        id: LANGUAGE_ID,
        extensions: [".tex", ".sty", ".cls", ".ltx", ".bbx", ".cbx", ".def"],
        aliases: ["LaTeX", "latex", "TeX"],
        mimetypes: ["text/x-latex"],
      });
    }
    monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, monarchLanguage);
    monaco.languages.setLanguageConfiguration(LANGUAGE_ID, languageConfiguration);

    var hasBibtex = monaco.languages.getLanguages().some(function (l) {
      return l.id === "bibtex";
    });
    if (!hasBibtex) {
      monaco.languages.register({ id: "bibtex", extensions: [".bib"], aliases: ["BibTeX"] });
    }
    monaco.languages.setMonarchTokensProvider("bibtex", bibtexLanguage);
    monaco.languages.setLanguageConfiguration("bibtex", {
      comments: { lineComment: "%" },
      brackets: [["{", "}"], ["(", ")"]],
      autoClosingPairs: [
        { open: "{", close: "}" },
        { open: "(", close: ")" },
        { open: '"', close: '"' },
      ],
    });

    monaco.editor.defineTheme(THEME_ID, cobaltTheme);
  }

  global.LatexMonarch = {
    LANGUAGE_ID: LANGUAGE_ID,
    THEME_ID: THEME_ID,
    monarchLanguage: monarchLanguage,
    bibtexLanguage: bibtexLanguage,
    languageConfiguration: languageConfiguration,
    cobaltTheme: cobaltTheme,
    register: register,
  };
})(window);
