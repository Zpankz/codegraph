import * as path from 'path';
import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, ReferenceKind } from '../types';
import { generateNodeId, NodeIdAllocator } from './tree-sitter-helpers';
import {
  HeadingSlugger,
  classifyCodeSpan,
  findFenceCalls,
  findProseEntities,
  stripInlineMarkdown,
  summarize,
} from './markdown-entities';

interface Section {
  node: Node;
  level: number;
  prose: string[];
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const REFERENCE_DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(].*)?\s*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_OR_QUOTE_PREFIX = /^\s*(?:>\s?)*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)?/;
const CODE_SPAN = /(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;
const INLINE_LINK = /(!?)\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE_LINK = /(!?)\[((?:[^[\]]|\[[^\]]*\])*)\](?:\[([^\]]*)\])?(?![(:])/g;
const WIKI_LINK = /\[\[([^\]|#]+)?(?:#([^\]|]+))?(?:\|[^\]]+)?\]\]/g;
const HTML_HREF = /<a\s[^>]*?href\s*=\s*["']([^"']+)["']/gi;
const AUTOLINK = /<[a-z][a-z0-9+.-]*:[^\s<>]*>|\bhttps?:\/\/[^\s<>()]+/gi;
const DEFINED_TERM =
  /^\s{0,3}(?:[-*+]\s+|\d{1,9}[.)]\s+)?(?:\*\*|__)([^*_]{2,60}?)(:?)(?:\*\*|__)\s*([:—–-])?\s*(\S.*)$/;
/** Bold lead-ins that introduce a remark, not a term. */
const ADMONITION_WORDS = new Set([
  'note', 'notes', 'warning', 'important', 'tip', 'tips', 'caution', 'danger', 'info',
  'example', 'examples', 'tl;dr', 'tldr', 'breaking', 'deprecated', 'update', 'edit', 'todo',
  'why', 'how', 'what', 'result', 'results', 'summary', 'see also', 'nb', 'ps',
]);
const MDX_IMPORT = /^import\s+(?:[\s\S]+?\s+from\s+)?["']([^"']+)["'];?\s*$/;
const JSX_COMPONENT = /<([A-Z][\w$]*(?:\.[A-Z][\w$]*)*)[\s/>]/g;

/**
 * MarkdownExtractor - indexes Markdown and MDX documents.
 *
 * A document is code's prose layer, so it is extracted the way a source file
 * is: a file node, a `module` per heading nested by level (qualified as
 * `<file>#<anchor>`, the anchor GitHub renders), a `constant` per defined term
 * (`**Term**: definition`), and references for everything the prose points at
 * — links to other documents, their headings, source files and line ranges,
 * plus the code entities `./markdown-entities` recognizes in code spans, in
 * prose and in fenced examples. MDX `import`s become `imports`.
 *
 * Each section's opening sentences become its docstring, so full-text search
 * reaches a section by what it says, not only by its title.
 */
export class MarkdownExtractor {
  private filePath: string;
  private source: string;
  private isMdx: boolean;
  private nodes: Node[] = [];
  private nodeIds = new NodeIdAllocator();
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private lines: string[] = [];
  private slugger = new HeadingSlugger();
  private stack: Section[] = [];
  private filePreamble: string[] = [];
  private referenceDefinitions = new Map<string, string>();
  private emitted = new Set<string>();
  private fileNode!: Node;

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
    this.isMdx = filePath.toLowerCase().endsWith('.mdx');
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      this.lines = this.source.split(/\r?\n/);
      this.fileNode = this.createFileNode();
      this.collectReferenceDefinitions();
      this.scan();
    } catch (error) {
      this.errors.push({
        message: `Markdown extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private createFileNode(): Node {
    const node: Node = {
      id: generateNodeId(this.filePath, 'file', this.filePath, 1),
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'markdown',
      startLine: 1,
      endLine: this.lines.length,
      startColumn: 0,
      endColumn: this.lines[this.lines.length - 1]?.length || 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  /** `[label]: target` definitions apply document-wide, before or after use. */
  private collectReferenceDefinitions(): void {
    let fence: string | null = null;
    for (const line of this.lines) {
      const open = FENCE_OPEN.exec(line);
      if (fence) {
        if (open && open[2]!.startsWith(fence) && open[3]!.trim() === '') fence = null;
        continue;
      }
      if (open && !(open[2]![0] === '`' && open[3]!.includes('`'))) {
        fence = open[2]!;
        continue;
      }
      const def = REFERENCE_DEFINITION.exec(line);
      if (def) {
        const label = normalizeLabel(def[1]!);
        if (!this.referenceDefinitions.has(label)) this.referenceDefinitions.set(label, def[2]!);
      }
    }
  }

  private scan(): void {
    const lines = this.lines;
    let i = 0;

    if (lines[0] === '---' || lines[0] === '+++') {
      const close = lines[0];
      for (let j = 1; j < lines.length; j++) {
        if (lines[j] === close || (close === '---' && lines[j] === '...')) {
          i = j + 1;
          break;
        }
      }
    }

    let inComment = false;
    for (; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNo = i + 1;

      if (inComment) {
        if (line.includes('-->')) inComment = false;
        continue;
      }
      if (/^\s*<!--/.test(line) && !line.includes('-->')) {
        inComment = true;
        continue;
      }

      const fence = FENCE_OPEN.exec(line);
      if (fence && !(fence[2]![0] === '`' && fence[3]!.includes('`'))) {
        i = this.consumeFence(i, fence[2]!, fence[3]!);
        continue;
      }

      const atx = ATX_HEADING.exec(line);
      if (atx) {
        const text = (atx[2] ?? '').trim();
        if (text) this.openHeading(atx[1]!.length, text, lineNo, line);
        continue;
      }

      const underline = this.setextUnderlineOf(i);
      if (underline > i) {
        const level = lines[underline]!.trim().startsWith('=') ? 1 : 2;
        const text = lines.slice(i, underline).map((l) => l.trim()).join(' ');
        this.openHeading(level, text, lineNo, lines[underline - 1]!);
        i = underline;
        continue;
      }

      if (REFERENCE_DEFINITION.test(line)) continue;

      if (this.isMdx) {
        const mdxImport = MDX_IMPORT.exec(line.trim());
        if (mdxImport) {
          this.emitMdxImport(mdxImport[1]!, lineNo, line.indexOf(mdxImport[1]!));
          continue;
        }
        if (/^export\s/.test(line)) continue;
      }

      this.processDefinedTerm(line, lineNo);
      this.processInline(line, lineNo, this.currentOwnerId());
      this.recordProse(line);
    }

    const last = this.lastContentLine(lines.length);
    while (this.stack.length > 0) this.closeSection(last);
    this.fileNode.docstring = summarize(this.filePreamble.join(' ')) || undefined;
  }

  /**
   * When a plain paragraph STARTS at line `index` and ends in a setext
   * underline, the underline's index — the whole paragraph is the heading, as
   * CommonMark reads it. Otherwise -1. A line after a list item is that item's
   * lazy continuation, not a paragraph start, so a `---` under it stays a
   * thematic break closing the list.
   */
  private setextUnderlineOf(index: number): number {
    const prev = this.lines[index - 1];
    const startsBlock = prev === undefined || !prev.trim() || ATX_HEADING.test(prev)
      || THEMATIC_BREAK.test(prev) || SETEXT_UNDERLINE.test(prev) || FENCE_OPEN.test(prev);
    if (!startsBlock) return -1;
    let j = index;
    while (j < this.lines.length && !SETEXT_UNDERLINE.test(this.lines[j]!)
      && !FENCE_OPEN.test(this.lines[j]!) && this.isParagraphLine(this.lines[j]!)) j++;
    return j > index && j < this.lines.length && SETEXT_UNDERLINE.test(this.lines[j]!) ? j : -1;
  }

  private isParagraphLine(line: string): boolean {
    if (!line.trim() || /^ {4,}/.test(line)) return false;
    if (/^\s*(?:[-*+>]|\d{1,9}[.)])\s/.test(line) || /^\s*\|/.test(line) || /^\s*</.test(line)) return false;
    return !ATX_HEADING.test(line) && !THEMATIC_BREAK.test(line);
  }

  /** Read a fenced block; its call sites reference code from the current section. */
  private consumeFence(start: number, marker: string, info: string): number {
    const body: string[] = [];
    let end = start + 1;
    for (; end < this.lines.length; end++) {
      const close = FENCE_OPEN.exec(this.lines[end]!);
      if (close && close[2]![0] === marker[0] && close[2]!.length >= marker.length && close[3]!.trim() === '') break;
      body.push(this.lines[end]!);
    }
    const calls = findFenceCalls(info, body);
    if (calls) {
      const owner = this.currentOwnerId();
      for (const call of calls) {
        this.emitReference(owner, call.name, 'references', start + 2 + call.lineOffset, call.column);
      }
    }
    return end;
  }

  private currentOwnerId(): string {
    return this.stack[this.stack.length - 1]?.node.id ?? this.fileNode.id;
  }

  private openHeading(level: number, rawText: string, lineNo: number, line: string): void {
    const customId = /\s*\{#([\w-]+)\}\s*$/.exec(rawText);
    const text = customId ? rawText.slice(0, customId.index) : rawText;
    const name = stripInlineMarkdown(text);
    if (!name) return;

    const lastBefore = this.lastContentLine(lineNo - 1);
    while (this.stack.length > 0 && this.stack[this.stack.length - 1]!.level >= level) {
      this.closeSection(lastBefore);
    }

    const anchor = customId ? customId[1]! : this.slugger.next(name);
    const parentId = this.currentOwnerId();
    const node: Node = {
      id: this.nodeIds.generate(this.filePath, 'module', `${anchor}`, lineNo, 0),
      kind: 'module',
      name,
      qualifiedName: `${this.filePath}#${anchor}`,
      filePath: this.filePath,
      language: 'markdown',
      signature: `${'#'.repeat(level)} ${name}`,
      startLine: lineNo,
      endLine: lineNo,
      startColumn: 0,
      endColumn: line.length,
      isExported: true,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({ source: parentId, target: node.id, kind: 'contains' });
    this.stack.push({ node, level, prose: [] });
    this.processInline(text, lineNo, node.id, Math.max(0, line.indexOf(text)));
  }

  private closeSection(endLine: number): void {
    const section = this.stack.pop()!;
    section.node.endLine = Math.max(section.node.startLine, endLine);
    section.node.endColumn = this.lines[section.node.endLine - 1]?.length ?? 0;
    const summary = summarize(section.prose.join(' '));
    if (summary) section.node.docstring = summary;
  }

  /** The last non-blank line at or before `line` (1-based). */
  private lastContentLine(line: number): number {
    let n = line;
    while (n > 1 && !this.lines[n - 1]?.trim()) n--;
    return n;
  }

  private recordProse(line: string): void {
    if (/^\s*\|?\s*:?-{3,}/.test(line) || THEMATIC_BREAK.test(line)) return;
    const unprefixed = line.replace(LIST_OR_QUOTE_PREFIX, '');
    // A quoted heading is a title inside the quote, not a sentence of this section.
    if (ATX_HEADING.test(unprefixed)) return;
    const text = stripInlineMarkdown(unprefixed);
    if (!text) return;
    const target = this.stack[this.stack.length - 1]?.prose ?? this.filePreamble;
    if (target.join(' ').length < 1200) target.push(text);
  }

  /** `**Term**: definition` and `- **Term** — definition` declare a term. */
  private processDefinedTerm(line: string, lineNo: number): void {
    const m = DEFINED_TERM.exec(line);
    if (!m || (!m[2] && !m[3])) return;
    const term = stripInlineMarkdown(m[1]!).replace(/[:\s]+$/, '');
    const definition = stripInlineMarkdown(m[4]!);
    if (!term || !definition || term.split(/\s+/).length > 6 || /^[\d\W]+$/.test(term)) return;
    if (ADMONITION_WORDS.has(term.toLowerCase())) return;
    const owner = this.stack[this.stack.length - 1]?.node;
    const scope = owner ? owner.qualifiedName : this.filePath;
    const column = line.indexOf(m[1]!);
    const node: Node = {
      id: this.nodeIds.generate(this.filePath, 'constant', term, lineNo, column),
      kind: 'constant',
      name: term,
      qualifiedName: `${scope}::${term}`,
      filePath: this.filePath,
      language: 'markdown',
      docstring: summarize(definition, 1),
      startLine: lineNo,
      endLine: lineNo,
      startColumn: column,
      endColumn: line.length,
      isExported: true,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({ source: owner?.id ?? this.fileNode.id, target: node.id, kind: 'contains' });
  }

  /**
   * Every reference one line of prose makes: code spans first (the author
   * marked them as code), then links, then code-shaped words in what is left.
   */
  private processInline(text: string, lineNo: number, ownerId: string, offset = 0): void {
    const mask = (s: string, start: number, length: number): string =>
      s.slice(0, start) + ' '.repeat(length) + s.slice(start + length);
    let rest = text;

    for (const m of text.matchAll(CODE_SPAN)) {
      const entity = classifyCodeSpan(m[2]!);
      if (entity) this.emitReference(ownerId, pathOrSymbol(entity), 'references', lineNo, offset + m.index!);
      rest = mask(rest, m.index!, m[0].length);
    }

    for (const m of rest.matchAll(INLINE_LINK)) {
      // An image's alt text is not prose; a link's text is, its destination is not.
      if (m[1]) {
        rest = mask(rest, m.index!, m[0].length);
        continue;
      }
      this.emitLink(ownerId, m[3]!, lineNo, offset + m.index!);
      const destination = m[0].indexOf('](');
      rest = mask(rest, m.index! + destination, m[0].length - destination);
    }

    for (const m of rest.matchAll(WIKI_LINK)) {
      const page = m[1]?.trim();
      const target = page ? (path.posix.extname(page) ? page : `${page}.md`) : '';
      const anchor = m[2] ? `#${HeadingSlugger.slug(m[2].trim())}` : '';
      if (target) {
        this.emitReference(ownerId, `${target}${anchor}`, 'references', lineNo, offset + m.index!);
      } else if (anchor) {
        this.emitReference(ownerId, `${this.filePath}${anchor}`, 'references', lineNo, offset + m.index!);
      }
      rest = mask(rest, m.index!, m[0].length);
    }

    for (const m of rest.matchAll(REFERENCE_LINK)) {
      if (m[1]) continue;
      const label = normalizeLabel(m[3] ? m[3] : m[2]!);
      const target = this.referenceDefinitions.get(label);
      if (target) this.emitLink(ownerId, target, lineNo, offset + m.index!);
    }

    for (const m of rest.matchAll(HTML_HREF)) {
      this.emitLink(ownerId, m[1]!, lineNo, offset + m.index!);
      rest = mask(rest, m.index!, m[0].length);
    }
    rest = rest.replace(AUTOLINK, (s) => ' '.repeat(s.length));
    rest = rest.replace(/<\/?[A-Za-z][^>]*>/g, (s) => ' '.repeat(s.length));

    if (this.isMdx) {
      for (const m of text.matchAll(JSX_COMPONENT)) {
        this.emitReference(ownerId, m[1]!.replace(/\./g, '::'), 'references', lineNo, offset + m.index! + 1);
      }
    }

    for (const entity of findProseEntities(rest)) {
      this.emitReference(ownerId, pathOrSymbol(entity), 'references', lineNo, offset + entity.column);
    }
  }

  private emitLink(ownerId: string, rawTarget: string, lineNo: number, column: number): void {
    const target = this.linkTarget(rawTarget);
    if (target) this.emitReference(ownerId, target, 'references', lineNo, column);
  }

  /**
   * A link destination as a project-relative reference name: `<path>`,
   * `<path>#<anchor>` for a heading in another document, or `<path>#L<n>` for
   * a line of a source file. External URLs, links that leave the project and a
   * document's link to itself without an anchor name nothing to index.
   */
  private linkTarget(raw: string): string | null {
    let target = raw.trim().replace(/^<(.*)>$/, '$1');
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null;

    let fragment = '';
    const hash = target.indexOf('#');
    if (hash >= 0) {
      fragment = target.slice(hash + 1);
      target = target.slice(0, hash);
    }
    target = target.replace(/\?.*$/, '');
    try {
      target = decodeURI(target);
    } catch {
      // keep the raw spelling
    }

    let resolved = this.filePath;
    if (target) {
      const joined = target.startsWith('/')
        ? target.slice(1)
        : path.posix.join(path.posix.dirname(this.filePath), target);
      resolved = path.posix.normalize(joined).replace(/\/+$/, '');
      if (!resolved || resolved === '.' || resolved === '..' || resolved.startsWith('../')) return null;
    }

    if (fragment) {
      const line = /^L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/.exec(fragment);
      if (line) return `${resolved}#L${line[1]}`;
      if (isMarkdownPath(resolved)) {
        let anchor = fragment;
        try {
          anchor = decodeURIComponent(fragment);
        } catch {
          // keep the raw spelling
        }
        return `${resolved}#${anchor.toLowerCase()}`;
      }
    }
    if (resolved === this.filePath) return null;
    return /[./]/.test(resolved) ? resolved : `./${resolved}`;
  }

  private emitMdxImport(specifier: string, lineNo: number, column: number): void {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) return;
    const joined = specifier.startsWith('/')
      ? specifier.slice(1)
      : path.posix.join(path.posix.dirname(this.filePath), specifier);
    const resolved = path.posix.normalize(joined);
    if (resolved.startsWith('../')) return;
    this.emitReference(this.fileNode.id, /[./]/.test(resolved) ? resolved : `./${resolved}`, 'imports', lineNo, Math.max(0, column));
  }

  private emitReference(fromNodeId: string, referenceName: string, referenceKind: ReferenceKind, line: number, column: number): void {
    const key = `${fromNodeId}\0${referenceKind}\0${referenceName}`;
    if (this.emitted.has(key)) return;
    this.emitted.add(key);
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName,
      referenceKind,
      line,
      column,
      filePath: this.filePath,
      language: 'markdown',
    });
  }
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isMarkdownPath(p: string): boolean {
  return /\.(?:md|mdx|markdown)$/i.test(p);
}

/** Paths always carry `/`, `.` or `#`; a bare root file gets `./` so it still does. */
function pathOrSymbol(entity: { type: 'symbol' | 'path'; name: string }): string {
  if (entity.type === 'symbol') return entity.name;
  return /[./#]/.test(entity.name) ? entity.name : `./${entity.name}`;
}
