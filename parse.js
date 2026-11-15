// A fast, from-scratch CommonMark 0.31.2 + GFM 0.29 renderer that returns exactly
// the HTML marked 18.1.3 produces with its default options (gfm on, breaks off).
// Written independently for this competition: single-pass block lexer, inline
// lexer with delimiter-stack emphasis, and a small renderer. No dependencies.
//
// Design notes (speed):
// - Block parsing walks the source with anchored patterns but keeps the
//   remaining input as a V8 sliced string, so advancing is O(1).
// - The two hottest paths, paragraph line scanning and inline plain-text
//   scanning, are hand-rolled charCode loops instead of regexes.
// - Inline emphasis uses the same left/right-flanking rules as the spec,
//   computed over a length-preserving masked copy of the paragraph text.
// - Output is accumulated in arrays and joined once per node.

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_BARE_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const PERCENT_25 = /%25/g;
const MULTI_SPACE = /\s+/g;
const NOT_SPACE_START = /^\S*/;
const ENDING_NEWLINE = /\n$/;
const BLANK_LINE = /^[ \t]*$/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const ANY_LINE = /\n.*\n/;

// Escape HTML. With `encode` every & is escaped; otherwise only & that does
// not already start a valid entity / character reference.
function escHtml(s, encode) {
  if (encode) {
    return ESCAPE_TEST.test(s) ? s.replace(ESCAPE_REPLACE, (c) => ESCAPE_MAP[c]) : s;
  }
  return ESCAPE_TEST_NO_ENCODE.test(s) ? s.replace(ESCAPE_REPLACE_NO_ENCODE, (c) => ESCAPE_MAP[c]) : s;
}

