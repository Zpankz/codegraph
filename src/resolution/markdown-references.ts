/**
 * What a Markdown document's references point at.
 *
 * The Markdown extractor names two things (see `extraction/markdown-entities`):
 * PATHS — a file, `<file>#<anchor>` for a heading of a document, `<file>#L<n>`
 * for a line of a source file — and SYMBOLS, `::`-joined identifiers taken
 * from code spans, code-shaped prose and fenced examples. A symbol never holds
 * `/`, `.` or `#`, so the spelling alone says which one a reference is.
 *
 * Prose is not code: nothing in it is imported or in scope, so the generic
 * strategies — import resolution, receiver inference, fuzzy matching — would
 * only guess. Every Markdown reference is decided here, and an ambiguous name
 * stays unresolved: a missing documentation link costs nothing, a wrong one
 * tells the agent the doc describes code it does not.
 */
import * as path from 'path';
import type { Node } from '../types';
import { isTestPath } from '../search/query-utils';
import type { ResolvedRef, ResolutionContext, UnresolvedRef } from './types';

/** Kinds a mention can mean, best first; anything else is never a target. */
const PRIMARY_KINDS = new Set<Node['kind']>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'type_alias', 'union',
  'function', 'method', 'component', 'route', 'namespace', 'module',
]);
const MEMBER_KINDS = new Set<Node['kind']>(['property', 'field', 'constant', 'variable', 'enum_member']);

/** Extensions tried, in order, for an extensionless path (MDX `import './Button'`). */
const IMPLICIT_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mdx', '.md', '.vue', '.svelte', '.astro', '.py', '.go', '.rs'];

/**
 * Resolve a reference made in a Markdown file. `undefined` for any other
 * language; otherwise the target, or `null` when nothing in the project is
 * unambiguously what the document names.
 */
