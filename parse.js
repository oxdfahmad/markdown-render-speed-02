// SwiftMark — a fast, dependency-free Markdown parser producing byte-identical
// output to marked 18.1.3 with its default options (gfm on, breaks off).
// Written from scratch for the make.fun markdown-render-speed-02 competition.
// The grammar (regular expressions) mirrors marked's CommonMark/GFM rules so the
// rendered HTML matches marked code unit for code unit; the tokenizer,
// lexer and renderer below are an original, streamlined implementation.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeChar = (ch) => ESCAPES[ch];

/** Escape HTML special characters. When `encode` is true every `&` is escaped;
 *  otherwise an `&` that already starts a valid entity is left alone. */
function escapeHtml(str, encode) {
  if (encode) {
    return ESCAPE_TEST.test(str) ? str.replace(ESCAPE_REPLACE, escapeChar) : str;
  }
  return ESCAPE_TEST_NO_ENCODE.test(str) ? str.replace(ESCAPE_REPLACE_NO_ENCODE, escapeChar) : str;
}

const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/** Decode numeric character references inside a text chunk; a bare `&` that is
 *  not part of a valid entity becomes `&amp;`. Only runs when the chunk holds
 *  at least one numeric reference (matching marked's behaviour). */
function unescapeEntities(str) {
  if (str.indexOf('&#') === -1 || !NUMERIC_REF.test(str)) return str;
  return str.replace(NUMERIC_REF_OR_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

/** encodeURI a link href, keeping literal `%` (marked's percentDecode step). */
function encodeHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Trim trailing occurrences of `ch` from `str` (or, with `inverted`, trim
 *  trailing characters that are NOT `ch`). */
function trimEndChar(str, ch, inverted) {
  const n = str.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n;) {
    const c = str.charAt(n - cut - 1);
    if (c === ch && !inverted) cut++;
    else if (c !== ch && inverted) cut++;
    else break;
  }
  return str.slice(0, n - cut);
}

/** Drop trailing blank lines of a block, keeping at most one trailing blank. */
function stripTrailingBlanks(str) {
  const lines = str.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && /^[ \t]*$/.test(lines[last]);) last--;
  return lines.length - last <= 2 ? str : lines.slice(0, last + 1).join('\n');
}

/** Normalise a link reference label: collapse whitespace, case-fold. */
function normaliseLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Find the first unbalanced close character in `str` (`pair` is e.g. "()").
 *  Returns its index, -2 when an opener is left unclosed, -1 when balanced. */