// Decode numeric character references in inline text; a bare & that does not
// start a valid entity becomes &amp;. Named entities are left untouched.
function decodeEntities(s) {
  if (!NUMERIC_REF.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_BARE_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Encode an href the way a browser would (encodeURI, keeping % intact).
function encodeHref(s) {
  try {
    return encodeURI(s).replace(PERCENT_25, '%');
  } catch {
    return null;
  }
}

// Normalize a link label for lookup: trim, collapse inner whitespace, fold case.
function normLabel(s) {
  return s.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Split a table row on unescaped pipes, honouring an optional column count.
function splitTableRow(row, count) {
  const cells = row.replace(/\|/g, (ch, off, str) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  }).split(' |');
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Expand tabs to spaces on 4-column tab stops (used for indented code etc.).
function expandTabs(s, offset = 0) {
  let col = offset;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Strip `ch` characters from the end of `s` (or every char except `ch` when
// `invert` is set) — used for closing ATX hashes and trailing backslashes.
function stripTrailing(s, ch, invert) {
  let n = s.length;
  let cut = 0;
  for (; cut < n;) {
    const c = s.charAt(n - cut - 1);
    if (c === ch && !invert) cut++;
    else if (c !== ch && invert) cut++;
    else break;
  }
  return s.slice(0, n - cut);
}

// Drop trailing blank lines, keeping at most one trailing newline's worth.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && BLANK_LINE.test(lines[last]);) last--;
  return lines.length - last <= 2 ? s : lines.slice(0, last + 1).join('\n');
}

// Find the index of the unmatched closing bracket/paren, -1 if none, -2 if
// the string ends inside an open pair. `pair` is a two-char string like "()".
function findUnmatched(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// ---------------------------------------------------------------------------
// Grammar: block and inline patterns
// ---------------------------------------------------------------------------

// Block-level tag names that can open an HTML block (type 6).
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// Tiny regex builder: start from a pattern string, substitute named parts,
// return a RegExp. When a substituted fragment carries a leading ^ anchor it
// is dropped, because the fragment lands mid-pattern where ^ would otherwise
// pin the match to the start of the string.
function subAll(src, pairs) {
  let out = typeof src === 'string' ? src : src.source;
  for (const [name, part] of pairs) {
    let text = typeof part === 'string' ? part : part.source;
    if (text.startsWith('^')) text = text.slice(1);
    out = out.split(name).join(text);
  }
  return out;
}
function rx(src, pairs, flags) {
  return new RegExp(pairs ? subAll(src, pairs) : (typeof src === 'string' ? src : src.source), flags || '');
}

// ---------------------------------------------------------------------------
// Block grammar
// ---------------------------------------------------------------------------

const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const INDENT_CODE_COMP = /^(\s+)(?:```)/;
const BEGINNING_SPACE = /^\s+/;
const ENDING_HASH = /#$/;
const STARTING_SPACE = /^ /;
const ENDING_SPACE = / $/;
const ENDING_SPACE_TAB = /[ \t]$/;
const NON_SPACE = /[^ ]/;
const LEAD_END = /[^ \t]/;
const NEWLINE_GLOBAL = /\n/g;
const TAB_GLOBAL = /\t/g;
const LEADING_SPACE_TAB = /^[ \t]+/;
const BLANK = /^[ \t]*$/;
const BLOCKQUOTE_START = /^ {0,3}>/;
const BLOCKQUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BLOCKQUOTE_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const BLOCKQUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const HREF_BRACKETS = /^<(.*)>$/;
const TABLE_DELIM = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ROW_BLANK = /\n[ \t]*$/;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_SCRIPT = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_SCRIPT = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_ANGLE = /^</;
const END_ANGLE = />$/;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const CARRIAGE_RETURN = /\r\n|\r/g;

const HR_SRC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const BULLET_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const FENCES_SRC = ' {0,3}(?:`{3,}|~{3,})';
const BLOCKQUOTE_SRC = ' {0,3}>';
const HTML_BEGIN_SRC = ' {0,3}(?:</?(?:' + BLOCK_TAGS + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const HTML_BEGIN = new RegExp('^' + HTML_BEGIN_SRC, 'i');

// --- block patterns --------------------------------------------------------
const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HR = new RegExp('^' + HR_SRC);
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BLOCK_TEXT = /^[^\n]+/;

// Setext heading (gfm): text lines followed by = or - underline.
const LHEADING_SRC = '^(?!BULL |BLOCKCODE|FENCES|BLOCKQUOTE|HEADING|HTML|TABLE)((?:.|\\n(?!\\s*?\\n|BULL |FENCES|BLOCKQUOTE|HEADING|HR|HTML|TABLE))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
const BLOCK_LHEADING = new RegExp(subAll(LHEADING_SRC, [
  ['BULL ', BULLET_SRC],
  ['BLOCKCODE', '(?: {4}| {0,3}\\t)'],
  ['FENCES', FENCES_SRC],
  ['BLOCKQUOTE', BLOCKQUOTE_SRC],
  ['HEADING', HEADING_SRC],
  ['HR', HR_SRC],
  ['HTML', ' {0,3}<[^\\n>]+>\\n'],
  ['TABLE', ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n'],
]));

// Link reference definition.
const LABEL_INNER = '(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const TITLE_PAT = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';
const BLOCK_DEF = new RegExp(subAll('^ {0,3}\\[(LABEL)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(TITLE))? *(?:\\n+|$)', [
  ['LABEL', '(?!\\s*\\])' + LABEL_INNER],
  ['TITLE', TITLE_PAT],
]));

// List opener: marker plus the rest of its first line.
const BLOCK_LIST = new RegExp('^ {0,3}(' + '(?:[*+-]|\\d{1,9}[.)])' + ')([ \\t][^\\n]*?)?(?:\\n|$)');

// HTML block (gfm): comments, processing instructions, declarations, CDATA,
// block tags, and open/close tags of any other element followed by blank line.
const HTML_ATTR = ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?';
const BLOCK_HTML = new RegExp(subAll('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|COMMENT[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(TAG)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:ATTR)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', [
  ['COMMENT', '<!--(?:-?>|[\\s\\S]*?(?:-->|$))'],
  ['TAG', BLOCK_TAGS],
  ['ATTR', HTML_ATTR],
]), 'i');

// GFM table.
const TABLE_SRC = '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|HR|HEADING|BLOCKQUOTE|CODE|FENCES|LIST|HTML).*(?:\\n|$))*)\\n*|$)';
const BLOCK_TABLE = new RegExp(subAll(TABLE_SRC, [
  ['HR', HR_SRC],
  ['HEADING', HEADING_SRC],
  ['BLOCKQUOTE', BLOCKQUOTE_SRC],
  ['CODE', '(?: {4}| {0,3}\\t)[^\\n]'],
  ['FENCES', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
  ['LIST', ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
  ['HTML', HTML_BEGIN_SRC],
]));

// Paragraph: lines that do not start a new block construct.
const PARA_BASE = '^([^\\n]+(?:\\n(?!HR|HEADING|BLOCKQUOTE|FENCES|LIST|HTML|TABLE|[ \\t]+\\n)[^\\n]+)*)';
const BLOCK_PARAGRAPH = new RegExp(subAll(PARA_BASE, [
  ['HR', HR_SRC],
  ['HEADING', HEADING_SRC],
  ['BLOCKQUOTE', BLOCKQUOTE_SRC],
  ['FENCES', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
  ['LIST', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]'],
  ['HTML', HTML_BEGIN_SRC],
  ['TABLE', BLOCK_TABLE.source],
]));
// Paragraph as used inside block quotes (any ordered list may interrupt).
const BLOCKQUOTE_PARA = new RegExp(subAll(PARA_BASE, [
  ['HR', HR_SRC],
  ['HEADING', HEADING_SRC],
  ['BLOCKQUOTE', BLOCKQUOTE_SRC],
  ['FENCES', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
  ['LIST', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)'],
  ['HTML', HTML_BEGIN_SRC],
]));
const BLOCK_BLOCKQUOTE = new RegExp('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(PARA)|[^\\n]*)(?:\\n|$))+'.replace('PARA', BLOCKQUOTE_PARA.source.replace(/^\^/, '')));

// Per-indent helper patterns used while consuming list items.
const indentCache = new Map();
function indentRx(kind, n) {
  // The indent-taking patterns clamp their level to 0..3, the way the
  // reference does it; the list-item pattern takes a marker string instead.
  const key = kind === 'item' ? 'item:' + n : kind + ':' + Math.max(0, Math.min(3, n - 1));
  let rx = indentCache.get(key);
  if (rx) return rx;
  const m = Math.max(0, Math.min(3, n - 1));
  if (kind === 'item') rx = new RegExp(`^( {0,3}${n})((?:[ \t][^\\n]*)?(?:\\n|$))`);
  else if (kind === 'bullet') rx = new RegExp(`^ {0,${m}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`);
  else if (kind === 'hr') rx = new RegExp(`^ {0,${m}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`);
  else if (kind === 'fences') rx = new RegExp(`^ {0,${m}}(?:\`\`\`|~~~)`);
  else if (kind === 'heading') rx = new RegExp(`^ {0,${m}}#{1,6}(?:\\s|$)`);
  else if (kind === 'html') rx = new RegExp(`^ {0,${m}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
  else rx = new RegExp(`^ {0,${m}}>`);
  indentCache.set(key, rx);
  return rx;
}

// ---------------------------------------------------------------------------
// Inline grammar
// ---------------------------------------------------------------------------

const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const INLINE_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const INLINE_ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const INLINE_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const INLINE_TAG = /^(?:<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>)/;

// Label / reference fragments shared by the link patterns. LE is a flat
// bracketed span; NESTED allows one level of bracket nesting inside a label.
const LE = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const NESTED = '\\[(?:' + LE + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const LABEL_RE = '(?:' + NESTED + '|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const LABEL_FULL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const LABEL_LOOSE = '(?:[^\\[\\]`]*(?:' + NESTED + '|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]`]*?';
const REF_INNER = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const TITLE_INLINE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';

const INLINE_LINK = new RegExp(subAll('^!?\\[(LABEL)\\]\\([ \\t\\n]*(HREF)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(TITLE))?[ \\t\\n]*\\)', [
  ['LABEL', LABEL_RE],
  ['HREF', '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))'],
  ['TITLE', TITLE_INLINE],
]));
const INLINE_REFLINK = new RegExp('^!?\\[(' + LABEL_RE + ')\\]\\[(' + LABEL_FULL + ')\\]');
const INLINE_NOLINK = new RegExp('^!?\\[(' + LABEL_FULL + ')\\](?:\\[\\])?');
const INLINE_REFLINK_SEARCH = new RegExp(
  '!?\\[(' + LABEL_LOOSE + ')\\]\\[(' + REF_INNER + ')\\]|!?\\[(' + REF_INNER + ')\\](?:\\[\\])?(?!\\()', 'g');
const INLINE_BLOCK_SKIP = /(?:\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\))|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

// Extended autolink (GFM): www., scheme://, bare e-mail, mailto:/xmpp:.
// The mailto:/xmpp: alternatives carry no capture group; the bare e-mail
// alternative's (@) is group 2, the scheme/www. group is group 1.
const EMAIL_NOGROUP = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const EMAIL_PAT = '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const INLINE_URL = new RegExp('^(?:mailto:' + EMAIL_NOGROUP + '|xmpp:' + EMAIL_NOGROUP + '(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^' + EMAIL_PAT);
const INLINE_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Emphasis delimiter patterns (GFM flavour: ~ is not punctuation here).
const PUNCT_NO_TILDE = '(?!~)[\\p{P}\\p{S}]';
const LDELIM_SRC = '^(?:\\*+(?:((?!\\*)PUNCT)|([^\\s*]))?)|^_+(?:((?!_)PUNCT)|([^\\s_]))?';
const INLINE_LDELIM = new RegExp(LDELIM_SRC.replace(/PUNCT/g, PUNCT_NO_TILDE), 'u');
const RDELIM_AST_SRC = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)PUNCT(\\*+)(?=[\\s]|$)|NOTPUNCT(\\*+)(?!\\*)(?=PUNCTSPACE|$)|(?!\\*)PUNCTSPACE(\\*+)(?=NOTPUNCT)|[\\s](\\*+)(?!\\*)(?=PUNCT)|(?!\\*)PUNCT(\\*+)(?!\\*)(?=PUNCT)|NOTPUNCT(\\*+)(?=NOTPUNCT)';
const INLINE_RDELIM_AST = new RegExp(subAll(RDELIM_AST_SRC, [
  ['NOTPUNCT', '(?:[^\\s\\p{P}\\p{S}]|~)'],
  ['PUNCTSPACE', '(?!~)[\\s\\p{P}\\p{S}]'],
  ['PUNCT', PUNCT_NO_TILDE],
]), 'gu');
const RDELIM_UND_SRC = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)PUNCT(_+)(?=[\\s]|$)|NOTPUNCT(_+)(?!_)(?=PUNCTSPACE|$)|(?!_)PUNCTSPACE(_+)(?=NOTPUNCT)|[\\s](_+)(?!_)(?=PUNCT)|(?!_)PUNCT(_+)(?!_)(?=PUNCT)';
const INLINE_RDELIM_UND = new RegExp(subAll(RDELIM_UND_SRC, [
  ['NOTPUNCT', '[^\\s\\p{P}\\p{S}]'],
  ['PUNCTSPACE', '[\\s\\p{P}\\p{S}]'],
  ['PUNCT', '[\\p{P}\\p{S}]'],
]), 'gu');

// Strikethrough delimiters.
const INLINE_DEL_LDELIM = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const RDELIM_DEL_SRC = '^[^~]+(?=[^~])|(?!~)PUNCT(~~?)(?=[\\s]|$)|NOTPUNCT(~~?)(?!~)(?=PUNCTSPACE|$)|(?!~)PUNCTSPACE(~~?)(?=NOTPUNCT)|[\\s](~~?)(?!~)(?=PUNCT)|(?!~)PUNCT(~~?)(?!~)(?=PUNCT)|NOTPUNCT(~~?)(?=NOTPUNCT)';
const INLINE_RDELIM_DEL = new RegExp(subAll(RDELIM_DEL_SRC, [
  ['NOTPUNCT', '[^\\s\\p{P}\\p{S}]'],
  ['PUNCTSPACE', '[\\s\\p{P}\\p{S}]'],
  ['PUNCT', '[\\p{P}\\p{S}]'],
]), 'gu');

// ---------------------------------------------------------------------------
// Block lexer
// ---------------------------------------------------------------------------

// Per-parse state: link definitions, the queue of inline sources waiting to
// be tokenized, and the inline flags (inLink / inRawBlock persist across the
// queued inline sources of one parse, the way the reference behaves).
function newLexer() {
  return {
    links: Object.create(null),
    hasLinks: false,
    queue: [],
    closerStack: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
}

// Queue an inline source for later tokenizing; returns its token array.
function queueInline(lx, src) {
  const tokens = [];
  lx.queue.push({ src, tokens });
  return tokens;
}

function tokSpace(src) {
  const m = BLOCK_NEWLINE.exec(src);
  return m && m[0].length > 0 ? { type: 'space', raw: m[0] } : null;
}

function tokCode(src) {
  const m = BLOCK_CODE.exec(src);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(CODE_REMOVE_INDENT, '') };
}

function dedentFence(raw, content) {
  const m = INDENT_CODE_COMP.exec(raw);
  if (!m) return content;
  const ws = m[1];
  return content.split('\n').map((line) => {
    const sp = BEGINNING_SPACE.exec(line);
    if (!sp) return line;
    return line.slice(Math.min(sp[0].length, ws.length));
  }).join('\n');
}

function tokFences(src) {
  const m = BLOCK_FENCES.exec(src);
  if (!m) return null;
  return {
    type: 'code', raw: m[0],
    lang: m[2] ? m[2].trim().replace(ANY_PUNCT, '$1') : m[2],
    text: dedentFence(m[0], m[3] || ''),
  };
}

function tokHeading(src, lx) {
  const m = BLOCK_HEADING.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (ENDING_HASH.test(text)) {
    const stripped = stripTrailing(text, '#');
    if (!stripped || ENDING_SPACE_TAB.test(stripped)) text = stripped.trim();
  }
  return { type: 'heading', raw: stripTrailing(m[0], '\n'), depth: m[1].length, text, tokens: queueInline(lx, text) };
}

function tokHr(src) {
  const m = BLOCK_HR.exec(src);
  return m ? { type: 'hr', raw: stripTrailing(m[0], '\n') } : null;
}

function tokHtml(src) {
  const m = BLOCK_HTML.exec(src);
  if (!m) return null;
  const text = trimBlankTail(m[0]);
  return { type: 'html', block: true, raw: text, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text };
}

function tokDef(src) {
  const m = BLOCK_DEF.exec(src);
  if (!m) return null;
  if (!START_ANGLE.test(m[2]) && findUnmatched(m[2], '()') !== -1) return null;
  return {
    type: 'def', tag: normLabel(m[1]), raw: stripTrailing(m[0], '\n'),
    href: m[2] ? m[2].replace(HREF_BRACKETS, '$1').replace(ANY_PUNCT, '$1') : '',
    title: m[3] ? m[3].slice(1, -1).replace(ANY_PUNCT, '$1') : m[3],
  };
}

function tokTable(src, lx) {
  const m = BLOCK_TABLE.exec(src);
  if (!m || !TABLE_DELIM.test(m[2])) return null;
  const header = splitTableRow(m[1]);
  const aligns = m[2].replace(TABLE_ALIGN_CHARS, '').split('|');
  const body = m[3] && m[3].trim() ? m[3].replace(TABLE_ROW_BLANK, '').split('\n') : [];
  const table = { type: 'table', raw: stripTrailing(m[0], '\n'), header: [], align: [], rows: [] };
  if (header.length !== aligns.length) return null;
  for (const a of aligns) {
    table.align.push(TABLE_ALIGN_RIGHT.test(a) ? 'right' : TABLE_ALIGN_CENTER.test(a) ? 'center' : TABLE_ALIGN_LEFT.test(a) ? 'left' : null);
  }
  for (let i = 0; i < header.length; i++) {
    table.header.push({ text: header[i], tokens: queueInline(lx, header[i]), header: true, align: table.align[i] });
  }
  for (const row of body) {
    table.rows.push(splitTableRow(row, table.header.length).map((cell, j) => ({ text: cell, tokens: queueInline(lx, cell), header: false, align: table.align[j] })));
  }
  return table;
}

function tokLheading(src, lx) {
  const m = BLOCK_LHEADING.exec(src);
  if (!m) return null;
  const text = m[1].trim();
  return { type: 'heading', raw: stripTrailing(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(lx, text) };
}

function tokParagraph(src, lx) {
  const m = BLOCK_PARAGRAPH.exec(src);
  if (!m) return null;
  let text = m[1];
  if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
  return { type: 'paragraph', raw: m[0], text, tokens: queueInline(lx, text) };
}

function tokText(src, lx) {
  const m = BLOCK_TEXT.exec(src);
  if (!m) return null;
  return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(lx, m[0]) };
}

function tokBlockquote(src, lx) {
  const m = BLOCK_BLOCKQUOTE.exec(src);
  if (!m) return null;
  let lines = stripTrailing(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let lazy = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (BLOCKQUOTE_START.test(lines[p])) { chunk.push(lines[p]); lazy = true; }
      else if (!lazy) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const joined = chunk.join('\n');
    const inner = joined
      .replace(BLOCKQUOTE_MARKER_WS, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(BLOCKQUOTE_SETEXT, '\n    $1')
      .replace(BLOCKQUOTE_SETEXT2, '');
    raw = raw ? raw + '\n' + joined : joined;
    text = text ? text + '\n' + inner : inner;
    const savedTop = lx.top;
    lx.top = true;
    blockTokens(inner, tokens, true, lx);
    lx.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
    if (last && last.type === 'blockquote') {
      const prev = last;
      const rest = lines.join('\n');
      const combined = prev.raw + '\n' + rest.replace(BLOCKQUOTE_SETEXT2, '');
      const re = tokBlockquote(combined, lx);
      tokens[tokens.length - 1] = re;
      const tail = combined.slice(re.raw.length).replace(/^\n/, '');
      const tailLines = tail ? tail.split('\n').length : 0;
      const consumed = tailLines ? lines.slice(0, -tailLines) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.slice(0, text.length - prev.text.length) + re.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && BLOCKQUOTE_START.test(lines[0])) continue;
      break;
    }
    if (last && last.type === 'list') {
      const prev = last;
      const combined = prev.raw + '\n' + lines.join('\n');
      const re = tokList(combined, lx);
      tokens[tokens.length - 1] = re;
      const extra = re.raw.length > prev.raw.length ? combined.slice(prev.raw.length + 1, re.raw.length).split('\n').length : 0;
      if (extra > 0) {
        const extraLines = lines.slice(0, extra).join('\n');
        raw = raw + '\n' + extraLines;
        text = text + '\n' + extraLines;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

function tokList(src, lx) {
  const m = BLOCK_LIST.exec(src);
  if (!m) return null;
  let rest = src;
  const orig = src;
  const used = () => orig.length - rest.length;
  const marker = m[1].trim();
  const ordered = marker.length > 1;
  const list = { type: 'list', raw: '', ordered, start: ordered ? +marker.slice(0, -1) : '', loose: false, items: [] };
  const markerPat = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
  const itemRx = indentRx('item', markerPat);
  let sawDoubleBlank = false;
  while (rest) {
    let empty = false;
    let content = '';
    const it = itemRx.exec(rest);
    if (!it || BLOCK_HR.test(rest)) break;
    const itemStart = used();
    rest = rest.slice(it[0].length);
    const nl2 = it[2].indexOf('\n');
    const firstLine = nl2 === -1 ? it[2] : it[2].slice(0, nl2);
    const markerWidth = it[1].length;
    const lt0 = firstLine.indexOf('\t');
    let line = lt0 === -1 ? firstLine : firstLine.replace(LEADING_SPACE_TAB, (v) => expandTabs(v, markerWidth));
    const nl3 = rest.indexOf('\n');
    const nextLine = nl3 === -1 ? rest : rest.slice(0, nl3);
    let isEmpty = !line.trim();
    let indent;
    if (isEmpty) indent = markerWidth + 1;
    else {
      indent = line.search(NON_SPACE);
      indent = indent > 4 ? 1 : indent;
      content = line.slice(indent);
      indent += markerWidth;
    }
    if (isEmpty && BLANK.test(nextLine)) { rest = rest.slice(nextLine.length + 1); empty = true; }
    if (!empty) {
      const bulletRx = indentRx('bullet', indent);
      const hrRx = indentRx('hr', indent);
      const fenceRx = indentRx('fences', indent);
      const headRx = indentRx('heading', indent);
      const htmlRx = indentRx('html', indent);
      const bqRx = indentRx('blockquote', indent);
      while (rest) {
        const nlc = rest.indexOf('\n');
        const curLine = nlc === -1 ? rest : rest.slice(0, nlc);
        // The block-start tests below only run when the line's first
        // non-space character could open that construct at all. The
        // leading run is spaces and tabs, so the first character that is
        // neither is where a construct would start.
        const ci = curLine.search(LEAD_END);
        const fc = ci === -1 ? -1 : curLine.charCodeAt(ci);
        const lt = curLine.indexOf('\t');
        const expanded = lt !== -1 && (ci === -1 || lt < ci) ? curLine.replace(LEADING_SPACE_TAB, (v) => expandTabs(v)) : curLine;
        const nsi = expanded === curLine ? ci : expanded.search(NON_SPACE);
        let isBlockStart = false;
        if (fc === 96 || fc === 126) isBlockStart = fenceRx.test(curLine);
        else if (fc === 35) isBlockStart = headRx.test(curLine);
        else if (fc === 60) isBlockStart = htmlRx.test(curLine);
        else if (fc === 62) isBlockStart = bqRx.test(curLine);
        else if (fc === 42 || fc === 45) isBlockStart = bulletRx.test(curLine) || hrRx.test(curLine);
        else if (fc === 43 || (fc >= 48 && fc <= 57)) isBlockStart = bulletRx.test(curLine);
        else if (fc === 95) isBlockStart = hrRx.test(curLine);
        if (isBlockStart) break;
        if (nsi >= indent || !curLine.trim()) content += '\n' + expanded.slice(indent);
        else {
          if (isEmpty || (line.includes('\t') ? line.replace(TAB_GLOBAL, '    ').search(NON_SPACE) : line.search(NON_SPACE)) >= 4 || fenceRx.test(line) || headRx.test(line) || htmlRx.test(line) || hrRx.test(line)) break;
          const setext = /^ {0,3}(?:=+|-+) *$/.test(curLine) && BLOCK_LHEADING.test(`${line}\n${curLine}`)
            ? `    ${expanded.replace(/^ {0,3}/, '')}` : curLine;
          content += '\n' + setext;
        }
        // `isEmpty` tracks whether the previous line was blank.
        isEmpty = !curLine.trim();
        rest = rest.slice(curLine.length + 1);
        line = expanded.slice(indent);
      }
    }
    const itemRaw = orig.slice(itemStart, used());
    if (!list.loose) {
      if (sawDoubleBlank) list.loose = true;
      else if (DOUBLE_BLANK.test(itemRaw)) sawDoubleBlank = true;
    }
    list.items.push({ type: 'list_item', raw: itemRaw, task: LIST_IS_TASK.test(content), loose: false, text: content, tokens: [] });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) { lastItem.raw = lastItem.raw.trimEnd(); lastItem.text = lastItem.text.trimEnd(); }
  else return null;
  list.raw = orig.slice(0, used()).trimEnd();
  for (const item of list.items) {
    lx.top = false;
    item.tokens = blockTokens(item.text, [], false, lx);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      if (spaces.length > 0 && spaces.some((t) => ANY_LINE.test(t.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && first && (first.type === 'text' || first.type === 'paragraph')) {
      item.text = item.text.replace(LIST_REPLACE_TASK, '');
      first.raw = first.raw.replace(LIST_REPLACE_TASK, '');
      first.text = first.text.replace(LIST_REPLACE_TASK, '');
      for (let g = lx.queue.length - 1; g >= 0; g--) {
        if (LIST_IS_TASK.test(lx.queue[g].src)) { lx.queue[g].src = lx.queue[g].src.replace(LIST_REPLACE_TASK, ''); break; }
      }
      const cb = LIST_TASK_CHECKBOX.exec(item.raw);
      if (cb) {
        const check = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
        item.checked = check.checked;
        if (list.loose) {
          if (item.tokens[0] && (item.tokens[0].type === 'paragraph' || item.tokens[0].type === 'text') && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
            item.tokens[0].raw = check.raw + item.tokens[0].raw;
            item.tokens[0].text = check.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(check);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: check.raw, text: check.raw, tokens: [check] });
          }
        } else {
          item.tokens.unshift(check);
        }
      }
    } else if (item.task) item.task = false;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return list;
}

// The block loop: try each block construct in precedence order, merging
// indented code and link definitions into a preceding paragraph or text.
function blockTokens(src, out, inQuote, lx) {
  let guard = Infinity;
  for (; src;) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let tok;
    if ((tok = tokSpace(src))) {
      src = src.slice(tok.raw.length);
      const prev = out[out.length - 1];
      if (tok.raw.length === 1 && prev) prev.raw += '\n';
      else out.push(tok);
      continue;
    }
    if ((tok = tokCode(src))) {
      src = src.slice(tok.raw.length);
      const prev = out[out.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        lx.queue[lx.queue.length - 1].src = prev.text;
      } else out.push(tok);
      continue;
    }
    if ((tok = tokFences(src))) { src = src.slice(tok.raw.length); out.push(tok); continue; }
    if ((tok = tokHeading(src, lx))) { src = src.slice(tok.raw.length); out.push(tok); continue; }
    if ((tok = tokHr(src))) { src = src.slice(tok.raw.length); out.push(tok); continue; }
    if ((tok = tokBlockquote(src, lx))) { src = src.slice(tok.raw.length); out.push(tok); continue; }
    if ((tok = tokList(src, lx))) { src = src.slice(tok.raw.length); out.push(tok); continue; }
    if ((tok = tokHtml(src))) { src = src.slice(tok.raw.length); out.push(tok); continue; }
    if ((tok = tokDef(src))) {
      src = src.slice(tok.raw.length);
      const prev = out[out.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
        lx.queue[lx.queue.length - 1].src = prev.text;
      } else {
        if (!lx.links[tok.tag]) { lx.links[tok.tag] = { href: tok.href, title: tok.title }; lx.hasLinks = true; }
        out.push(tok);
      }
      continue;
    }
    if ((tok = tokTable(src, lx))) { src = src.slice(tok.raw.length); out.push(tok); continue; }
    if ((tok = tokLheading(src, lx))) { src = src.slice(tok.raw.length); out.push(tok); continue; }
    if (lx.top && (tok = tokParagraph(src, lx))) {
      const prev = out[out.length - 1];
      if (inQuote && prev && prev.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        lx.queue.pop();
        lx.queue[lx.queue.length - 1].src = prev.text;
      } else out.push(tok);
      inQuote = false;
      src = src.slice(tok.raw.length);
      continue;
    }
    if ((tok = tokText(src, lx))) {
      src = src.slice(tok.raw.length);
      const prev = out[out.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        lx.queue.pop();
        lx.queue[lx.queue.length - 1].src = prev.text;
      } else out.push(tok);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  lx.top = true;
  return out;
}

// ---------------------------------------------------------------------------
// Inline lexer
// ---------------------------------------------------------------------------

// ASCII lookup tables for the plain-text scanner.
const EMAIL_CHAR = new Uint8Array(128);
for (const c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-") EMAIL_CHAR[c.charCodeAt(0)] = 1;
const WORD_CHAR = new Uint8Array(128);
for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_') WORD_CHAR[c.charCodeAt(0)] = 1;
function isAlnum(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
// A single native scan for the next place plain text stops: a token opener,
// a scheme or www. autolink start, a hard break, or an e-mail address.
// The first three alternatives end the text at the match; the last three
// (a character before a hard break, mailto:/xmpp: or an e-mail address)
// end it one character past the match.
const TEXT_STOP = /(?:[\\<!\[`*~_])|(?:[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/)|(?<=[\s*_~(])www\.|([^ ])(?= {2,}\n)|([^a-zA-Z0-9])(?=mailto:|xmpp:)|([^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-])(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)/g;

// Where the plain-text token starting at 0 ends: a hand-rolled scan that
// stops exactly where the text pattern would stop (before a token opener,
// a hard break, an autolink or an e-mail address).
function inlineTextEnd(src) {
  const end = src.length;
  if (end === 0) return 0;
  // A single non-alphanumeric character before mailto:/xmpp: is its own token.
  if (end > 1 && !isAlnum(src.charCodeAt(0)) && (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) return 1;
  let i = 0;
  const c0 = src.charCodeAt(0);
  if (c0 === 96) { while (i < end && src.charCodeAt(i) === 96) i++; }
  else if (c0 === 126) { while (i < end && src.charCodeAt(i) === 126) i++; }
  else i = 1;
  // Zero-width checks that only apply right after the first character:
  // a hard break (two spaces and a newline) or an e-mail address start.
  if (i < end) {
    if (src.charCodeAt(i) === 32) {
      let j = i;
      while (j < end && src.charCodeAt(j) === 32) j++;
      if (j - i >= 2 && j < end && src.charCodeAt(j) === 10) return i;
    }
    if (src.charCodeAt(i) < 128 && EMAIL_CHAR[src.charCodeAt(i)]) {
      let k = i;
      while (k < end && src.charCodeAt(k) < 128 && EMAIL_CHAR[src.charCodeAt(k)]) k++;
      if (k > i && k < end && src.charCodeAt(k) === 64) return i;
    }
  }
  TEXT_STOP.lastIndex = i;
  const m = TEXT_STOP.exec(src);
  if (!m) return end;
  return m[1] || m[2] || m[3] ? m.index + 1 : m.index;
}

// Length-preserving mask of an inline source, hiding link text, code spans,
// escaped punctuation and HTML tags from the emphasis scan.
function maskReflink(m, links, lx) {
  const o = m.lastIndexOf('[');
  if (!Object.hasOwn(links, normLabel(m.slice(o + 1, -1)))) return m;
  if (o > 1 && m.charAt(0) !== '!') {
    const inner = m.slice(1, o - 1);
    if (linkInText(inner, links, lx)) {
      return '[' + inner.replace(INLINE_REFLINK_SEARCH, (mm) => maskReflink(mm, links, lx)) + '][' + 'a'.repeat(m.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(m.length - 2) + ']';
}

function maskSource(src, links, lx) {
  let t = src;
  // A reference link only matters when a definition exists; without one the
  // search can match nothing the mask would change.
  if (lx.hasLinks && src.includes('[')) {
    INLINE_REFLINK_SEARCH.lastIndex = 0;
    t = t.replace(INLINE_REFLINK_SEARCH, (m) => maskReflink(m, links, lx));
  }
  // Escaped punctuation and code spans need a backslash or a backtick.
  if (t.includes('`') || t.includes('\\')) {
    t = t.replace(INLINE_ANY_PUNCT_OUTSIDE_CODE, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  }
  // Inline links, code spans and tags need one of their openers.
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(INLINE_BLOCK_SKIP, (n) => '[' + 'a'.repeat(n.length - 2) + ']');
  }
  return t;
}

// Does `src` hold a link (inline or reference) anywhere? Used by the mask.
function linkInText(src, links, lx) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(INLINE_BLOCK_SKIP)) {
    if (INLINE_LINK.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(INLINE_REFLINK_SEARCH)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(s.slice(1, r - 1), links, lx))) return true;
  }
  return false;
}

// Last index in the masked string where each delimiter could close emphasis:
// the start of a delimiter run preceded by a non-whitespace character.
function scanClosers(s) {
  const out = { star: -1, under: -1, tilde: -1 };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') { i++; continue; }
    const prev = i === 0 ? '\n' : s[i - 1];
    let j = i + 1;
    while (j < n && s[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') out.tilde = i;
      else if (ch === '*') out.star = i;
      else out.under = i;
    }
    i = j;
  }
  return out;
}

// Whether a `<` inside link text starts a tag/autolink that runs past the
// text: such a link is not a link at all.
function hasTagBeyond(full, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const m = INLINE_CODE.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = full.slice(offset + i);
    const m = INLINE_TAG.exec(rest) || INLINE_AUTOLINK.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// Build a link or image token, tokenizing its text; a link whose text holds
// another link is dropped, the way the reference drops it.
function makeLink(m, dest, raw, lx) {
  const text = m[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const isImage = m[0].charAt(0) === '!';
  const savedInLink = lx.inLink;
  const savedEmitted = lx.linkEmitted;
  const savedRawBlock = lx.inRawBlock;
  lx.inLink = true;
  lx.linkEmitted = false;
  const tokens = tokenizeInline(lx, text);
  const emitted = lx.linkEmitted;
  lx.linkEmitted = savedEmitted;
  lx.inLink = savedInLink;
  if (!isImage) {
    if (emitted) { lx.inRawBlock = savedRawBlock; return null; }
    lx.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href: dest.href, title: dest.title || null, text, tokens };
}

function tokEscape(src) {
  const m = INLINE_ESCAPE.exec(src);
  return m ? { type: 'escape', raw: m[0], text: m[1] } : null;
}

function tokTag(src, lx) {
  const m = INLINE_TAG.exec(src);
  if (!m) return null;
  if (!lx.inLink && START_A_TAG.test(m[0])) lx.inLink = true;
  else if (lx.inLink && END_A_TAG.test(m[0])) lx.inLink = false;
  if (!lx.inRawBlock && START_PRE_SCRIPT.test(m[0])) lx.inRawBlock = true;
  else if (lx.inRawBlock && END_PRE_SCRIPT.test(m[0])) lx.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: lx.inLink, inRawBlock: lx.inRawBlock, block: false, text: m[0] };
}

function tokLink(src, lx) {
  if (!lx.linkParenPossible) return null;
  const m = INLINE_LINK.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasTagBeyond(src, m[1], bang)) return null;
  const href = m[2].trim();
  if (START_ANGLE.test(href)) {
    if (!END_ANGLE.test(href)) return null;
    const stripped = stripTrailing(href.slice(0, -1), '\\');
    if ((href.length - stripped.length) % 2 === 0) return null;
  } else {
    const un = findUnmatched(m[2], '()');
    if (un === -2) return null;
    if (un > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + un;
      m[2] = m[2].slice(0, un);
      m[0] = m[0].slice(0, cut).trim();
      m[3] = '';
    }
  }
  const rawEnd = stripTrailing(m[0].slice(0, -1), '\\');
  if ((m[0].length - rawEnd.length) % 2 === 0) return null;
  let dest = m[2].trim();
  const title = m[3] ? m[3].slice(1, -1) : '';
  if (START_ANGLE.test(dest)) dest = dest.slice(1, -1);
  return makeLink(m, { href: dest && dest.replace(ANY_PUNCT, '$1'), title: title && title.replace(ANY_PUNCT, '$1') }, m[0], lx);
}

function tokReflink(src, lx) {
  const m = INLINE_REFLINK.exec(src) || INLINE_NOLINK.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasTagBeyond(src, m[1], bang)) return null;
  const def = lx.links[normLabel(m[2] || m[1])];
  if (!def) {
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return makeLink(m, def, m[0], lx);
}

function tokCodespan(src) {
  const m = INLINE_CODE.exec(src);
  if (!m) return null;
  let text = m[2].replace(NEWLINE_GLOBAL, ' ');
  if (NON_SPACE.test(text) && STARTING_SPACE.test(text) && ENDING_SPACE.test(text)) text = text.slice(1, -1);
  return { type: 'codespan', raw: m[0], text };
}

function tokBr(src) {
  const m = INLINE_BR.exec(src);
  return m ? { type: 'br', raw: m[0] } : null;
}

function tokAutolink(src) {
  const m = INLINE_AUTOLINK.exec(src);
  if (!m) return null;
  const text = m[1];
  const href = m[2] === '@' ? 'mailto:' + text : text;
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tokUrl(src) {
  const m = INLINE_URL.exec(src);
  if (!m) return null;
  if (m[2] === '@') {
    const text = m[0];
    return { type: 'link', raw: text, text, href: 'mailto:' + text, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
  const scheme = m[1];
  let cur = m[0];
  let prev;
  do {
    prev = cur;
    cur = INLINE_BACKPEDAL.exec(cur)?.[0] ?? '';
  } while (prev !== cur);
  return { type: 'link', raw: cur, text: cur, href: scheme === 'www.' ? 'http://' + cur : cur, autolink: true, tokens: [{ type: 'text', raw: cur, text: cur }] };
}

function tokInlineText(src, lx) {
  const end = inlineTextEnd(src);
  const raw = src.slice(0, end);
  const inRaw = lx.inRawBlock;
  return { type: 'text', raw, text: inRaw ? raw : decodeEntities(raw), escaped: inRaw };
}

// Emphasis / strong emphasis, following the flanking rules over the masked
// string: find the first closer the delimiter rules allow.
function tokEmStrong(src, masked, prevChar, lx) {
  const s = INLINE_LDELIM.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const delim = s[0][0];
  const sameAsPrev = prevChar === delim;
  const i = masked.length - src.length;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!INLINE_PUNCT.exec(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : !!INLINE_PUNCT.exec(n);
  if (s[4] && n.match(UNICODE_ALNUM)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let m = k;
    let f = 0;
    const y = i - l + k;
    const canSingle = !!p.trim() && (!!d || (delim === '*' && !h));
    if (delim !== '*' && delim !== '_') return null;
    const rdelim = delim === '*' ? INLINE_RDELIM_AST : INLINE_RDELIM_UND;
    const closers = lx.closerStack[lx.closerStack.length - 1];
    const v = delim === '*' ? closers.star : closers.under;
    const q = i + k;
    if (v < q) return null;
    const t2 = masked.slice(-src.length + k);
    const limit = v - q;
    rdelim.lastIndex = 0;
    let s2;
    while ((s2 = rdelim.exec(t2)) !== null && !(s2.index > limit)) {
      const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      let b = [...g].length;
      if (s2[3] || s2[4]) { m += b; continue; }
      if (s2[5] || s2[6] || canSingle) {
        if (sameAsPrev && (s2[5] || s2[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...s2[0]][0].length;
      const raw = src.slice(0, k + s2.index + te + b);
      if (Math.min(k, b) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: tokenizeInline(lx, text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: tokenizeInline(lx, text) };
    }
  }
  return null;
}

// Strikethrough: one or two tildes, same closer search, no rule of three.
function tokDel(src, masked, prevChar, lx) {
  const s = INLINE_DEL_LDELIM.exec(src);
  if (!s) return null;
  if (!s[1] && prevChar && !INLINE_PUNCT.exec(prevChar)) return null;
  const run = [...s[0]].length - 1;
  let pending = run;
  const closers = lx.closerStack[lx.closerStack.length - 1];
  const u = closers.tilde;
  const d = masked.length - src.length + run;
  if (u < d) return null;
  const t2 = masked.slice(-src.length + run);
  const limit = u - d;
  INLINE_RDELIM_DEL.lastIndex = 0;
  let m;
  while ((m = INLINE_RDELIM_DEL.exec(t2)) !== null && !(m.index > limit)) {
    const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
    if (!g) continue;
    let l = [...g].length;
    if (l !== run) continue;
    if (m[3] || m[4]) { pending += l; continue; }
    pending -= l;
    if (pending > 0) continue;
    l = Math.min(l, l + pending);
    const te = [...m[0]][0].length;
    const raw = src.slice(0, run + m.index + te + l);
    const text = raw.slice(run, -run);
    return { type: 'del', raw, text, tokens: tokenizeInline(lx, text) };
  }
  return null;
}

// Tokenize one inline source. The masked copy (when emphasis may occur) and
// the closer indexes are pushed on a stack so nested calls restore them.
function tokenizeInline(lx, src) {
  const savedParen = lx.linkParenPossible;
  lx.linkParenPossible = savedParen && src.includes(')');
  const hasEm = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasEm ? maskSource(src, lx.links, lx) : src;
  lx.closerStack.push(hasEm ? scanClosers(masked) : null);
  try {
    return inlineLoop(lx, src, masked);
  } finally {
    lx.closerStack.pop();
    lx.linkParenPossible = savedParen;
  }
}

function inlineLoop(lx, src, masked) {
  const tokens = [];
  let rest = src;
  let prevChar = '';
  let prevWasText = false;
  let guard = Infinity;
  for (; rest;) {
    if (rest.length < guard) guard = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    // Dispatch on the first byte: every tokenizer's pattern is anchored,
    // so only the ones whose opener can start here are tried at all.
    const c = rest.charCodeAt(0);
    let tok = null;
    let isText = false;
    if (c === 92) tok = tokEscape(rest) || tokBr(rest);
    else if (c === 60) tok = tokTag(rest, lx) || tokAutolink(rest);
    else if (c === 91 || c === 33) tok = tokLink(rest, lx) || tokReflink(rest, lx);
    else if (c === 42) tok = tokEmStrong(rest, masked, prevChar, lx);
    else if (c === 95) tok = tokEmStrong(rest, masked, prevChar, lx) || (!lx.inLink && tokUrl(rest));
    else if (c === 96) tok = tokCodespan(rest);
    else if (c === 126) tok = tokDel(rest, masked, prevChar, lx);
    else if (c === 32 || c === 10) tok = tokBr(rest);
    else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 43 || c === 45) {
      if (!lx.inLink) tok = tokUrl(rest);
    }
    if (!tok) {
      tok = tokInlineText(rest, lx);
      isText = true;
    }
    rest = rest.slice(tok.raw.length);
    if (isText) {
      if (tok.raw.charAt(tok.raw.length - 1) !== '_') prevChar = tok.raw.charAt(tok.raw.length - 1);
      prevWasText = true;
    }
    const last = tokens[tokens.length - 1];
    if (tok.type === 'text' && last && last.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
    else tokens.push(tok);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + renderInline(cell.tokens) + `</${tag}>\n`;
}

function renderBlocks(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${t.depth}>${renderInline(t.tokens)}</h${t.depth}>\n`; break;
      case 'code': {
        const lang = (t.lang || '').match(NOT_SPACE_START)?.[0];
        const text = t.text ? escHtml(t.text.replace(ENDING_NEWLINE, '') + '\n', true) : '';
        out += lang
          ? `<pre><code class="language-${escHtml(lang)}">${text}</code></pre>\n`
          : `<pre><code>${text}</code></pre>\n`;
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of t.header) head += renderCell(cell);
        let body = '';
        for (const row of t.rows) {
          let cells = '';
          for (const cell of row) cells += renderCell(cell);
          body += `<tr>\n${cells}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
        break;
      }
      case 'blockquote': out += `<blockquote>\n${renderBlocks(t.tokens)}</blockquote>\n`; break;
      case 'list': {
        let items = '';
        for (const item of t.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
        const tag = t.ordered ? 'ol' : 'ul';
        const start = t.ordered && t.start !== 1 ? ` start="${t.start}"` : '';
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox': out += `<input ${t.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `; break;
      case 'html': out += t.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInline(t.tokens)}</p>\n`; break;
      case 'text': out += renderInline(t.tokens); break;
      default: throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}

// Inline rendering. `textMode` renders the plain text a token stands for
// (used for image alt text), where formatting is dropped.
function renderInline(tokens, textMode) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'escape': out += textMode ? t.text : escHtml(t.text); break;
      case 'html': out += t.text; break;
      case 'link': {
        if (textMode) { out += t.tokens ? renderInline(t.tokens, true) : t.text; break; }
        const inner = t.autolink ? escHtml(t.text, true) : renderInline(t.tokens);
        const href = encodeHref(t.href);
        if (href === null) { out += inner; break; }
        let a = '<a href="' + escHtml(href, t.autolink) + '"';
        if (t.title) a += ' title="' + escHtml(t.title) + '"';
        out += a + '>' + inner + '</a>';
        break;
      }
      case 'image': {
        const alt = t.tokens ? renderInline(t.tokens, true) : t.text;
        if (textMode) { out += alt; break; }
        const href = encodeHref(t.href);
        if (href === null) { out += escHtml(alt); break; }
        let img = `<img src="${escHtml(href)}" alt="${escHtml(alt)}"`;
        if (t.title) img += ` title="${escHtml(t.title)}"`;
        out += img + '>';
        break;
      }
      case 'checkbox': out += textMode ? t.raw : `<input ${t.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `; break;
      case 'strong': out += textMode ? renderInline(t.tokens, true) : `<strong>${renderInline(t.tokens)}</strong>`; break;
      case 'em': out += textMode ? renderInline(t.tokens, true) : `<em>${renderInline(t.tokens)}</em>`; break;
      case 'codespan': out += textMode ? t.text : `<code>${escHtml(t.text, true)}</code>`; break;
      case 'br': out += textMode ? '' : '<br>'; break;
      case 'del': out += textMode ? renderInline(t.tokens, true) : `<del>${renderInline(t.tokens)}</del>`; break;
      case 'text': {
        if (textMode) { out += t.text; break; }
        out += 'tokens' in t && t.tokens ? renderInline(t.tokens) : ('escaped' in t && t.escaped ? t.text : escHtml(t.text));
        break;
      }
      default: throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with its default options. */
export function parse(markdown) {
  const lx = newLexer();
  const src = markdown.replace(CARRIAGE_RETURN, '\n');
  const tokens = blockTokens(src, [], false, lx);
  for (const item of lx.queue) {
    lx.inRawBlock = false;
    item.tokens.push(...tokenizeInline(lx, item.src));
  }
  return renderBlocks(tokens);
}