export function matchMarkdownReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null | undefined {
  if ((ref.language as string) !== 'markdown') return undefined;
  const resolved = /[./#]/.test(ref.referenceName) ? matchPath(ref, context) : matchSymbol(ref, context);
  return resolved && resolved.targetNodeId !== ref.fromNodeId ? resolved : null;
}

function matchPath(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  let target = ref.referenceName;
  let fragment = '';
  const hash = target.indexOf('#');
  if (hash >= 0) {
    fragment = target.slice(hash + 1);
    target = target.slice(0, hash);
  }
  target = target.replace(/^\.\//, '');

  const found = findFile(target, ref, context);
  if (!found) return null;
  const { file, confidence } = found;

  if (fragment) {
    const line = /^L(\d+)$/.exec(fragment);
    if (line) {
      const enclosing = innermostAt(context.getNodesInFile(file.filePath), Number(line[1]));
      if (enclosing) return { original: ref, targetNodeId: enclosing.id, confidence, resolvedBy: 'file-path' };
    } else {
      const heading = context
        .getNodesByQualifiedName(`${file.filePath}#${fragment}`)
        .find((n) => n.filePath === file.filePath);
      if (heading) return { original: ref, targetNodeId: heading.id, confidence, resolvedBy: 'file-path' };
    }
  }
  return { original: ref, targetNodeId: file.id, confidence, resolvedBy: 'file-path' };
}

/**
 * The file node a path names: exactly, then with an implicit extension or as a
 * directory's index / README, then — for a path written relative to somewhere
 * else (`mcp/tools.ts` for `src/mcp/tools.ts`) — the ONE file whose path ends
 * with it.
 */
function findFile(target: string, ref: UnresolvedRef, context: ResolutionContext): { file: Node; confidence: number } | null {
  if (!target) return null;
  const exact = fileNode(target, context);
  if (exact) return { file: exact, confidence: 0.95 };

  // A link is relative to its document, but authors routinely write paths
  // from the repository root (`src/x.ts` in `docs/guide.md`).
  const docDir = path.posix.dirname(ref.filePath);
  if (docDir !== '.' && target.startsWith(`${docDir}/`)) {
    const rootRelative = fileNode(target.slice(docDir.length + 1), context);
    if (rootRelative) return { file: rootRelative, confidence: 0.85 };
  }

  if (!path.posix.extname(target) || ref.referenceKind === 'imports') {
    const variants = [
      ...IMPLICIT_EXTENSIONS.map((ext) => `${target}${ext}`),
      ...IMPLICIT_EXTENSIONS.map((ext) => `${target}/index${ext}`),
      `${target}/README.md`,
    ];
    for (const variant of variants) {
      const file = fileNode(variant, context);
      if (file) return { file, confidence: 0.9 };
    }
  }

  const base = target.slice(target.lastIndexOf('/') + 1);
  if (!path.posix.extname(base)) return null;
  const suffix = `/${target}`;
  const matches = context
    .getNodesByName(base)
    .filter((n) => n.kind === 'file' && (n.filePath === target || n.filePath.endsWith(suffix)));
  return matches.length === 1 ? { file: matches[0]!, confidence: 0.8 } : null;
}

function fileNode(filePath: string, context: ResolutionContext): Node | undefined {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  return context.getNodesByName(base).find((n) => n.kind === 'file' && n.filePath === filePath);
}

/** The smallest symbol whose span holds `line`, or the file itself. */
function innermostAt(nodes: Node[], line: number): Node | undefined {
  const span = (n: Node): number => n.endLine - n.startLine;
  let best: Node | undefined;
  for (const n of nodes) {
    if (n.kind === 'import' || n.kind === 'export' || n.kind === 'parameter') continue;
    if (n.startLine > line || n.endLine < line) continue;
    if (!best || span(n) < span(best) || (span(n) === span(best) && best.kind === 'file')) best = n;
  }
  return best;
}

/**
 * A code entity named in prose. `Type::member` must match the end of a
 * qualified name (or, for `module::fn`, a file named after the module); a bare
 * name must be ONE definition among the best kind tier, after setting tests
 * aside. Documentation never resolves to documentation by name.
 */
function matchSymbol(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const segments = ref.referenceName.split('::');
  const tail = segments[segments.length - 1]!;
  if (!tail) return null;

  let candidates = context
    .getNodesByName(tail)
    .filter((n) => (n.language as string) !== 'markdown' && (PRIMARY_KINDS.has(n.kind) || MEMBER_KINDS.has(n.kind)));
  if (candidates.length === 0) return null;

  let qualified = segments.length > 1;
  if (qualified) {
    const suffix = `::${ref.referenceName}`;
    const owner = segments[segments.length - 2]!;
    const byName = candidates.filter((n) => n.qualifiedName === ref.referenceName || n.qualifiedName.endsWith(suffix));
    const byModule = candidates.filter((n) => path.posix.basename(n.filePath).replace(/\.[^.]+$/, '') === owner);
    if (byName.length > 0) candidates = byName;
    else if (byModule.length > 0) candidates = byModule;
    // `cg.searchNodes()` — a lowercase receiver is usually an instance, which
    // names no type: only the member name says anything, so it must stand alone.
    else if (segments.length === 2 && /^[a-z_$]/.test(segments[0]!)) qualified = false;
    else return null;
  }

  const primary = candidates.filter((n) => PRIMARY_KINDS.has(n.kind));
  let tier = primary.length > 0 ? primary : candidates;
  const nonTest = tier.filter((n) => !isTestPath(n.filePath));
  if (nonTest.length > 0) tier = nonTest;

  // Overload signatures and re-declarations of one symbol share a qualified
  // name in one file — that is still one definition.
  const distinct = new Map<string, Node>();
  for (const n of tier) {
    const key = `${n.filePath}\0${n.qualifiedName}`;
    const seen = distinct.get(key);
    if (!seen || n.startLine < seen.startLine) distinct.set(key, n);
  }
  if (distinct.size !== 1) return null;
  const target = [...distinct.values()][0]!;
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: qualified ? 0.9 : 0.75,
    resolvedBy: qualified ? 'qualified-name' : 'exact-match',
  };
}