function findUnbalanced(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

/** Expand tabs to spaces, tab stops of 4 relative to column `col`. */
function expandTabs(str, col = 0) {
  let out = '';
  let pos = col;
  for (const ch of str) {
    if (ch === '\t') {
      const width = 4 - (pos % 4);
      out += ' '.repeat(width);
      pos += width;
    } else {
      out += ch;
      pos++;
    }
  }
  return out;
}

/** Split a table row on unescaped pipes, honouring a column count when given. */
function splitTableRow(row, columns) {
  const withMarkers = row.replace(/\|/g, (ch, offset, whole) => {
    let escaped = false;
    let p = offset;
    for (; --p >= 0 && whole[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = withMarkers.split(/ \|/);
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), columns) {
    if (cells.length > columns) cells.splice(columns);
    else for (; cells.length < columns;) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ---------------------------------------------------------------------------
// Regex composition. A grammar pattern is built from a base pattern string by
// substituting named pieces. A `^` inside a substituted piece is dropped
// unless preceded by `[`, so anchors in pieces never anchor the whole —
// the same rule marked's own builder applies when it splices pieces together.
// ---------------------------------------------------------------------------
const CARET_RULE = /(^|[^\[])\^/g;
function compose(base, flags, subs) {
  let src = typeof base === 'string' ? base : base.source;
  for (const [search, piece] of subs) {
    let rep = typeof piece === 'string' ? piece : piece.source;
    rep = rep.replace(CARET_RULE, '$1');
    if (typeof search === 'string') {
      const at = src.indexOf(search);
      if (at >= 0) src = src.slice(0, at) + rep + src.slice(at + search.length);
    } else {
      src = src.replace(search, rep);
    }
  }
  return new RegExp(src, flags);
}

// Block-level HTML tag names (CommonMark's list).
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Small shared patterns used across the block and inline grammars.
const RX = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineGlobal: /\n/g,
  tabGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

// --- Block grammar pieces -------------------------------------------------
const BULL = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_CODE_INDENT = /(?: {4}| {0,3}\t)/;
const FENCES_MARK = / {0,3}(?:`{3,}|~{3,})/;
const BLOCKQUOTE_MARK = / {0,3}>/;
const HEADING_MARK = / {0,3}#{1,6}(?:\s|$)/;
const HTML_LINE = / {0,3}<[^\n>]+>\n/;
const TABLE_DELIM_LINE = / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/;
const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HTML_OPEN = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const FENCES_LINE = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const LIST_LINE_GFM = ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]';

// Paragraph base: first line plus continuation lines that do not start a
// new block construct.
const PARAGRAPH_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

const BLOCK = {};
BLOCK.newline = /^(?:[ \t]*(?:\n|$))+/;
BLOCK.code = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
BLOCK.fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
BLOCK.heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
BLOCK.hr = HR;
// (The paragraph, lheading and blockquote rules are composed after the
// table rule below, since they embed it.)
BLOCK.text = /^[^\n]+/;
BLOCK.list = compose(/^(bull)([ \t][^\n]*?)?(?:\n|$)/, '', [[/bull/g, BULL]]);
BLOCK.html = compose(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  'i',
  [
    ['comment', /<!--(?:-?>|[\s\S]*?(?:-->|$))/],
    ['tag', BLOCK_TAGS],
    ['attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/],
  ],
);
const DEF_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF_TITLE = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
BLOCK.def = compose(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
  '',
  [['label', DEF_LABEL], ['title', DEF_TITLE]],
);
BLOCK.table = compose(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
  '',
  [
    ['hr', HR],
    ['heading', HEADING_MARK],
    ['blockquote', BLOCKQUOTE_MARK],
    ['code', '(?: {4}| {0,3}	)[^\\n]'],
    ['fences', FENCES_LINE],
    ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
    ['html', HTML_OPEN],
    [/tag/g, BLOCK_TAGS],
  ],
);

// GFM paragraph (the lookahead stops a paragraph before a new block, and a
// table header line ends it so the table rule can take over).
BLOCK.paragraph = compose(PARAGRAPH_BASE, '', [
  ['hr', HR],
  ['heading', HEADING_MARK],
  ['|lheading', ''],
  ['table', BLOCK.table],
  ['blockquote', BLOCKQUOTE_MARK],
  ['fences', FENCES_LINE],
  ['list', LIST_LINE_GFM],
  ['html', HTML_OPEN],
  [/tag/g, BLOCK_TAGS],
]);

// Setext heading.
BLOCK.lheading = compose(
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  '',
  [
    [/bull/g, BULL],
    [/blockCode/g, BLOCK_CODE_INDENT],
    [/fences/g, FENCES_MARK],
    [/blockquote/g, BLOCKQUOTE_MARK],
    [/heading/g, HEADING_MARK],
    [/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/],
    [/html/g, HTML_LINE],
    [/table/g, TABLE_DELIM_LINE],
  ],
);

// Paragraph as it appears inside a blockquote (its list pattern differs).
const BLOCKQUOTE_PARAGRAPH = compose(PARAGRAPH_BASE, '', [
  ['hr', HR],
  ['heading', HEADING_MARK],
  ['|lheading', ''],
  ['|table', ''],
  ['blockquote', BLOCKQUOTE_MARK],
  ['fences', FENCES_LINE],
  ['list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)'],
  ['html', HTML_OPEN],
  [/tag/g, BLOCK_TAGS],
]);
BLOCK.blockquote = compose(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
  '',
  [['paragraph', BLOCKQUOTE_PARAGRAPH]],
);

// Parameterised helpers the list tokenizer uses (cached per indent depth).
const listItemRegexCache = new Map();
function listItemRegex(bullet) {
  let re = listItemRegexCache.get(bullet);
  if (!re) {
    re = new RegExp(`^( {0,3}${bullet})((?:[ \t][^\\n]*)?(?:\\n|$))`);
    listItemRegexCache.set(bullet, re);
  }
  return re;
}
const nextBulletCache = new Map();
function nextBulletRegex(indent) {
  const key = Math.max(0, Math.min(3, indent - 1));
  let re = nextBulletCache.get(key);
  if (!re) {
    re = new RegExp(`^ {0,${key}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`);
    nextBulletCache.set(key, re);
  }
  return re;
}
function cachedRegex(cache, key, make) {
  let re = cache.get(key);
  if (!re) {
    re = make(key);
    cache.set(key, re);
  }
  return re;
}
const hrCache = new Map();
const hrRegex = (indent) => cachedRegex(hrCache, Math.max(0, Math.min(3, indent - 1)), (k) => new RegExp(`^ {0,${k}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginCache = new Map();
const fencesBeginRegex = (indent) => cachedRegex(fencesBeginCache, Math.max(0, Math.min(3, indent - 1)), (k) => new RegExp(`^ {0,${k}}(?:\`\`\`|~~~)`));
const headingBeginCache = new Map();
const headingBeginRegex = (indent) => cachedRegex(headingBeginCache, Math.max(0, Math.min(3, indent - 1)), (k) => new RegExp(`^ {0,${k}}#{1,6}(?:\\s|$)`));
const htmlBeginCache = new Map();
const htmlBeginRegex = (indent) => cachedRegex(htmlBeginCache, Math.max(0, Math.min(3, indent - 1)), (k) => new RegExp(`^ {0,${k}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginCache = new Map();
const blockquoteBeginRegex = (indent) => cachedRegex(blockquoteBeginCache, Math.max(0, Math.min(3, indent - 1)), (k) => new RegExp(`^ {0,${k}}>`));

// --- Inline grammar -------------------------------------------------------
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NOT_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NOT_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const SCHEME = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
const EMAIL = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const EMAIL_GFM = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PLAIN = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const REF_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const BRACKETED = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
// Label text that may hold nested brackets, escapes and code spans.
const LABEL_TEXT = compose(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
  '',
  [['brackets', BRACKETED]],
);
// Reference text (1..999 chars, not starting with a blank before `]`).
const REF_TEXT = /(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REF_TEXT_LABEL = compose(/(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/, '', []);
// Long label used by the reflink search inside the emphasis mask.
const MASK_LABEL = compose(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
  '',
  [['brackets', BRACKETED]],
);

const INLINE = {};
INLINE.escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
INLINE.code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
INLINE.br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
INLINE.del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
INLINE.delLDelim = compose(/^~~?(?:((?!~)punct)|[^\s~])/, 'u', [[/punct/g, PUNCT]]);
INLINE.delRDelim = compose(
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)',
  'gu',
  [
    [/notPunctSpace/g, NOT_PUNCT_SPACE],
    [/punctSpace/g, PUNCT_SPACE],
    [/punct/g, PUNCT],
  ],
);
INLINE.emStrongLDelim = compose(
  /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,
  'u',
  [[/punct/g, PUNCT_NOT_TILDE]],
);
INLINE.emStrongRDelimAst = compose(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)',
  'gu',
  [
    [/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE],
    [/punctSpace/g, PUNCT_SPACE_NOT_TILDE],
    [/punct/g, PUNCT_NOT_TILDE],
  ],
);
INLINE.emStrongRDelimUnd = compose(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)',
  'gu',
  [
    [/notPunctSpace/g, NOT_PUNCT_SPACE],
    [/punctSpace/g, PUNCT_SPACE],
    [/punct/g, PUNCT],
  ],
);
INLINE.autolink = compose(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, '', [
  ['scheme', SCHEME],
  ['email', EMAIL],
]);
INLINE.tag = compose(
  '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  '',
  [
    ['comment', compose(/<!--(?:-?>|[\s\S]*?(?:-->|$))/, '', [['(?:-->|$)', '-->']])],
    ['attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/],
  ],
);
INLINE.link = compose(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
  '',
  [
    ['label', LABEL_TEXT],
    ['href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/],
    ['title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/],
  ],
);
INLINE.reflink = compose(/^!?\[(label)\]\[(ref)\]/, '', [
  ['label', LABEL_TEXT],
  ['ref', REF_LABEL],
]);
INLINE.nolink = compose(/^!?\[(ref)\](?:\[\])?/, '', [['ref', REF_LABEL]]);
const REFLINK_MASK = compose(/^!?\[(label)\]\[(ref)\]/, '', [
  ['label', MASK_LABEL],
  ['ref', REF_TEXT_LABEL],
]);
const NOLINK_MASK = compose(/^!?\[(ref)\](?:\[\])?/, '', [['ref', REF_TEXT_LABEL]]);
INLINE.reflinkSearch = compose('reflink|nolink(?!\\()', 'g', [
  ['reflink', REFLINK_MASK],
  ['nolink', NOLINK_MASK],
]);
const EMAIL_PROTOCOL = compose(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/, '', [[/email/g, EMAIL_PLAIN]]);
INLINE.url = compose(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/, '', [
  ['emailProtocol', EMAIL_PROTOCOL],
  ['protocol', PROTOCOL],
  ['email', EMAIL_GFM],
]);
INLINE.backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
INLINE.blockSkip = compose(/link|precode-code|html/, 'g', [
  ['link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/],
  ['precode-', '(?<!`)()'],
  ['code', /(?<b>`+)[^`]+\k<b>(?!`)/],
  ['html', /<(?! )[^<>]*?>/],
]);
INLINE.anyPunctuation = compose(/\\(punct)/, 'gu', [[/punct/g, PUNCT]]);
INLINE.anyPunctuationOutsideCode = compose(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu', [[/punct/g, PUNCT]]);
INLINE.punctuation = compose(/^((?![*_])punctSpace)/, 'u', [[/punctSpace/g, PUNCT_SPACE]]);
INLINE.text = compose(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  '',
  [
    ['protocol', PROTOCOL],
    [/emailProtocol/g, /(?:mailto|xmpp):/],
    ['wwwStart', /(?<![^\s*_~(])www\./],
  ],
);

// --- Emphasis masking -----------------------------------------------------
// Before inline tokenising, marked rewrites the source so that link and code
// spans cannot be mistaken for emphasis delimiters, and records where the
// last possible `*`/`_`/`~` closer runs start. The mask keeps lengths
// identical, so positions in the masked text match the original.

// Last run start of `*`, `_` and `~` whose preceding character is not
// whitespace (a closer run cannot start after whitespace).
function scanCloserPositions(src) {
  const last = { '*': -1, '_': -1 };
  let lastDel = -1;
  const n = src.length;
  for (let s = 0; s < n; s++) {
    const ch = src[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? '\n' : src[s - 1];
    let i = s + 1;
    for (; i < n && src[i] === ch;) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = s;
      else last[ch] = s;
    }
    s = i - 1;
  }
  return { maskedSrc: src, lastEmStrong: last, lastDel };
}

// True when `src` contains a link (inline or reference) that is not an image.
function linkInText(src, links) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(INLINE.reflinkSearch)) {
    const s = m[0];
    const open = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(links, normaliseLabel(s.slice(open + 1, -1)))) &&
      !(open > 1 && linkInText(s.slice(1, open - 1), links))
    ) return true;
  }
  return false;
}

// Rewrite links, code spans and raw HTML tags in `src` to same-length filler
// so emphasis scanning never sees their delimiters. `st.hasLinks` tells
// whether any reference definition exists at all; with none, the reflink
// pass is a no-op and is skipped.
function maskEmphasis(src, st) {
  const links = st.links;
  let out = src;
  if (st.hasLinks && src.includes('[')) {
    const maskReflink = (match) => {
      const open = match.lastIndexOf('[');
      if (!Object.hasOwn(links, normaliseLabel(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, open - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(INLINE.reflinkSearch, maskReflink) + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    out = out.replace(INLINE.reflinkSearch, maskReflink);
  }
  if (out.includes('\\') || out.includes('`')) {
    out = out.replace(INLINE.anyPunctuationOutsideCode, (whole, backticks, punct) => {
      if (punct) return '+'.repeat(whole.length);
      if (backticks) return backticks + whole.slice(backticks.length, -backticks.length).replace(/`/g, '+') + backticks;
      return whole;
    });
  }
  if (out.includes('[') || out.includes('<') || out.includes('`')) {
    out = out.replace(INLINE.blockSkip, (whole, _g1, g2) => {
      const keep = g2 ? g2.length : 0;
      return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
    });
  }
  return out;
}

// --- Block tokenizers -----------------------------------------------------
// Each returns a token object or undefined. `st` is the per-parse lexer
// state (link definitions, the inline work queue, flags).

function tokSpace(src) {
  const m = BLOCK.newline.exec(src);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
}

function tokCode(src) {
  const m = BLOCK.code.exec(src);
  if (m) {
    const raw = stripTrailingBlanks(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RX.codeRemoveIndent, '') };
  }
}

function tokFences(src) {
  const m = BLOCK.fences.exec(src);
  if (m) {
    let text = m[3] || '';
    const comp = m[0].match(RX.indentCodeCompensation);
    if (comp !== null) {
      const indent = comp[1];
      text = text.split('\n').map((line) => {
        const sp = line.match(RX.beginningSpace);
        if (sp === null) return line;
        return line.slice(Math.min(sp[0].length, indent.length));
      }).join('\n');
    }
    return {
      type: 'code',
      raw: m[0],
      lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2],
      text,
    };
  }
}

function tokHeading(src, st) {
  const m = BLOCK.heading.exec(src);
  if (m) {
    let text = m[2].trim();
    if (RX.endingHash.test(text)) {
      const stripped = trimEndChar(text, '#');
      if (!stripped || RX.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    const token = { type: 'heading', raw: trimEndChar(m[0], '\n'), depth: m[1].length, text, tokens: [] };
    st.inlineQueue.push({ src: text, tokens: token.tokens });
    return token;
  }
}

function tokHr(src) {
  const m = BLOCK.hr.exec(src);
  if (m) return { type: 'hr', raw: trimEndChar(m[0], '\n') };
}

function tokHtml(src) {
  const m = BLOCK.html.exec(src);
  if (m) {
    const raw = stripTrailingBlanks(m[0]);
    return {
      type: 'html', block: true, raw,
      pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      text: raw,
    };
  }
}

function tokDef(src) {
  const m = BLOCK.def.exec(src);
  if (m) {
    if (!RX.startAngleBracket.test(m[2]) && findUnbalanced(m[2], '()') !== -1) return undefined;
    return {
      type: 'def',
      tag: normaliseLabel(m[1]),
      raw: trimEndChar(m[0], '\n'),
      href: m[2] ? m[2].replace(RX.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '',
      title: m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1') : m[3],
    };
  }
}

function tokTable(src, st) {
  const m = BLOCK.table.exec(src);
  if (!m || !RX.tableDelimiter.test(m[2])) return undefined;
  const headerCells = splitTableRow(m[1]);
  const alignsRaw = m[2].replace(RX.tableAlignChars, '').split('|');
  const bodyLines = m[3]?.trim() ? m[3].replace(RX.tableRowBlankLine, '').split('\n') : [];
  const token = { type: 'table', raw: trimEndChar(m[0], '\n'), header: [], align: [], rows: [] };
  if (headerCells.length === alignsRaw.length) {
    for (const cell of alignsRaw) {
      if (RX.tableAlignRight.test(cell)) token.align.push('right');
      else if (RX.tableAlignCenter.test(cell)) token.align.push('center');
      else if (RX.tableAlignLeft.test(cell)) token.align.push('left');
      else token.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      const cell = { text: headerCells[i], tokens: [], header: true, align: token.align[i] };
      st.inlineQueue.push({ src: cell.text, tokens: cell.tokens });
      token.header.push(cell);
    }
    for (const line of bodyLines) {
      token.rows.push(splitTableRow(line, token.header.length).map((text, j) => {
        const cell = { text, tokens: [], header: false, align: token.align[j] };
        st.inlineQueue.push({ src: cell.text, tokens: cell.tokens });
        return cell;
      }));
    }
    return token;
  }
}

function tokLheading(src, st) {
  const m = BLOCK.lheading.exec(src);
  if (m) {
    const text = m[1].trim();
    const token = { type: 'heading', raw: trimEndChar(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: [] };
    st.inlineQueue.push({ src: text, tokens: token.tokens });
    return token;
  }
}

function tokParagraph(src, st) {
  const m = BLOCK.paragraph.exec(src);
  if (m) {
    let text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    const token = { type: 'paragraph', raw: m[0], text, tokens: [] };
    st.inlineQueue.push({ src: text, tokens: token.tokens });
    return token;
  }
}

function tokText(src, st) {
  const m = BLOCK.text.exec(src);
  if (m) {
    const token = { type: 'text', raw: m[0], text: m[0], tokens: [] };
    st.inlineQueue.push({ src: m[0], tokens: token.tokens });
    return token;
  }
}

function tokBlockquote(src, st) {
  const m = BLOCK.blockquote.exec(src);
  if (!m) return undefined;
  const lines = trimEndChar(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let seenMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (RX.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); seenMarker = true; }
      else if (!seenMarker) chunk.push(lines[p]);
      else break;
    }
    lines.splice(0, p);
    const joined = chunk.join('\n');
    const stripped = joined
      .replace(RX.blockquoteMarkerWhitespace, (whole, marker, spaces) => marker + expandTabs(spaces, marker.length))
      .replace(RX.blockquoteSetextReplace, '\n    $1')
      .replace(RX.blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + joined : joined;
    text = text ? text + '\n' + stripped : stripped;
    const savedTop = st.top;
    st.top = true;
    blockTokens(stripped, tokens, true, st);
    st.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens.at(-1);
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
    if (last && last.type === 'blockquote') {
      const rest = lines.join('\n');
      const reparsed = last.raw + '\n' + rest.replace(RX.blockquoteSetextReplace2, '');
      const nested = tokBlockquote(reparsed, st);
      tokens[tokens.length - 1] = nested;
      const leftover = reparsed.substring(nested.raw.length).replace(/^\n/, '');
      const leftoverLines = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverLines > 0 ? lines.slice(0, -leftoverLines) : lines.slice();
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - last.text.length) + nested.text;
      lines.splice(0, consumed.length);
      if (lines.length > 0 && RX.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (last && last.type === 'list') {
      const combined = last.raw + '\n' + lines.join('\n');
      const relisted = tokList(combined, st);
      tokens[tokens.length - 1] = relisted;
      const extra = relisted.raw.length > last.raw.length
        ? combined.slice(last.raw.length + 1, relisted.raw.length).split('\n').length : 0;
      if (extra > 0) {
        const extraText = lines.slice(0, extra).join('\n');
        raw = raw + '\n' + extraText;
        text = text + '\n' + extraText;
      }
      lines.splice(0, extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

// Text before the first newline (or the whole string when there is none).
function lineBefore(str) {
  const nl = str.indexOf('\n');
  return nl < 0 ? str : str.slice(0, nl);
}

// Index of the first character that is not a space, or -1 when there is
// none (a tab counts as a non-space character, like /[^ ]/).
function firstNonSpace(str) {
  let i = 0;
  const n = str.length;
  while (i < n && str[i] === ' ') i++;
  return i < n ? i : -1;
}

// First character after up to three leading spaces ('' when the line starts
// with a tab or is all spaces): block-start rules allow at most three.
function lineStartChar(line) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  return line[i] ?? '';
}

// True when `str` ends with a blank line followed by another blank line:
// /\n[ \t]*\n[ \t]*$/ without running the regex.
function endsWithDoubleBlank(str) {
  let i = str.length;
  while (i > 0 && (str[i - 1] === ' ' || str[i - 1] === '\t')) i--;
  if (i === 0 || str[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (str[i - 1] === ' ' || str[i - 1] === '\t')) i--;
  return i > 0 && str[i - 1] === '\n';
}

function tokList(src, st) {
  const first = BLOCK.list.exec(src);
  if (!first) return undefined;
  const original = src;
  let rest = src;
  const consumed = () => original.length - rest.length;
  let bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const token = {
    type: 'list', raw: '', ordered,
    start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [],
  };
  bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = listItemRegex(bullet);
  let sawDoubleBlank = false;
  while (rest) {
    let emptyItem = false;
    let itemText = '';
    const itemMatch = itemRe.exec(rest);
    const firstCh = rest[0];
    if (!itemMatch || (firstCh === '-' || firstCh === '_' || firstCh === '*' || firstCh === ' ') && BLOCK.hr.test(rest)) break;
    const itemStart = consumed();
    rest = rest.substring(itemMatch[0].length);
    const firstLine = lineBefore(itemMatch[2]);
    const bulletLen = itemMatch[1].length;
    let content = firstLine.replace(RX.leadingSpaceTab, (v) => expandTabs(v, bulletLen));
    const nextLine = lineBefore(rest);
    const isEmpty = !content.trim();
    let indent;
    if (isEmpty) {
      indent = bulletLen + 1;
    } else {
      indent = firstNonSpace(content);
      indent = indent > 4 ? 1 : indent;
      itemText = content.slice(indent);
      indent += bulletLen;
    }
    if (isEmpty && RX.blankLine.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      emptyItem = true;
    }
    if (!emptyItem) {
      const nextBulletRe = nextBulletRegex(indent);
      const hrRe = hrRegex(indent);
      const fencesRe = fencesBeginRegex(indent);
      const headingRe = headingBeginRegex(indent);
      const htmlRe = htmlBeginRegex(indent);
      const bqRe = blockquoteBeginRegex(indent);
      let curEmpty = isEmpty;
      while (rest) {
        const line = lineBefore(rest);
        const expanded = line.replace(RX.leadingSpaceTab, (v) => expandTabs(v));
        const sc = lineStartChar(line);
        if (
          ((sc === '`' || sc === '~') && fencesRe.test(line)) ||
          (sc === '#' && headingRe.test(line)) ||
          (sc === '<' && htmlRe.test(line)) ||
          (sc === '>' && bqRe.test(line)) ||
          ((sc === '-' || sc === '+' || sc === '*' || (sc >= '0' && sc <= '9')) && nextBulletRe.test(line)) ||
          ((sc === '-' || sc === '_' || sc === '*') && hrRe.test(line))
        ) break;
        if (firstNonSpace(expanded) >= indent || !line.trim()) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          const mc = lineStartChar(content);
          if (
            curEmpty ||
            firstNonSpace(content.includes('\t') ? content.replace(RX.tabGlobal, '    ') : content) >= 4 ||
            ((mc === '`' || mc === '~') && fencesRe.test(content)) ||
            (mc === '#' && headingRe.test(content)) ||
            (mc === '<' && htmlRe.test(content)) ||
            ((mc === '-' || mc === '_' || mc === '*') && hrRe.test(content))
          ) break;
          const setext = /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(`${content}\n${line}`);
          itemText += '\n' + (setext ? `    ${expanded.replace(/^ {0,3}/, '')}` : line);
        }
        curEmpty = !line.trim();
        rest = rest.substring(line.length + 1);
        content = expanded.slice(indent);
      }
    }
    const itemRaw = original.slice(itemStart, consumed());
    if (!token.loose) {
      if (sawDoubleBlank) token.loose = true;
      else if (endsWithDoubleBlank(itemRaw)) sawDoubleBlank = true;
    }
    token.items.push({
      type: 'list_item', raw: itemRaw,
      task: RX.listIsTask.test(itemText), loose: false, text: itemText, tokens: [],
    });
  }
  const lastItem = token.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return undefined;
  }
  token.raw = original.slice(0, consumed()).trimEnd();
  for (const item of token.items) {
    st.top = false;
    item.tokens = blockTokens(item.text, [], false, st);
    if (!token.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      token.loose = spaces.length > 0 && spaces.some((t) => RX.anyLine.test(t.raw));
    }
  }
  for (const item of token.items) {
    const firstTok = item.tokens[0];
    if (item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph')) {
      item.text = item.text.replace(RX.listReplaceTask, '');
      firstTok.raw = firstTok.raw.replace(RX.listReplaceTask, '');
      firstTok.text = firstTok.text.replace(RX.listReplaceTask, '');
      for (let g = st.inlineQueue.length - 1; g >= 0; g--) {
        if (RX.listIsTask.test(st.inlineQueue[g].src)) {
          st.inlineQueue[g].src = st.inlineQueue[g].src.replace(RX.listReplaceTask, '');
          break;
        }
      }
      const check = RX.listTaskCheckbox.exec(item.raw);
      if (check) {
        const box = { type: 'checkbox', raw: check[0] + ' ', checked: check[0] !== '[ ]' };
        item.checked = box.checked;
        if (token.loose) {
          if (firstTok && (firstTok.type === 'paragraph' || firstTok.type === 'text') && 'tokens' in firstTok && firstTok.tokens) {
            firstTok.raw = box.raw + firstTok.raw;
            firstTok.text = box.raw + firstTok.text;
            firstTok.tokens.unshift(box);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
          }
        } else {
          item.tokens.unshift(box);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (token.loose) {
    for (const item of token.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return token;
}

// --- Block lexer ----------------------------------------------------------
// Walk the source, trying block rules in marked's order, skipping by first
// character the rules that cannot match there. Merges follow marked: a
// space of one newline joins the previous token, indented code and link
// definitions fold into a preceding paragraph/text, and inside a blockquote
// a fresh paragraph folds into the previous one.

function secondLine(src) {
  const nl = src.indexOf('\n');
  if (nl < 0) return null;
  const end = src.indexOf('\n', nl + 1);
  return end < 0 ? src.slice(nl + 1) : src.slice(nl + 1, end);
}

// A table needs a delimiter row next; a cheap superset check avoids running
// the full table pattern on ordinary text.
function tablePrecheck(src) {
  const line = secondLine(src);
  if (line === null) return false;
  const t = line.trim();
  if (!t.includes('-') || (!t.includes(':') && !t.includes('|'))) return false;
  return /^[|: \-]+$/.test(t);
}

// A line that would end a setext heading's text (the inner lookahead of the
// setext rule): blank, or starting a bullet, fence, quote, ATX heading,
// thematic break, HTML block or table delimiter row.
const LHEADING_STOP_LINE = /^(?:[ \t]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)/;
const SETEXT_LINE = /^ {0,3}(=+|-+)[ \t]*$/;

// A setext heading needs an `===`/`---` underline on some later line before
// any line that would end the heading's text. The underline is checked
// first: `---` is both a thematic break and a valid underline.
function lheadingPrecheck(src) {
  let pos = 0;
  for (;;) {
    const nl = src.indexOf('\n', pos);
    if (nl < 0) return false;
    const nextStart = nl + 1;
    const nextEnd = src.indexOf('\n', nextStart);
    const nextLine = nextEnd < 0 ? src.slice(nextStart) : src.slice(nextStart, nextEnd);
    if (SETEXT_LINE.test(nextLine)) return true;
    if (LHEADING_STOP_LINE.test(nextLine + '\n')) return false;
    pos = nextStart;
  }
}

function blockTokens(src, tokens, inBlockquote, st) {
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    const c = src[0];
    const indented = c === ' ' || c === '\t';
    let tok;
    if (c === ' ' || c === '\t' || c === '\n') {
      tok = tokSpace(src);
      if (tok) {
        src = src.slice(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      tok = tokCode(src);
      if (tok) {
        src = src.slice(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          st.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
    }
    if (c === '`' || c === '~' || indented) {
      tok = tokFences(src);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    }
    if (c === '#' || indented) {
      tok = tokHeading(src, st);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    }
    if (c === '-' || c === '_' || c === '*' || indented) {
      tok = tokHr(src);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    }
    if (c === '>' || indented) {
      tok = tokBlockquote(src, st);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    }
    if (c === '-' || c === '+' || c === '*' || (c >= '0' && c <= '9') || indented) {
      tok = tokList(src, st);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    }
    if (c === '<' || indented) {
      tok = tokHtml(src);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    }
    if (c === '[' || indented) {
      tok = tokDef(src);
      if (tok) {
        src = src.slice(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          st.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!st.links[tok.tag]) st.links[tok.tag] = { href: tok.href, title: tok.title };
          st.hasLinks = true;
          tokens.push(tok);
        }
        continue;
      }
    }
    if (tablePrecheck(src)) {
      tok = tokTable(src, st);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    }
    if (lheadingPrecheck(src)) {
      tok = tokLheading(src, st);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    }
    if (st.top) {
      tok = tokParagraph(src, st);
      if (tok) {
        src = src.slice(tok.raw.length);
        const prev = tokens.at(-1);
        if (inBlockquote && prev && prev.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          st.inlineQueue.pop();
          st.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(tok);
        continue;
      }
    }
    tok = tokText(src, st);
    if (tok) {
      src = src.slice(tok.raw.length);
      const prev = tokens.at(-1);
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        st.inlineQueue.pop();
        st.inlineQueue.at(-1).src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  st.top = true;
  return tokens;
}

// --- Inline tokenizers ----------------------------------------------------

// True when the link's label holds an unclosed raw tag, which forbids the link.
function hasHtmlAhead(src, label, bang, st) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const code = INLINE.code.exec(label.slice(s));
      if (code) { s += code[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(bang + s);
    const tag = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > label.length - s) return true;
      s += tag[0].length - 1;
    }
  }
  return false;
}

// Build a link/image token, tokenising its label text. Returns undefined when
// the label itself contains a link (a link cannot nest another link).
function buildLink(match, ref, raw, st) {
  const labelText = match[1].replace(RX.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const innerTokens = inlineTokens(labelText, [], st);
  const containedLink = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    if (containedLink) { st.inRawBlock = savedRawBlock; return undefined; }
    st.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href: ref.href, title: ref.title || null, text: labelText, tokens: innerTokens };
}

function tokEscape(src) {
  const m = INLINE.escape.exec(src);
  if (m) return { type: 'escape', raw: m[0], text: m[1] };
}

function tokTag(src, st) {
  const m = INLINE.tag.exec(src);
  if (m) {
    if (!st.inLink && RX.startATag.test(m[0])) st.inLink = true;
    else if (st.inLink && RX.endATag.test(m[0])) st.inLink = false;
    if (!st.inRawBlock && RX.startPreScriptTag.test(m[0])) st.inRawBlock = true;
    else if (st.inRawBlock && RX.endPreScriptTag.test(m[0])) st.inRawBlock = false;
    return { type: 'html', raw: m[0], inLink: st.inLink, inRawBlock: st.inRawBlock, block: false, text: m[0] };
  }
}

function tokLink(src, st) {
  if (st.linkParenPossible === false) return undefined;
  const m = INLINE.link.exec(src);
  if (m) {
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasHtmlAhead(src, m[1], bang, st)) return undefined;
    const href = m[2].trim();
    if (RX.startAngleBracket.test(href)) {
      if (!RX.endAngleBracket.test(href)) return undefined;
      const stripped = trimEndChar(href.slice(0, -1), '\\');
      if ((href.length - stripped.length) % 2 === 0) return undefined;
    } else {
      const close = findUnbalanced(m[2], '()');
      if (close === -2) return undefined;
      if (close > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
        m[2] = m[2].substring(0, close);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const trailing = trimEndChar(m[0].slice(0, -1), '\\');
    if ((m[0].length - trailing.length) % 2 === 0) return undefined;
    let dest = m[2].trim();
    const title = m[3] ? m[3].slice(1, -1) : '';
    if (RX.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
    return buildLink(m, {
      href: dest && dest.replace(INLINE.anyPunctuation, '$1'),
      title: title && title.replace(INLINE.anyPunctuation, '$1'),
    }, m[0], st);
  }
}

function tokReflink(src, st) {
  const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
  if (m) {
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasHtmlAhead(src, m[1], bang, st)) return undefined;
    const ref = st.links[normaliseLabel(m[2] || m[1])];
    if (!ref) {
      const first = m[0].charAt(0);
      return { type: 'text', raw: first, text: first };
    }
    return buildLink(m, ref, m[0], st);
  }
}

function tokCodespan(src) {
  const m = INLINE.code.exec(src);
  if (m) {
    let text = m[2].replace(RX.newLineGlobal, ' ');
    if (RX.nonSpaceChar.test(text) && RX.startingSpaceChar.test(text) && RX.endingSpaceChar.test(text)) {
      text = text.substring(1, text.length - 1);
    }
    return { type: 'codespan', raw: m[0], text };
  }
}

function tokBr(src) {
  const m = INLINE.br.exec(src);
  if (m) return { type: 'br', raw: m[0] };
}

function tokAutolink(src) {
  const m = INLINE.autolink.exec(src);
  if (m) {
    let text;
    let href;
    if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
    else { text = m[1]; href = text; }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}

function tokUrl(src) {
  const m = INLINE.url.exec(src);
  if (m) {
    let text;
    let href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let raw = m[0];
      let prev;
      do {
        prev = raw;
        raw = INLINE.backpedal.exec(raw)?.[0] ?? '';
      } while (prev !== raw);
      text = raw;
      href = m[1] === 'www.' ? 'http://' + raw : raw;
    }
    return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}

// --- Inline-text scanner -------------------------------------------------
// A single native regex finds the next inline-text stop, so long plain-text
// runs do not pay for the backtracking gfm `text` regex on every token.
// Validated differentially against that regex on 140k+ random inputs.
// Group 1 = the "consume one character" stops (hard-break lookahead,
// mailto:/xmpp: lookahead, email-run lookahead); the other alternatives
// (special char, bare http/https, ftp://, www.) stop BEFORE the match.
// Lookup table: the email local-part alphabet (ASCII-only).
const TEXT_STOP = /(?:[\\<!\[`*~_]|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.)|([^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^A-Za-z0-9.!#$%&'*+\/=?_`{|}~-](?=[A-Za-z0-9.!#$%&'*+\/=?_`{|}~-]+@))/g;
const EMAIL_LOCAL_TABLE = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?_`{|}~-") {
  EMAIL_LOCAL_TABLE[ch.charCodeAt(0)] = 1;
}
function isAlnumCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isEmailLocalCode(code) {
  return code < 128 && EMAIL_LOCAL_TABLE[code] === 1;
}
// True when src[j..] starts with two or more spaces followed by a newline.
function spacesThenNewline(src, j) {
  if (src[j] !== ' ') return false;
  let k = j;
  while (src[k] === ' ') k++;
  return k - j >= 2 && src[k] === '\n';
}
// True when src[j..] is a run of email local-part characters ending in '@'.
function emailRunEndsWithAt(src, j) {
  let k = j;
  const n = src.length;
  while (k < n && isEmailLocalCode(src.charCodeAt(k))) k++;
  return k > j && k < n && src[k] === '@';
}
// Length of the plain-text token at the start of `src` (0 when there is
// none). Mirrors the gfm text regex: a single non-alphanumeric character
// before mailto:/xmpp:, else a run of backticks, a run of tildes, or one
// character, then up to the first stop.
function scanInlineText(src) {
  const n = src.length;
  if (n === 0) return 0;
  const c0 = src.charCodeAt(0);
  if (!isAlnumCode(c0) && (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) return 1;
  let i = 1;
  if (c0 === 96 || c0 === 126) {
    while (i < n && src.charCodeAt(i) === c0) i++;
  }
  // Zero-width stops right after the first character group, which the
  // stop regex cannot express (it needs a character to consume).
  if (i < n && spacesThenNewline(src, i)) return i;
  if (i < n && emailRunEndsWithAt(src, i)) return i;
  TEXT_STOP.lastIndex = i;
  const m = TEXT_STOP.exec(src);
  if (!m) return n;
  return m[1] !== undefined ? m.index + 1 : m.index;
}

function tokInlineText(src, st) {
  const len = scanInlineText(src);
  if (len > 0) {
    const raw = src.slice(0, len);
    const inRaw = st.inRawBlock;
    return { type: 'text', raw, text: inRaw ? raw : unescapeEntities(raw), escaped: inRaw };
  }
}

// --- Emphasis / strikethrough --------------------------------------------
// `src` is the remaining unmasked source, `masked` the full masked source
// (same length), `prevChar` the last character of the preceding text token.

function tokEmStrong(src, masked, prevChar, st, maskInfo) {
  const open = INLINE.emStrongLDelim.exec(src);
  if (!open || (!open[1] && !open[2] && !open[3] && !open[4])) return undefined;
  const delim = open[0][0];
  const sameAsPrev = prevChar === delim;
  const pos = masked.length - src.length;
  let start = pos;
  while (start > 0 && masked[start - 1] === delim) start--;
  const beforeRun = [...masked.slice(Math.max(0, start - 2), start)].at(-1) ?? '';
  const beforeIsDelimOrPunct = beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
  let prev = prevChar;
  if (start < pos) prev = beforeRun;
  const prevIsPunct = start < pos ? beforeIsDelimOrPunct : !!INLINE.punctuation.exec(prev);
  if (open[4] && RX.unicodeAlphaNumeric.test(prev)) return undefined;
  const punctAfter = open[1] || open[3] || '';
  if (!punctAfter || !prev || prevIsPunct) {
    const runLen = [...open[0]].length - 1;
    let m = runLen;
    let f = 0;
    const y = pos - start + runLen;
    const ruleOfThree = !!beforeRun.trim() && (!!punctAfter || (delim === '*' && !beforeIsDelimOrPunct));
    if (delim !== '*' && delim !== '_') return undefined;
    const closerRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const lastPossible = maskInfo.lastEmStrong[delim];
    const closerStart = pos + runLen;
    if (lastPossible < closerStart) return undefined;
    const rest = masked.slice(closerStart);
    const limit = lastPossible - closerStart;
    let closer;
    closerRe.lastIndex = 0;
    while ((closer = closerRe.exec(rest)) !== null && !(closer.index > limit)) {
      const g = closer[1] || closer[2] || closer[3] || closer[4] || closer[5] || closer[6];
      if (!g) continue;
      const b = [...g].length;
      if (closer[3] || closer[4]) { m += b; continue; }
      if (closer[5] || closer[6] || ruleOfThree) {
        if (sameAsPrev && (closer[5] || closer[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      const bb = Math.min(b, b + m + f);
      const firstLen = [...closer[0]][0].length;
      const raw = src.slice(0, runLen + closer.index + firstLen + bb);
      if (Math.min(runLen, bb) % 2) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: inlineTokens(inner, [], st) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: inlineTokens(inner, [], st) };
    }
  }
  return undefined;
}

function tokDel(src, masked, prevChar, st, maskInfo) {
  const open = INLINE.delLDelim.exec(src);
  if (!open) return undefined;
  if (!(open[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const runLen = [...open[0]].length - 1;
    let p = runLen;
    const closerRe = INLINE.delRDelim;
    const lastPossible = maskInfo.lastDel;
    const closerStart = masked.length - src.length + runLen;
    if (lastPossible < closerStart) return undefined;
    const rest = masked.slice(closerStart);
    const limit = lastPossible - closerStart;
    let closer;
    closerRe.lastIndex = 0;
    while ((closer = closerRe.exec(rest)) !== null && !(closer.index > limit)) {
      const g = closer[1] || closer[2] || closer[3] || closer[4] || closer[5] || closer[6];
      if (!g) continue;
      const len = [...g].length;
      if (len !== runLen) continue;
      if (closer[3] || closer[4]) { p += len; continue; }
      p -= len;
      if (p > 0) continue;
      const bb = Math.min(len, len + p);
      const firstLen = [...closer[0]][0].length;
      const raw = src.slice(0, runLen + closer.index + firstLen + bb);
      const inner = raw.slice(runLen, -runLen);
      return { type: 'del', raw, text: inner, tokens: inlineTokens(inner, [], st) };
    }
  }
  return undefined;
}

// --- Inline lexer ---------------------------------------------------------
// Tokenises one inline source. The loop dispatches on the first character so
// most positions only run the one or two rules that can match there.

function inlineTokens(src, tokens, st) {
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(')');
  try {
    return inlineTokensInner(src, tokens, st);
  } finally {
    st.linkParenPossible = savedParen;
  }
}

function inlineTokensInner(src, tokens, st) {
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? maskEmphasis(src, st) : src;
  const maskInfo = needsMask ? scanCloserPositions(masked) : null;
  let prevChar = '';
  let justText = false;
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!justText) prevChar = '';
    justText = false;
    const c = src[0];
    let tok;
    if (c === '\\') {
      tok = tokEscape(src);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      tok = tokBr(src);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    } else if (c === '<') {
      tok = tokTag(src, st);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      tok = tokAutolink(src);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    } else if (c === '[' || c === '!') {
      tok = tokLink(src, st);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      tok = tokReflink(src, st);
      if (tok) {
        src = src.slice(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.type === 'text' && prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
    } else if (c === '*' || c === '_') {
      tok = tokEmStrong(src, masked, prevChar, st, maskInfo);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      if (!st.inLink) {
        tok = tokUrl(src);
        if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
      }
    } else if (c === '`') {
      tok = tokCodespan(src);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    } else if (c === ' ') {
      tok = tokBr(src);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    } else if (c === '~') {
      tok = tokDel(src, masked, prevChar, st, maskInfo);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    } else if (!st.inLink) {
      tok = tokUrl(src);
      if (tok) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    }
    tok = tokInlineText(src, st);
    if (tok) {
      src = src.slice(tok.raw.length);
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      justText = true;
      const prev = tokens.at(-1);
      if (prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
      else tokens.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return tokens;
}

// --- Renderer -------------------------------------------------------------

function renderTextToken(token) {
  if ('tokens' in token && token.tokens) return renderInline(token.tokens);
  if ('escaped' in token && token.escaped) return token.text;
  return escapeHtml(token.text);
}

function renderCode(token) {
  const lang = (token.lang || '').match(RX.notSpaceStart)?.[0];
  const body = token.text ? token.text.replace(RX.endingNewline, '') + '\n' : '';
  const escaped = token.escaped ? body : escapeHtml(body, true);
  if (lang) return `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>\n`;
  return `<pre><code>${escaped}</code></pre>\n`;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInline(cell.tokens) + `</${tag}>\n`;
}

function renderTable(token) {
  let head = '';
  for (const cell of token.header) head += renderTableCell(cell);
  let body = '';
  for (const row of token.rows) {
    let rowHtml = '';
    for (const cell of row) rowHtml += renderTableCell(cell);
    body += `<tr>\n${rowHtml}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
}

function renderList(token) {
  let items = '';
  for (const item of token.items) items += `<li>${renderTokens(item.tokens)}</li>\n`;
  const tag = token.ordered ? 'ol' : 'ul';
  const start = token.ordered && token.start !== 1 ? ` start="${token.start}"` : '';
  return `<${tag}${start}>\n${items}</${tag}>\n`;
}

function renderLink(token) {
  const inner = token.autolink ? escapeHtml(token.text, true) : renderInline(token.tokens);
  const href = encodeHref(token.href);
  if (href === null) return inner;
  let out = `<a href="${escapeHtml(href, token.autolink)}"`;
  if (token.title) out += ` title="${escapeHtml(token.title)}"`;
  return out + `>${inner}</a>`;
}

function renderImage(token) {
  let alt = token.text;
  if (token.tokens) alt = renderInlineText(token.tokens);
  const href = encodeHref(token.href);
  if (href === null) return escapeHtml(alt);
  let out = `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"`;
  if (token.title) out += ` title="${escapeHtml(token.title)}"`;
  return out + '>';
}

function renderTokens(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${token.depth}>${renderInline(token.tokens)}</h${token.depth}>\n`; break;
      case 'code': out += renderCode(token); break;
      case 'table': out += renderTable(token); break;
      case 'blockquote': out += `<blockquote>\n${renderTokens(token.tokens)}</blockquote>\n`; break;
      case 'list': out += renderList(token); break;
      case 'checkbox': out += `<input ${token.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `; break;
      case 'html': out += token.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInline(token.tokens)}</p>\n`; break;
      case 'text': out += renderTextToken(token); break;
      default: throw new Error(`Token with "${token.type}" type was not found.`);
    }
  }
  return out;
}

function renderInline(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape': out += renderTextToken(token); break;
      case 'html': out += token.text; break;
      case 'link': out += renderLink(token); break;
      case 'image': out += renderImage(token); break;
      case 'checkbox': out += `<input ${token.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `; break;
      case 'strong': out += `<strong>${renderInline(token.tokens)}</strong>`; break;
      case 'em': out += `<em>${renderInline(token.tokens)}</em>`; break;
      case 'codespan': out += `<code>${escapeHtml(token.text, true)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'del': out += `<del>${renderInline(token.tokens)}</del>`; break;
      case 'text': out += renderTextToken(token); break;
      default: throw new Error(`Token with "${token.type}" type was not found.`);
    }
  }
  return out;
}

// Plain-text rendering used for image alt text: no tags, no escaping.
function renderInlineText(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += token.tokens ? renderInlineText(token.tokens) : token.text;
        break;
      case 'codespan': out += token.text; break;
      case 'html': out += token.text; break;
      case 'text': out += token.text; break;
      case 'escape': out += token.text; break;
      case 'br': break;
      case 'checkbox': out += token.raw; break;
      default: throw new Error(`Token with "${token.type}" type was not found.`);
    }
  }
  return out;
}

// --- Entry point ----------------------------------------------------------

function lex(src) {
  const st = {
    links: Object.create(null),
    hasLinks: false,
    inlineQueue: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
  src = src.replace(RX.carriageReturn, '\n');
  const tokens = blockTokens(src, [], false, st);
  for (const entry of st.inlineQueue) {
    st.inRawBlock = false;
    inlineTokens(entry.src, entry.tokens, st);
  }
  return tokens;
}

/** The HTML marked 18.1.3 renders for `markdown` with its default options. */
export function parse(markdown) {
  return renderTokens(lex(markdown));
}

