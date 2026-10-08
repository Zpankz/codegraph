/**
 * Entity and link recognition for Markdown prose.
 *
 * Deterministic and local: every rule here reads the SHAPE of a token — the
 * way code is written differently from English — never a model. A word only
 * becomes an entity when its spelling says it is code (`getStats`,
 * `ReferenceResolver`, `parse_file`, `Foo.bar()`, `src/index.ts`), so the
 * extractor can afford to look everywhere and the resolver can stay strict.
 *
 * Reference names produced here follow one encoding the Markdown resolver
 * relies on: a SYMBOL is identifier segments joined by `::` and never holds
 * `/`, `.` or `#`; a PATH always holds at least one of them.
 */

import * as path from 'path';
import { EXTENSION_MAP } from './grammars';

export type MarkdownEntity =
  | { type: 'symbol'; name: string; column: number }
  | { type: 'path'; name: string; column: number };

/** Words that are code-shaped by spelling but are products, not symbols. */
const PROPER_NOUN_STOPLIST = new Set([
  'JavaScript', 'TypeScript', 'CoffeeScript', 'ActionScript', 'PostScript',
  'GitHub', 'GitLab', 'BitBucket', 'Bitbucket', 'YouTube', 'LinkedIn', 'WordPress',
  'PostgreSQL', 'MySQL', 'SQLite', 'MongoDB', 'GraphQL', 'MariaDB', 'DynamoDB',
  'PowerShell', 'OpenAI', 'ChatGPT', 'DeepWiki', 'CodeGraph', 'VSCode', 'IntelliJ',
  'macOS', 'iOS', 'iPadOS', 'tvOS', 'watchOS', 'iPhone', 'iPad', 'eBay',
  'OAuth', 'WebSocket', 'WebSockets', 'WebAssembly', 'DevOps', 'FastAPI', 'NestJS',
  'NextJS', 'NodeJS', 'VueJS', 'ReactJS', 'AngularJS', 'OpenTofu', 'OpenAPI',
  'README', 'TODO', 'FIXME', 'CHANGELOG', 'LICENSE',
]);

/** Spellings a code span uses for values, keywords and shells — never a symbol. */
const NON_SYMBOL_WORDS = new Set([
  'true', 'false', 'null', 'nil', 'none', 'None', 'undefined', 'NaN', 'void',
  'this', 'self', 'super', 'new', 'return', 'async', 'await', 'yield',
  'const', 'let', 'var', 'function', 'class', 'def', 'fn', 'func', 'import', 'export',
  'if', 'else', 'for', 'while', 'switch', 'case', 'try', 'catch', 'throw',
  'int', 'string', 'bool', 'boolean', 'number', 'float', 'double', 'any', 'unknown', 'object',
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'git', 'node', 'cd', 'ls', 'rm', 'cp', 'mv',
]);

/** Fence info strings whose content is a shell, data or a diagram — not callable code. */
const NON_CODE_FENCES = new Set([
  '', 'text', 'txt', 'plain', 'plaintext', 'console', 'shell', 'sh', 'bash', 'zsh', 'fish',
  'powershell', 'ps1', 'bat', 'cmd', 'shell-session', 'terminal',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'scss',
  'csv', 'tsv', 'diff', 'patch', 'mermaid', 'dot', 'graphviz', 'plantuml', 'math', 'latex',
  'tex', 'markdown', 'md', 'mdx', 'log', 'output', 'sql', 'graphql', 'gql', 'dockerfile',
  'env', 'properties', 'http', 'nginx', 'apache', 'gitignore', 'regex',
]);

/** Keywords that look like calls in a fence: `if (`, `while (`, `sizeof(`. */
const FENCE_CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'sizeof',
  'elif', 'match', 'with', 'except', 'assert', 'print', 'require', 'import', 'super',
  'foreach', 'until', 'unless', 'defined', 'and', 'or', 'not', 'in', 'is', 'await',
  'async', 'yield', 'new', 'delete', 'void', 'def', 'fn', 'func', 'lambda', 'when',
]);

/** Declarations inside a fence: example code defines these, it does not reference them. */
const FENCE_DECLARATION =
  /\b(?:function\*?|def|fn|func|fun|sub|class|struct|interface|trait|enum|type|protocol|record)\s+([A-Za-z_$][\w$]*)/g;

const IDENT = '[A-Za-z_$][\\w$]*';
const QUALIFIED_SYMBOL = new RegExp(`^${IDENT}(?:(?:\\.|::|#|->)${IDENT})*$`);
/** A prose token: an identifier chain with an optional trailing `()`. */
const PROSE_TOKEN = new RegExp(`(?<![\\w$./#:-])${IDENT}(?:(?:\\.|::)${IDENT})*(?:\\(\\))?(?![\\w$/])`, 'g');
/** A project path in prose: at least one slash and a known source extension. */
const PROSE_PATH = /(?<![\w$./:-])(?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]{1,10}(?![\w/])/g;
const FENCE_CALL = new RegExp(`(?<![\\w$.])(${IDENT}(?:(?:\\.|::|->)${IDENT})*)\\s*\\(`, 'g');

