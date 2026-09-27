import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PACKAGE_FILES } from './scripts/package-files.mjs';

const ROOT = import.meta.dirname;
const REPOSITORY_URL =
  /^https:\/\/(?:github\.com\/taucad\/picovoxel\/(?:blob|tree|raw)|raw\.githubusercontent\.com\/taucad\/picovoxel)\/main\/(.*)$/u;

// The same list the prose checks read: every tracked Markdown and MDX file.
const TRACKED = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const TRACKED_FILES = new Set(TRACKED);
const DOCUMENTS = TRACKED.filter((path) => /\.mdx?$/u.test(path)).sort();
const PACKAGED = new Set<string>(PACKAGE_FILES);
const PACKAGED_DOCUMENTS = DOCUMENTS.filter((path) => PACKAGED.has(path));

const read = (path: string): string => readFileSync(posix.join(ROOT, path), 'utf8');

// Fenced blocks and inline code spans are examples, not links or headings.
const withoutFences = (markdown: string): string =>
  markdown.replaceAll(/^\s*(`{3,}|~{3,})[\s\S]*?^\s*\1/gmu, '');
const withoutCode = (markdown: string): string => withoutFences(markdown).replaceAll(/`[^`\n]*`/gu, '');

/** Every link and image target: inline `](target)`, reference definitions, and HTML src/href. */
const linkTargets = (markdown: string): string[] => {
  const text = withoutCode(markdown);
  return [
    ...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu),
    ...text.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gmu),
    ...text.matchAll(/\b(?:src|href)="([^"]+)"/gu),
  ].map((match) => match[1]!);
};

/** GitHub's heading anchors (github-slugger), plus explicit HTML ids, for one document. */
const anchors = (markdown: string): Set<string> => {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const [, heading] of withoutFences(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const base = heading!
      .toLowerCase()
      .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replaceAll(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, '')
      .replaceAll(' ', '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const [, id] of markdown.matchAll(/<a\s+(?:id|name)="([^"]+)"/gu)) result.add(id!);
  return result;
};

type Resolved = { readonly path: string; readonly anchor: string; readonly absolute: boolean };

/** Maps a target to a repository path, or null for an external URL this test cannot check. */
const resolveTarget = (document: string, target: string): Resolved | null => {
  const [location = '', anchor = ''] = target.split('#', 2);
  const repository = REPOSITORY_URL.exec(location);
  if (repository)
    return { path: decodeURIComponent(repository[1]!).replace(/\/$/u, ''), anchor, absolute: true };
  if (/^[a-z][a-z\d+.-]*:/iu.test(location)) return null;
  const path =
    location === ''
      ? document
      : posix.normalize(posix.join(posix.dirname(document), decodeURIComponent(location)));
  return { path, anchor, absolute: false };
};

const exists = (path: string): boolean =>
  TRACKED_FILES.has(path) || TRACKED.some((tracked) => tracked.startsWith(`${path}/`));

const deadLinks = (document: string): string[] =>
  linkTargets(read(document)).flatMap((target) => {
    const resolved = resolveTarget(document, target);
    if (!resolved) return [];
    if (resolved.path.startsWith('../') || !exists(resolved.path))
      return [`${target} (no tracked ${resolved.path})`];
    if (
      resolved.anchor &&
      /\.mdx?$/u.test(resolved.path) &&
      !anchors(read(resolved.path)).has(resolved.anchor)
    )
      return [`${target} (no heading #${resolved.anchor} in ${resolved.path})`];
    return [];
  });

// A document that ships in the tarball is also read from node_modules, where
// only packaged files exist: every other target must be an absolute URL.
const unpackagedLinks = (document: string): string[] =>
  linkTargets(read(document)).flatMap((target) => {
    const resolved = resolveTarget(document, target);
    return resolved && !resolved.absolute && !PACKAGED.has(resolved.path) ? [target] : [];
  });

describe('documentation links', () => {
  it('should read every tracked document and the packaged ones', () => {
    expect(DOCUMENTS).toContain('README.md');
    expect(PACKAGED_DOCUMENTS).toContain('README.md');
  });

  it('should find inline, reference and HTML targets outside code', () => {
    const markdown =
      '[a](x.md#y) ![b](i.svg "t") <img src="h.svg" />\n[r]: ref.md\n`[c](no.md)`\n```\n[d](no.md)\n```';
    expect(linkTargets(markdown).sort()).toEqual(['h.svg', 'i.svg', 'ref.md', 'x.md#y']);
  });

  it('should derive GitHub heading anchors', () => {
    const markdown =
      '# Browser and Node\n## `picovoxel/multi` entry\n## Browser and Node\n### I want to…\n<a id="custom"></a>';
    expect([...anchors(markdown)]).toEqual([
      'browser-and-node',
      'picovoxelmulti-entry',
      'browser-and-node-1',
      'i-want-to',
      'custom',
    ]);
  });

  it.each(DOCUMENTS)('should resolve every repository link in %s', (document) => {
    expect(deadLinks(document)).toEqual([]);
  });

  it.each(PACKAGED_DOCUMENTS)('should link %s only to packaged files or absolute URLs', (document) => {
    expect(unpackagedLinks(document)).toEqual([]);
  });
});
