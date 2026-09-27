import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { INTERNAL_SHORTHAND, MAX_PROSE_WORDS, countWords } from './tools/eslint-plugin/prose-rules.js';

const ROOT = resolve(import.meta.dirname);

// The same list Vale reads (scripts/check-prose.sh): every tracked Markdown
// and MDX file. The wasm build fetches third-party trees into vendor/ and
// build/; they are untracked, so neither check ever scans them. Tracked Version
// Plans are included, since `nx release` copies them into CHANGELOG.md.
const DOCUMENTS = execFileSync('git', ['ls-files', '-z', '*.md', '*.mdx'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .sort();

const isVersionPlan = (path: string): boolean => path.startsWith('.nx/version-plans/');

// The changelog renderer prefixes a plan's first paragraph with `- ` and
// appends the reference of the commit that added the plan, so that paragraph
// has less room than the ceiling alone suggests. Both reference shapes cost the
// same eight words: `#40`, `https`, `github`, `com`, `taucad`, `picovoxel`,
// `pull`, `40` against a short SHA, `https`, `github`, `com`, `taucad`,
// `picovoxel`, `commit` and that SHA again.
const PULL_REQUEST_REFERENCE = '([#40](https://github.com/taucad/picovoxel/pull/40))';
const COMMIT_REFERENCE = '([a39d388](https://github.com/taucad/picovoxel/commit/a39d388))';
const RENDERED_REFERENCE_WORDS = countWords(PULL_REQUEST_REFERENCE);

// Blanked rather than dropped so reported line numbers still point at the file.
const withoutFrontMatter = (markdown: string): string =>
  markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, (matched) => matched.replaceAll(/[^\n]/gu, ''));

type Block = { readonly line: number; readonly text: string };

const proseBlocks = (markdown: string): Block[] => {
  const blocks: Block[] = [];
  let current: string[] = [];
  let fenced = false;
  let start = 0;
  const flush = (): void => {
    const text = current.join(' ').trim();
    if (text) blocks.push({ line: start + 1, text });
    current = [];
  };

  for (const [index, raw] of markdown.split(/\r?\n/u).entries()) {
    const line = raw.replace(/^\s*>\s?/u, '');
    if (/^\s*(?:`{3,}|~{3,})/u.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^\s*(?:\||<|#)/u.test(line) || line.trim() === '') {
      flush();
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s/u.test(line)) flush();
    if (current.length === 0) start = index;
    current.push(line.trim());
  }
  flush();
  return blocks;
};

describe('prose quality', () => {
  // A release commit consumes every plan, so none may be pending; whichever are
  // tracked must all be scanned.
  it('should inspect repository prose, including every pending Version Plan', () => {
    const plans = execFileSync('git', ['ls-files', '-z', '.nx/version-plans'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((path) => path.endsWith('.md'))
      .sort();
    expect(DOCUMENTS).toContain('README.md');
    expect(DOCUMENTS.filter(isVersionPlan)).toEqual(plans);
  });

  it('should ignore both Markdown fence syntaxes', () => {
    expect(proseBlocks('```ts\nconst backtick = true;\n```\n~~~ts\nconst tilde = true;\n~~~')).toEqual([]);
  });

  it('should charge a Version Plan for the reference the changelog appends', () => {
    const paragraph = 'Add a lane option.';
    expect(countWords(`- ${paragraph} ${PULL_REQUEST_REFERENCE}`)).toBe(
      countWords(paragraph) + RENDERED_REFERENCE_WORDS,
    );
    expect(countWords(COMMIT_REFERENCE)).toBe(RENDERED_REFERENCE_WORDS);
  });

  it('should hold the Vale shorthand rule and the ESLint shorthand list to one set of patterns', () => {
    const vale = readFileSync(resolve(ROOT, '.vale/styles/Tau/InternalShorthand.yml'), 'utf8');
    expect(vale).toMatch(/^level: error$/mu);
    const tokens = [...vale.matchAll(/^ {2}- '(.+)'$/gmu)].map(([, token]) => token);
    expect(tokens).toEqual(INTERNAL_SHORTHAND.map((pattern) => pattern.source));
  });

  it('should read a Version Plan past its front matter without shifting line numbers', () => {
    expect(proseBlocks(withoutFrontMatter('---\npicovoxel: minor\n---\n\nAdd a lane option.'))).toEqual([
      { line: 5, text: 'Add a lane option.' },
    ]);
  });

  it.each(DOCUMENTS)('should keep every block in %s within the word ceiling', (path) => {
    const markdown = readFileSync(resolve(ROOT, path), 'utf8');
    const plan = isVersionPlan(path);
    const overhead = plan ? RENDERED_REFERENCE_WORDS : 0;
    const offenders = proseBlocks(plan ? withoutFrontMatter(markdown) : markdown)
      .map((block, index) => ({ block, words: countWords(block.text) + (index === 0 ? overhead : 0) }))
      .filter(({ words }) => words > MAX_PROSE_WORDS)
      .map(({ block, words }) => `${path}:${block.line} — ${words} words`);
    expect(offenders).toEqual([]);
  });
});
