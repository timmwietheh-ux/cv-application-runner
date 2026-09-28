/* Run with: node --test Scripts/editor/tests/blue-markup.test.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/js/blue-markup.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const Blue = sandbox.window.BlueMarkup;

const accept = text => Blue.acceptAll(text);
const acceptLine = (text, line) => {
  const lineOf = offset => text.slice(0, offset).split('\n').length;
  return Blue.applyEdits(text, Blue.acceptEdits(text, unit => lineOf(unit.start) === line).edits);
};
const mark = (text, needle, length) => {
  const start = text.indexOf(needle);
  assert.notEqual(start, -1, `fixture lacks ${needle}`);
  return Blue.markRange(text, start, start + (length === undefined ? needle.length : length));
};
const mask = text => text.replace(/\\[{}%$]/g, '').replace(/%.*$/gm, '');
const braceBalance = text => [...mask(text)].reduce((d, c) => d + (c === '{') - (c === '}'), 0);

test('headings lose \\textcolor and keep the title', () => {
  assert.equal(
    accept('\\subsection{\\textcolor{blue}{The exact unstable band}}\n\\label{subsec:x}\n'),
    '\\subsection{The exact unstable band}\n\\label{subsec:x}\n');
});

test('paragraph groups lose braces, colour and the ignored space', () => {
  assert.equal(accept('{\\color{blue} The rate enters here.}\n'), 'The rate enters here.\n');
  assert.equal(accept('{\\color{blue}\\nopagebreak Subsection~\\ref{a} showed.}\n'), '\\nopagebreak Subsection~\\ref{a} showed.\n');
  assert.equal(accept('{\\color{blue}Equation~\\eqref{x} is exact.}'), 'Equation~\\eqref{x} is exact.');
});

test('displays lose only their leading \\color{blue}', () => {
  assert.equal(
    accept('\\begin{equation}\\color{blue}\\label{eq:a}\nx=1 .\n\\end{equation}\n'),
    '\\begin{equation}\\label{eq:a}\nx=1 .\n\\end{equation}\n');
});

test('captions keep their argument braces', () => {
  const caption = '\\caption{{\\color{blue}\\textbf{Spectrum.}\n(a) Rates.\nConstruction: Appendix~\\ref{app:x}.}}\n';
  assert.equal(accept(caption), '\\caption{\\textbf{Spectrum.}\n(a) Rates.\nConstruction: Appendix~\\ref{app:x}.}\n');
});

test('a group after ^{...} in math is a plain group', () => {
  assert.equal(accept('\\to\\Gamma_{\\kc}^{+}{\\color{blue},}\n'), '\\to\\Gamma_{\\kc}^{+},\n');
});

test('argument braces stay, only the colour goes', () => {
  assert.equal(accept('\\textbf{\\color{blue}bold}'), '\\textbf{bold}');
  assert.equal(accept('x^{\\color{blue}23}'), 'x^{23}');
  assert.equal(accept('\\frac{a}{\\color{blue}b}'), '\\frac{a}{b}');
});

test('scoped declarations keep their group', () => {
  assert.equal(accept('{\\color{blue}\\small tiny text} after'), '{\\small tiny text} after');
  assert.equal(accept('\\textcolor{blue}{\\bfseries x} y'), '{\\bfseries x} y');
});

test('comments, escaped braces, verbatim and other blues are left alone', () => {
  assert.equal(accept('% {\\color{blue} old}\ntext\n'), '% {\\color{blue} old}\ntext\n');
  assert.equal(accept('{\\color{blue} a \\{ b \\} c}'), 'a \\{ b \\} c');
  assert.equal(accept('\\verb|\\color{blue}| and \\textcolor{runnerblue}{x}'), '\\verb|\\color{blue}| and \\textcolor{runnerblue}{x}');
  assert.equal(accept('\\begin{verbatim}\n{\\color{blue} x}\n\\end{verbatim}\n'), '\\begin{verbatim}\n{\\color{blue} x}\n\\end{verbatim}\n');
});

test('lines that held only markup disappear', () => {
  assert.equal(accept('Before.\n\n{\\color{blue}\nNew text.\n}\n\nAfter.\n'), 'Before.\n\nNew text.\n\nAfter.\n');
});

test('removal never glues a control word to a letter', () => {
  assert.equal(accept('{\\color{blue}x\\relax}y'), 'x\\relax y');
  assert.equal(accept('\\bfseries\\color{blue} word'), '\\bfseries word');
});

test('a click accepts its line, nested blue included, and nothing else', () => {
  const text = '{\\color{blue} Outer \\textcolor{blue}{inner} text.}\n\n{\\color{blue} Other.}\n';
  assert.equal(acceptLine(text, 1), 'Outer inner text.\n\n{\\color{blue} Other.}\n');
  assert.equal(acceptLine(text, 3), '{\\color{blue} Outer \\textcolor{blue}{inner} text.}\n\nOther.\n');
});

test('CRLF files keep their line endings', () => {
  assert.equal(accept('A.\r\n\r\n{\\color{blue} B.}\r\n'), 'A.\r\n\r\nB.\r\n');
});

test('marking writes the house forms', () => {
  assert.equal(mark('Old text.\n\nNew paragraph here.\n', 'New paragraph here.'), 'Old text.\n\n{\\color{blue} New paragraph here.}\n');
  assert.equal(mark('\\subsection{A title}\n', 'title', 3), '\\subsection{\\textcolor{blue}{A title}}\n');
  assert.equal(
    mark('Text.\n\\begin{equation}\\label{eq:a}\nx=1 .\n\\end{equation}\n', 'x=1'),
    'Text.\n\\begin{equation}\\color{blue}\\label{eq:a}\nx=1 .\n\\end{equation}\n');
  assert.equal(mark('\\nopagebreak Start here.\n', 'Start', 0), '{\\color{blue}\\nopagebreak Start here.}\n');
});

test('a brace after an argument-free command or a spaced label is a group', () => {
  assert.equal(accept('\\item {\\color{blue}New item.}'), '\\item New item.');
  assert.equal(accept('\\end{equation} {\\color{blue}and text}'), '\\end{equation} and text');
  assert.equal(mark('\\item Words here.', 'Words here.'), '\\item {\\color{blue}Words here.}');
  assert.equal(accept('\\label{sec:a}{\\color{blue}Text}'), '\\label{sec:a}Text');
  assert.equal(accept('\\frac{a}{\\color{blue}b}{c}'), '\\frac{a}{b}{c}');
});

test('labels and page-break hints are not coloured on their own', () => {
  const head = '\\section{Title}\\label{sec:a}\n\\label{app:b}\n\nText.\n';
  assert.equal(Blue.markRange(head, 0, head.length),
    '\\section{\\textcolor{blue}{Title}}\\label{sec:a}\n\\label{app:b}\n\n{\\color{blue} Text.}\n');
});

test('marking a mixed selection colours each block in its own form', () => {
  const text = 'Intro sentence.\n\\begin{equation}\\label{eq:b}\ny=2\n\\end{equation}\nFollow-up words.\n\nNext paragraph.\n';
  assert.equal(Blue.markRange(text, 0, text.length),
    '{\\color{blue} Intro sentence.}\n\\begin{equation}\\color{blue}\\label{eq:b}\ny=2\n\\end{equation}\n' +
    '{\\color{blue} Follow-up words.}\n\n{\\color{blue} Next paragraph.}\n');
});

test('marking inside a paragraph keeps commands, math and groups whole', () => {
  assert.equal(mark('See Eq.~\\eqref{eq:long_name} now.', 'ref{eq:lo'), 'See Eq.~{\\color{blue}\\eqref{eq:long_name}} now.');
  assert.equal(mark('Rate $s=a+b$ grows.', 'a+b'), 'Rate {\\color{blue}$s=a+b$} grows.');
  assert.equal(mark('Word \\textbf{bold part} end.', 'part} end'), 'Word {\\color{blue}\\textbf{bold part} end}.');
  assert.equal(mark('from the damping centre, then', 'amping cent'), 'from the {\\color{blue}damping centre}, then');
});

test('marking a figure colours its caption', () => {
  const figure = '\\begin{figure}[t]\n\\centering\n\\input{Figures/tikz/a}\n\\caption{\\textbf{Title.} Text.}\n\\label{fig:a}\n\\end{figure}\n';
  assert.equal(mark(figure, '\\centering'),
    '\\begin{figure}[t]\n\\centering\n\\input{Figures/tikz/a}\n\\caption{{\\color{blue}\\textbf{Title.} Text.}}\n\\label{fig:a}\n\\end{figure}\n');
  assert.equal(mark(figure, 'Text.'), figure.replace('Text.}', '{\\color{blue}Text.}}'));
});

test('marking an empty selection colours the cursor line', () => {
  const text = 'First.\nSecond line.\n';
  const at = text.indexOf('line');
  assert.equal(Blue.markRange(text, at, at), 'First.\n{\\color{blue} Second line.}\n');
});

test('marking never touches trailing comments or blue text', () => {
  assert.equal(mark('Text here. % note\n', 'Text here. % note'), '{\\color{blue} Text here.} % note\n');
  const blue = '{\\color{blue} Already new.}\n';
  assert.equal(mark(blue, 'Already'), blue);
  assert.match(Blue.markEdits(blue, 0, blue.length).message, /already blue/);
});

test('mark then accept restores the source exactly', () => {
  const text = 'Para one with $x$.\n\n\\section{Head}\n\\begin{align}\na&=b\\\\\nc&=d\n\\end{align}\nTail \\cite{k}.\n';
  const marked = Blue.markRange(text, 0, text.length);
  assert.notEqual(marked, text);
  assert.equal(accept(marked), text);
});

/* The manuscript itself: every blue module accepts cleanly, and every black
   module survives a mark-then-accept round trip byte for byte. */
const sections = path.join(__dirname, '../../../Notes/Sections');
test('manuscript modules', { skip: !fs.existsSync(sections) && 'no Notes/Sections in this project' }, () => {
  let blueFiles = 0, roundTrips = 0;
  for (const name of fs.readdirSync(sections).filter(n => n.endsWith('.tex'))) {
    const text = fs.readFileSync(path.join(sections, name), 'utf8');
    const labels = text.match(/\\label\{[^}]*\}/g) || [];
    const accepted = accept(text);
    assert.doesNotMatch(mask(accepted), /\\(text)?color\{blue\}/, name);
    assert.equal(braceBalance(accepted), braceBalance(text), name);
    assert.deepEqual(accepted.match(/\\label\{[^}]*\}/g) || [], labels, name);
    if (accepted !== text) blueFiles++;
    const marked = Blue.markRange(accepted, 0, accepted.length);
    assert.equal(braceBalance(marked), braceBalance(accepted), name);
    assert.equal(accept(marked), accepted, name);
    roundTrips++;
  }
  assert.ok(blueFiles > 0 && roundTrips > 0);
});