/** Extensions CodeGraph indexes, plus the doc formats a link can name. */
function isKnownExtension(ext: string): boolean {
  const lower = ext.toLowerCase();
  return lower in EXTENSION_MAP || lower === '.json' || lower === '.md' || lower === '.mdx' || lower === '.markdown';
}

/** `camelCase`: a lowercase start with an internal capital. */
function isCamelCase(word: string): boolean {
  return /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(word);
}

/** `PascalCase` with at least two humps — one hump is just a capitalized word. */
function isMultiHumpPascal(word: string): boolean {
  return /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(word) || /^[A-Z]{2,}[a-z][a-z0-9]*[A-Z]/.test(word);
}

/** `snake_case` or `SCREAMING_SNAKE`: two or more underscore-joined parts. */
function isSnakeCase(word: string): boolean {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(word) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(word);
}

/** Whether a single identifier is spelled the way code is spelled. */
export function isCodeShapedIdentifier(word: string): boolean {
  if (word.length < 3 || PROPER_NOUN_STOPLIST.has(word)) return false;
  return isCamelCase(word) || isMultiHumpPascal(word) || isSnakeCase(word);
}

/** `Foo.bar`, `Foo::bar`, `Foo#bar`, `foo->bar` → `Foo::bar`. */
export function normalizeSymbol(raw: string): string {
  return raw.split(/\.|::|#|->/).filter(Boolean).join('::');
}

/**
 * Classify the text of one inline code span.
 *
 * A code span is the author SAYING "this is code", so it gets the widest
 * reading: a path, a call, a qualified member, or any identifier that is not
 * a keyword or a literal. Anything with spaces left after dropping a call's
 * arguments is a command or an expression — not something to link.
 */
export function classifyCodeSpan(raw: string): Omit<MarkdownEntity, 'column'> | null {
  let text = raw.trim();
  if (text.length < 2 || text.length > 200) return null;
  text = text.replace(/^@/, '').replace(/;$/, '');
  // `foo(a, b)` / `Foo.bar()` — keep the callee, drop the arguments.
  const call = /^([^\s()]+)\((.*)\)$/.exec(text);
  if (call) text = call[1]!;
  text = text.replace(/<[^<>]*>$/, '');
  if (/\s/.test(text)) return null;

  if (looksLikePath(text)) return { type: 'path', name: text.replace(/^\.\//, '') };

  if (!QUALIFIED_SYMBOL.test(text)) return null;
  const segments = text.split(/\.|::|#|->/).filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.length === 1) {
    const only = segments[0]!;
    if (NON_SYMBOL_WORDS.has(only) || only.length < 2 || /^\$?[A-Z]{1,3}$/.test(only)) return null;
  }
  return { type: 'symbol', name: segments.join('::') };
}

/** A string that names a file: a slash with a word on both sides, or a known extension. */
function looksLikePath(text: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false;
  if (/::/.test(text)) return false;
  const ext = path.posix.extname(text);
  if (text.includes('/')) {
    return /^(?:\.{1,2}\/|\/)?[\w@.-]+(?:\/[\w@.-]+)*\/?$/.test(text) && (ext === '' || isKnownExtension(ext));
  }
  return ext.length > 1 && isKnownExtension(ext) && /^[\w@-][\w@.-]*$/.test(text) &&
    // `Foo.bar` reads as a member whose name happens to be an extension
    // (`config.ts` is a file, `res.json` is a call).
    !/^[a-z]+\.(?:json|r|m|h|go|d)$/.test(text);
}

/**
 * Code-shaped tokens in ordinary prose — the named-entity pass.
 *
 * Without backticks, the only evidence is the spelling, so the bar is higher
 * than for a code span: a call (`render()`), a `::`-qualified name, a dotted
 * pair where either side is code-shaped (`ToolHandler.execute`), a single
 * multi-hump/camel/snake identifier, or a slash path ending in a source
 * extension. Brand names spelled like code (`JavaScript`, `GitHub`) are
 * stop-listed; acronyms and capitalized words never qualify.
 */
export function findProseEntities(text: string): MarkdownEntity[] {
  const out: MarkdownEntity[] = [];
  const taken: Array<[number, number]> = [];

  for (const m of text.matchAll(PROSE_PATH)) {
    const value = m[0];
    if (!isKnownExtension(path.posix.extname(value))) continue;
    out.push({ type: 'path', name: value.replace(/^\.\//, ''), column: m.index! });
    taken.push([m.index!, m.index! + value.length]);
  }

  for (const m of text.matchAll(PROSE_TOKEN)) {
    const start = m.index!;
    if (taken.some(([a, b]) => start >= a && start < b)) continue;
    const token = m[0];
    const isCall = token.endsWith('()');
    const bare = isCall ? token.slice(0, -2) : token;
    const segments = bare.split(/\.|::/);
    if (segments.some((s) => s.length === 0)) continue;
    const qualifiedByColons = bare.includes('::');

    let keep: boolean;
    if (segments.length === 1) {
      keep = isCall ? !NON_SYMBOL_WORDS.has(bare) && bare.length >= 2 : isCodeShapedIdentifier(bare);
    } else {
      // `e.g`, `i.e`, `Node.js`, `vs.` — a dotted pair needs a code-shaped side
      // (or a call / `::`) before it reads as a member access.
      keep = isCall || qualifiedByColons || segments.some(isCodeShapedIdentifier);
      if (keep && !isCall && !qualifiedByColons && isKnownExtension(`.${segments[segments.length - 1]}`) &&
          !segments.slice(0, -1).some(isCodeShapedIdentifier)) keep = false;
    }
    if (!keep) continue;
    out.push({ type: 'symbol', name: segments.join('::'), column: start });
  }
  return out;
}

/**
 * Call sites inside a fenced code block, minus the names the block itself
 * declares (an example's own helpers are not references to the project).
 * `null` for a fence whose info string says it holds no callable code.
 */
export function findFenceCalls(info: string, lines: string[]): Array<{ name: string; lineOffset: number; column: number }> | null {
  const lang = info.trim().split(/[\s{,]/)[0]!.toLowerCase();
  if (NON_CODE_FENCES.has(lang)) return null;
  const body = lines.join('\n');
  const declared = new Set<string>();
  for (const m of body.matchAll(FENCE_DECLARATION)) declared.add(m[1]!);

  const out: Array<{ name: string; lineOffset: number; column: number }> = [];
  lines.forEach((line, lineOffset) => {
    const code = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (s) => ' '.repeat(s.length))
      .replace(/(?:\/\/|#).*$/, '');
    for (const m of code.matchAll(FENCE_CALL)) {
      const chain = m[1]!.split(/\.|::|->/);
      const head = chain[0]!;
      const tail = chain[chain.length - 1]!;
      if (FENCE_CALL_KEYWORDS.has(tail) || declared.has(tail) || tail.length < 2) continue;
      // `obj.method()` on a lowercase local: the receiver is an instance, so
      // only the method name says anything. `Type.method()` keeps its type.
      const name = chain.length > 1 && !/^[A-Z]/.test(head) ? tail : chain.join('::');
      out.push({ name, lineOffset, column: m.index! });
    }
  });
  return out;
}

/** Remove inline Markdown syntax, leaving the words a reader sees. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/<!--.*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_s, page: string, alias?: string) => alias ?? page)
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/(`+)(.*?)\1/g, '$2')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The opening sentences of a section's prose, as its summary.
 *
 * Sentence boundaries are a terminal `.`/`!`/`?` followed by whitespace and an
 * uppercase letter, a digit, or a quote — with the abbreviations that end in a
 * period (`e.g.`, `i.e.`, `etc.`, `vs.`) and dotted identifiers (`Foo.bar`)
 * never splitting.
 */
export function summarize(prose: string, maxSentences = 2, maxChars = 300): string {
  const text = prose.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const sentences: string[] = [];
  let start = 0;
  const boundary = /([.!?])\s+(?=[A-Z0-9"'(\[`*_])/g;
  for (const m of text.matchAll(boundary)) {
    const end = m.index! + 1;
    const before = text.slice(Math.max(start, end - 6), end).toLowerCase();
    if (/(?:\be\.g|\bi\.e|\betc|\bvs|\bcf|\bapprox|\bfig|\bno|\bmr|\bdr|\bst)\.$/.test(before)) continue;
    sentences.push(text.slice(start, end).trim());
    start = m.index! + m[0].length;
    if (sentences.length >= maxSentences) break;
  }
  if (sentences.length < maxSentences && start < text.length) sentences.push(text.slice(start).trim());
  const summary = sentences.slice(0, maxSentences).join(' ');
  return summary.length > maxChars ? `${summary.slice(0, maxChars - 1).trimEnd()}…` : summary;
}

/**
 * GitHub's heading anchor: lowercase, punctuation dropped (letters, digits,
 * marks, `_`, `-` and spaces kept), spaces → `-`. Duplicates get `-1`, `-2`, …
 */
export class HeadingSlugger {
  private occurrences = new Map<string, number>();

  static slug(text: string): string {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
  }

  next(text: string): string {
    const base = HeadingSlugger.slug(text);
    let slug = base;
    while (this.occurrences.has(slug)) {
      const n = this.occurrences.get(base)! + 1;
      this.occurrences.set(base, n);
      slug = `${base}-${n}`;
    }
    this.occurrences.set(slug, 0);
    return slug;
  }
}
