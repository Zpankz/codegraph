/**
 * Markdown as an indexed language: the entity recognizer, the extractor, and
 * the whole pipeline — a document's links and code mentions resolving to the
 * code they name, without documentation changing what explore budgets, what
 * symbol lookup answers, or what dead code reports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { detectLanguage, isSourceFile, isLanguageSupported, hasTreeSitterGrammar } from '../src/extraction/grammars';
import {
  HeadingSlugger,
  classifyCodeSpan,
  findFenceCalls,
  findProseEntities,
  summarize,
} from '../src/extraction/markdown-entities';
import { findAllSymbols } from '../src/graph/named-symbol-flow';
import { buildDeadCodeReport } from '../src/graph/dead-code';
import { codeFileCount } from '../src/utils';
import type { Node } from '../src/types';

describe('Markdown language detection', () => {
  it('maps Markdown and MDX extensions to markdown', () => {
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('docs/page.mdx')).toBe('markdown');
    expect(detectLanguage('notes.markdown')).toBe('markdown');
    expect(isSourceFile('docs/guide.md')).toBe(true);
    expect(isLanguageSupported('markdown')).toBe(true);
    expect(hasTreeSitterGrammar('markdown')).toBe(false);
  });
});

describe('Markdown entity recognition', () => {
  it('classifies code spans as symbols, calls, members or paths', () => {
    expect(classifyCodeSpan('ReferenceResolver')).toEqual({ type: 'symbol', name: 'ReferenceResolver' });
    expect(classifyCodeSpan('ToolHandler.execute()')).toEqual({ type: 'symbol', name: 'ToolHandler::execute' });
    expect(classifyCodeSpan('cg.searchNodes(query, { limit: 5 })')).toEqual({ type: 'symbol', name: 'cg::searchNodes' });
    expect(classifyCodeSpan('Foo::bar')).toEqual({ type: 'symbol', name: 'Foo::bar' });
    expect(classifyCodeSpan('src/index.ts')).toEqual({ type: 'path', name: 'src/index.ts' });
    expect(classifyCodeSpan('tools.ts')).toEqual({ type: 'path', name: 'tools.ts' });
    expect(classifyCodeSpan('res.json')).toEqual({ type: 'symbol', name: 'res::json' });
  });

  it('ignores code spans that are commands, literals or keywords', () => {
    expect(classifyCodeSpan('npm run build')).toBeNull();
    expect(classifyCodeSpan('true')).toBeNull();
    expect(classifyCodeSpan('null')).toBeNull();
    expect(classifyCodeSpan('--force')).toBeNull();
    expect(classifyCodeSpan('{ "a": 1 }')).toBeNull();
    expect(classifyCodeSpan('https://example.com/x.ts')).toBeNull();
  });

  it('finds code-shaped words in prose and leaves English alone', () => {
    const names = (text: string) => findProseEntities(text).map((e) => e.name);
    expect(names('The ReferenceResolver calls getStats() and parse_file.')).toEqual([
      'ReferenceResolver', 'getStats', 'parse_file',
    ]);
    expect(names('Then ToolHandler.execute runs, see src/mcp/tools.ts for more.')).toEqual([
      'src/mcp/tools.ts', 'ToolHandler::execute',
    ]);
    expect(names('Built with JavaScript on GitHub, e.g. using Node.js and the API.')).toEqual([]);
    expect(names('This Is A Title With Capitalized Words.')).toEqual([]);
  });

  it('reads call sites out of fenced code, minus what the fence declares', () => {
    const calls = findFenceCalls('ts', [
      'const cg = await CodeGraph.open(root);',
      'cg.buildContext(task);',
      'function helper() { return 1; }',
      'if (ok) helper();',
    ])!.map((c) => c.name);
    expect(calls).toEqual(['CodeGraph::open', 'buildContext']);
    expect(findFenceCalls('bash', ['npm run build(1)'])).toBeNull();
  });

  it('summarizes a section by its opening sentences', () => {
    expect(summarize('First point, e.g. this one. Second point is here. Third is dropped.')).toBe(
      'First point, e.g. this one. Second point is here.',
    );
  });

  it('builds GitHub heading anchors, numbering duplicates', () => {
    const slugger = new HeadingSlugger();
    expect(slugger.next('Getting Started!')).toBe('getting-started');
    expect(slugger.next('Getting Started')).toBe('getting-started-1');
    expect(slugger.next('`codegraph_explore` API')).toBe('codegraph_explore-api');
  });
});

describe('Markdown extraction', () => {
  const source = [
    '---',
    'title: Guide',
    '---',
    '# Guide',
    '',
    'CodeGraph indexes code. The `ReferenceResolver` links names.',
    '',
    '## Search API {#search}',
    '',
    'See [tools](../src/mcp/tools.ts#L12), [the index](./index.md#setup) and [[Other Page#Some Heading]].',
    '',
    '- **Explore budget**: how many calls an agent gets.',
    '- **Note**: a remark, not a term.',
    '',
    '```ts',
    'const g = new Graph();',
    '```',
    '',
    'Setext Heading',
    '--------------',
    '',
    'Read [more][ref] or <https://example.com/x.ts>.',
    '',
    '[ref]: ./more.md',
  ].join('\n');
  const result = extractFromSource('docs/guide.md', source);
  const byName = (name: string) => result.nodes.find((n) => n.name === name)!;
  const refs = result.unresolvedReferences.map((r) => r.referenceName);

  it('emits a file node and a module per heading, nested by level', () => {
    expect(result.errors).toEqual([]);
    expect(result.nodes[0]).toMatchObject({ kind: 'file', language: 'markdown', filePath: 'docs/guide.md' });
    const guide = byName('Guide');
    const search = byName('Search API');
    const setext = byName('Setext Heading');
    expect(guide).toMatchObject({ kind: 'module', qualifiedName: 'docs/guide.md#guide', startLine: 4 });
    expect(search).toMatchObject({ kind: 'module', qualifiedName: 'docs/guide.md#search', signature: '## Search API' });
    expect(setext).toMatchObject({ qualifiedName: 'docs/guide.md#setext-heading', startLine: 19 });
    expect(search.endLine).toBe(17);
    const contains = result.edges.filter((e) => e.kind === 'contains');
    expect(contains).toContainEqual({ source: result.nodes[0]!.id, target: guide.id, kind: 'contains' });
    expect(contains).toContainEqual({ source: guide.id, target: search.id, kind: 'contains' });
    expect(contains).toContainEqual({ source: guide.id, target: setext.id, kind: 'contains' });
  });

  it('keeps a section summary as its docstring', () => {
    expect(byName('Guide').docstring).toBe('CodeGraph indexes code. The ReferenceResolver links names.');
  });

  it('declares defined terms, but not remarks', () => {
    expect(byName('Explore budget')).toMatchObject({
      kind: 'constant',
      qualifiedName: 'docs/guide.md#search::Explore budget',
      docstring: 'how many calls an agent gets.',
    });
    expect(result.nodes.find((n) => n.name === 'Note')).toBeUndefined();
  });

  it('turns links and code mentions into references', () => {
    expect(refs).toContain('ReferenceResolver');
    expect(refs).toContain('src/mcp/tools.ts#L12');
    expect(refs).toContain('docs/index.md#setup');
    expect(refs).toContain('Other Page.md#some-heading');
    expect(refs).toContain('docs/more.md');
    expect(refs).toContain('Graph');
    expect(refs.some((r) => r.includes('example.com'))).toBe(false);
    expect(refs.some((r) => r === 'Guide' || r === 'title')).toBe(false);
    for (const ref of result.unresolvedReferences) {
      expect(ref).toMatchObject({ language: 'markdown', filePath: 'docs/guide.md', referenceKind: 'references' });
    }
  });

  it('records MDX imports and JSX components', () => {
    const mdx = extractFromSource(
      'docs/page.mdx',
      "import { Button } from '../components/Button'\n\n# Page\n\n<Button kind=\"primary\" />\n",
    );
    expect(mdx.unresolvedReferences).toContainEqual(expect.objectContaining({
      referenceName: 'components/Button', referenceKind: 'imports',
    }));
    expect(mdx.unresolvedReferences).toContainEqual(expect.objectContaining({
      referenceName: 'Button', referenceKind: 'references',
    }));
  });
});

describe('Markdown through the pipeline', () => {
  let root: string;
  let cg: CodeGraph;

  const FILES: Record<string, string> = {
    'src/resolver.ts': [
      'export class ReferenceResolver {',
      '  resolveOne(name: string): string {',
      '    return name;',
      '  }',
      '}',
      '',
      'export function runResolution(): void {',
      '  new ReferenceResolver().resolveOne("x");',
      '}',
    ].join('\n'),
    'src/helpers.ts': [
      'function forgottenHelper(): number {',
      '  return 1;',
      '}',
      '',
      'export function render(): void {}',
    ].join('\n'),
    'src/other.ts': 'export function render(): void {}\n',
    'README.md': [
      '# Project',
      '',
      'Start at `ReferenceResolver.resolveOne`, or read the [guide](docs/guide.md#resolution).',
      'The `forgottenHelper` is described here but never called.',
      'Calling `render()` is ambiguous, so it links nowhere.',
      '',
      '## ReferenceResolver',
      '',
      'Documents the class.',
    ].join('\n'),
    'docs/guide.md': [
      '# Guide',
      '',
      '## Resolution',
      '',
      'runResolution() drives it; see [the class](../src/resolver.ts#L2) and [home](../README.md).',
    ].join('\n'),
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-markdown-'));
    for (const [file, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const node = (name: string, filePath: string): Node =>
    cg.getNodesByName(name).find((n) => n.filePath === filePath)!;
  const targetsOf = (from: Node): Node[] =>
    cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!);

  it('indexes Markdown files as markdown', () => {
    const stats = cg.getStats();
    expect(stats.filesByLanguage.markdown).toBe(2);
    expect(codeFileCount(stats)).toBe(stats.fileCount - 2);
  });

  it('resolves a qualified code mention and a heading anchor across documents', () => {
    const project = node('Project', 'README.md');
    const targets = targetsOf(project).map((n) => `${n.filePath}:${n.name}`);
    expect(targets).toContain('src/resolver.ts:resolveOne');
    expect(targets).toContain('docs/guide.md:Resolution');
    expect(targets).toContain('src/helpers.ts:forgottenHelper');
    expect(targets.some((t) => t.endsWith(':render'))).toBe(false);
  });

  it('resolves prose calls, line links and links back to a document', () => {
    const resolution = node('Resolution', 'docs/guide.md');
    const targets = targetsOf(resolution).map((n) => `${n.filePath}:${n.kind}:${n.name}`);
    expect(targets).toContain('src/resolver.ts:function:runResolution');
    expect(targets).toContain('src/resolver.ts:method:resolveOne');
    expect(targets).toContain('README.md:file:README.md');
  });

  it('answers a symbol lookup with code, not the heading named after it', () => {
    const { nodes } = findAllSymbols(cg, 'ReferenceResolver');
    expect(nodes.map((n) => n.language)).toEqual(['typescript']);
  });

  it('does not let documentation keep dead code alive', () => {
    const report = buildDeadCodeReport(cg);
    expect(report.entries.map((e) => e.node.name)).toContain('forgottenHelper');
  });
});
