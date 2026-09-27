import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const ci = read('.github/workflows/ci.yml');
const releasePr = read('.github/workflows/release-pr.yml');
const workflowFiles = readdirSync(join(root, '.github/workflows')).filter((name) => name.endsWith('.yml'));
const workflows = new Map(workflowFiles.map((name) => [name, read(`.github/workflows/${name}`)]));
const actions = new Map(
  readdirSync(join(root, '.github/actions')).map((name) => [
    name,
    read(`.github/actions/${name}/action.yml`),
  ]),
);

const byText = (left, right) => left.localeCompare(right);
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;
const indentation = (line) => line.length - line.trimStart().length;

/**
 * Split a workflow into its job blocks. Job ids are the only keys indented by
 * exactly two spaces after `jobs:`, so a line scan isolates each job without a
 * YAML parser the repository does not ship.
 */
const jobsOf = (workflow) => {
  const lines = workflow.split('\n');
  const start = lines.indexOf('jobs:');
  assert.notEqual(start, -1, 'the workflow must declare a jobs mapping');
  const blocks = new Map();
  let current;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (header) {
      current = [];
      blocks.set(header[1], current);
      continue;
    }
    current?.push(line);
  }
  return new Map([...blocks].map(([name, body]) => [name, body.join('\n')]));
};

const ciJobs = jobsOf(ci);

const job = (name, jobs = ciJobs) => {
  const body = jobs.get(name);
  assert(body, `the workflow must declare a ${name} job`);
  return body;
};

const needsOf = (name) => {
  const body = job(name);
  const inline = /^ {4}needs:\s*\[([^\]]*)\]/mu.exec(body);
  if (inline) {
    return inline[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  const single = /^ {4}needs:\s*([A-Za-z0-9_-]+)\s*$/mu.exec(body);
  if (single) return [single[1]];
  const block = /^ {4}needs:\s*\n((?: {6,}.*\n)+)/mu.exec(body);
  if (!block) return [];
  return block[1]
    .split('\n')
    .map((line) => line.replace(/[\s[\],-]/gu, ''))
    .filter(Boolean);
};

/** Every `run: |` block of a workflow, dedented, keyed by its step name when it has one. */
const runBlocks = (workflow) => {
  const lines = workflow.split('\n');
  const blocks = [];
  for (const [index, line] of lines.entries()) {
    const run = /^(\s*)(?:- )?run: \|\s*$/u.exec(line);
    if (!run) continue;
    const keyIndent = indentation(line) + (line.trimStart().startsWith('- ') ? 2 : 0);
    const body = [];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== '' && indentation(next) <= keyIndent) break;
      body.push(next);
    }
    const width = Math.min(...body.filter((entry) => entry.trim() !== '').map(indentation));
    let name;
    for (let back = index; back >= 0; back -= 1) {
      const step = /^\s*- (?:name: (.+)|\w)/u.exec(lines[back]);
      if (step && indentation(lines[back]) <= keyIndent) {
        name = step[1]?.trim();
        break;
      }
    }
    blocks.push({
      name,
      script: `${body
        .map((entry) => entry.slice(width))
        .join('\n')
        .trimEnd()}\n`,
    });
  }
  return blocks;
};

/**
 * The steps of one job, each as its own YAML text with its name, id, `if` and
 * run script. Steps are the list items two spaces inside `steps:`, so a line
 * scan separates them without a YAML parser.
 */
const stepsOf = (body) => {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^ {4}steps:\s*$/u.test(line));
  assert.notEqual(start, -1, 'the job must declare steps');
  const steps = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentation(line) < 6) break;
    if (/^ {6}- /u.test(line)) steps.push([line]);
    else steps.at(-1)?.push(line);
  }
  return steps.map((lines) => {
    const text = lines.join('\n');
    const field = (key) => new RegExp(`^ {6}(?:- | {2})${key}: (.+)$`, 'mu').exec(text)?.[1];
    return { text, name: field('name'), id: field('id'), if: field('if'), run: runBlocks(text)[0]?.script };
  });
};

/** The one step of a job with this name or id. */
const step = (body, key) => {
  const matches = stepsOf(body).filter(({ name, id }) => name === key || id === key);
  assert.equal(matches.length, 1, `exactly one step must be named "${key}"`);
  return matches[0];
};

/** Parse a GITHUB_OUTPUT file, including `key<<DELIMITER` multi-line values. */
const parseOutput = (text) => {
  const output = {};
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heredoc = /^([\w-]+)<<(\w+)$/u.exec(line);
    if (heredoc) {
      const end = lines.indexOf(heredoc[2], index + 1);
      assert.notEqual(end, -1, `unterminated ${heredoc[1]} output`);
      output[heredoc[1]] = lines.slice(index + 1, end).join('\n');
      index = end;
      continue;
    }
    const pair = /^([\w-]+)=(.*)$/u.exec(line);
    if (pair) output[pair[1]] = pair[2];
  }
  return output;
};

const temporaryDirectories = [];
const temporaryDirectory = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'picovoxel-workflow-')));
  temporaryDirectories.push(directory);
  return directory;
};
after(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

const newRepository = () => {
  const directory = temporaryDirectory();
  git(directory, 'init', '--quiet', '--initial-branch=main');
  git(directory, 'config', 'user.name', 'Test');
  git(directory, 'config', 'user.email', 'test@example.invalid');
  git(directory, 'config', 'commit.gpgsign', 'false');
  git(directory, 'config', 'tag.gpgsign', 'false');
  return directory;
};

const commitAll = (cwd, subject) => {
  git(cwd, 'add', '--all');
  git(cwd, 'commit', '--quiet', '--allow-empty', '-m', subject);
  return git(cwd, 'rev-parse', 'HEAD');
};

/** Run a workflow script under bash with GitHub's step shell flags and collect its outputs. */
const runStep = (script, { cwd, env = {}, path = [] }) => {
  const output = join(temporaryDirectory(), 'output');
  writeFileSync(output, '');
  let status = 0;
  let stderr = '';
  try {
    execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        GITHUB_OUTPUT: output,
        PATH: [...path, process.env.PATH].join(':'),
      },
      stdio: 'pipe',
    });
  } catch (error) {
    status = error.status ?? 1;
    stderr = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  return { output: parseOutput(readFileSync(output, 'utf8')), status, stderr };
};

const builtins = new Set(builtinModules);

/** Module specifiers one file imports, read from its syntax tree. */
const specifiersOf = (file) => {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/** Package specifiers reachable from one script through its repository-relative imports. */
const packagesReachedBy = (script) => {
  const seen = new Set();
  const packages = new Set();
  const pending = [resolve(root, script)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith('node:') || builtins.has(specifier)) continue;
      if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
      else packages.add(specifier);
    }
  }
  return [...packages].sort(byText);
};

/** A job installs dependencies through the shared setup action or pnpm itself. */
const installsDependencies = (body) =>
  /^\s*- uses: \.\/\.github\/actions\/setup\s*$/mu.test(body) || body.includes('pnpm install');

const SAME_REPOSITORY_PULL_REQUEST =
  "if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository";

describe('CI workflow policy', () => {
  describe('supply chain', () => {
    it('pins every third-party action in every workflow and composite action to a commit SHA', () => {
      const sources = [...workflows.values(), ...actions.values()];
      const uses = sources.flatMap((source) => [...source.matchAll(/uses: (\S+)(.*)$/gmu)]);
      assert(uses.length > 0);
      for (const [, reference, comment] of uses) {
        if (reference.startsWith('./')) continue;
        assert.match(
          reference,
          /@[0-9a-f]{40}$/u,
          `${reference} must be pinned to a forty-character commit SHA`,
        );
        assert.match(
          comment,
          /^ # v\d+(?:\.\d+)*$/u,
          `${reference} must name its release in a # vX.Y.Z comment`,
        );
      }
    });

    it('never references a registry token', () => {
      const surfaces = [
        ...workflows.values(),
        ...actions.values(),
        read('package.json'),
        read('.npmrc'),
        ...readdirSync(join(root, 'scripts')).map((name) => read(`scripts/${name}`)),
      ];
      for (const source of surfaces) {
        assert(!source.includes('NPM_TOKEN'), 'no workflow or script may reference NPM_TOKEN');
        assert(!source.includes('NODE_AUTH_TOKEN'), 'no workflow or script may reference NODE_AUTH_TOKEN');
        assert(!source.includes('_authToken'), 'no registry credential may be configured in the repository');
      }
    });

    it('grants OIDC in ci.yml to the publish job alone', () => {
      assert.equal(occurrences(ci, 'id-token: write'), 1);
      assert(job('publish').includes('id-token: write'));
      assert.equal(occurrences(releasePr, 'id-token'), 0);
      // The only other OIDC grant is the Claude action's own token exchange. npm's
      // Trusted Publisher binds ci.yml by file name, so no other workflow can publish.
      const others = [...workflows]
        .filter(([name, source]) => name !== 'ci.yml' && source.includes('id-token: write'))
        .map(([name]) => name);
      assert.deepEqual(others, ['claude.yml']);
    });

    it('keeps the default token read-only and checks out without persisting it', () => {
      assert.match(ci, /^permissions:\n {2}contents: read\n/mu);
      assert.equal(occurrences(ci, 'persist-credentials: false'), occurrences(ci, 'uses: actions/checkout@'));
      assert.equal(occurrences(ci, 'contents: write'), 1);
      assert(job('registry-verify').includes('contents: write'));
    });

    it('runs publish, alone, in the main-only npm-publish environment', () => {
      const environments = [...ciJobs].filter(([, body]) => /^ {4}environment:/mu.test(body));
      assert.deepEqual(
        environments.map(([name]) => name),
        ['publish'],
      );
      assert.match(job('publish'), /^ {4}environment: npm-publish$/mu);
    });

    it('never lets a newer run cancel a queued main or manual run, and serializes publication', () => {
      assert.match(
        ci,
        /^concurrency:\n {2}group: \$\{\{ github\.event_name == 'pull_request' && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| format\('run-\{0\}', github\.run_id\) \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/mu,
      );
      assert.match(
        job('publish'),
        /^ {4}concurrency:\n {6}group: npm-publish\n {6}cancel-in-progress: false$/mu,
      );
      assert.equal(occurrences(ci, 'concurrency:'), 2);
    });

    it('runs only dependency-free scripts in the jobs that install nothing', () => {
      // A job that installs no dependencies proves what a consumer gets, not
      // what this checkout builds, so every script it runs must resolve from
      // Node builtins and repository files alone.
      const dependencyFree = [...ciJobs]
        .filter(([, body]) => !installsDependencies(body))
        .map(([name, body]) => [
          name,
          [...new Set([...body.matchAll(/\bnode (scripts\/[\w./-]+\.mjs)\b/gu)].map((match) => match[1]))],
        ])
        .filter(([, scripts]) => scripts.length > 0);
      assert.deepEqual(Object.fromEntries(dependencyFree), {
        consumer: ['scripts/test-package.mjs'],
        preflight: ['scripts/ci-release.mjs'],
        'preview-consumer': ['scripts/extract-candidate-packages.mjs', 'scripts/verify-preview-install.mjs'],
        'registry-verify': ['scripts/registry-wait.mjs', 'scripts/verify-release-attestations.mjs'],
        wasm: ['scripts/parse-abi.mjs', 'scripts/wasm-manifest.mjs'],
      });
      // release-pr.yml's propose job runs the release policy with the bot
      // credentials present and nothing installed.
      for (const [name, scripts] of [...dependencyFree, ['propose', ['scripts/ci-release.mjs']]]) {
        for (const script of scripts) {
          assert.deepEqual(
            packagesReachedBy(script),
            [],
            `${name} installs nothing, so ${script} must import no package`,
          );
        }
      }
    });
  });

  describe('build once', () => {
    const buildSteps = [
      'pnpm run build',
      'tsdown',
      'npm pack',
      'build-wasm',
      'emcc',
      'build-pico',
      'fetch-deps',
    ];

    it('builds wasm only in the wasm job and packs only in the candidate job', () => {
      const building = [...ciJobs].filter(([, body]) => body.includes('uses: ./.github/actions/build-wasm'));
      // coverage-cpp builds an instrumented module for its own measurement;
      // only the wasm job's build reaches an artifact.
      assert.deepEqual(
        building.map(([name]) => name),
        ['wasm', 'coverage-cpp'],
      );
      assert.match(
        job('coverage-cpp'),
        /build-wasm\n {8}with:\n {10}variant: serial\n {10}coverage: 'true'\n/u,
      );
      const uploads = stepsOf(job('coverage-cpp'))
        .filter(({ text }) => text.includes('uses: actions/upload-artifact@'))
        .map(({ text }) => /name: (\S+)/u.exec(text)[1]);
      assert.deepEqual(uploads, ['lcov-cpp']);
      const packing = [...ciJobs].filter(([, body]) => body.includes('npm pack'));
      assert.deepEqual(
        packing.map(([name]) => name),
        ['candidate'],
      );
    });

    it('never rebuilds in the consumer, test, preview or publication jobs', () => {
      for (const name of [
        'test-unit',
        'test-subjects',
        'coverage',
        'consumer',
        'browser',
        'preview',
        'preview-consumer',
        'publish',
        'registry-verify',
      ]) {
        for (const buildStep of buildSteps) {
          assert(!job(name).includes(buildStep), `${name} must not run ${buildStep}`);
        }
      }
    });

    it('installs nothing in the consumer and publication jobs', () => {
      for (const name of ['consumer', 'preview-consumer', 'publish', 'registry-verify']) {
        assert(!installsDependencies(job(name)), `${name} must not install the repository's dependencies`);
      }
    });
  });

  describe('release derivation', () => {
    it('derives the release kind once, in preflight, from the full history', () => {
      const body = job('preflight');
      assert(body.includes('fetch-depth: 0'));
      assert.equal(occurrences(ci, 'node scripts/ci-release.mjs'), 1);
      for (const flag of [
        '--event',
        '--ref',
        '--sha',
        '--package-version',
        '--subject',
        '--changed-files-file',
        '--deleted-files-file',
        '--base-package-json-file',
        '--package-json-file',
        '--head-ref',
        '--head-repository',
        '--repository',
      ]) {
        assert(body.includes(`${flag} `), `ci-release.mjs must receive ${flag}`);
      }
      assert(body.includes('SOURCE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}'));
      assert(body.includes('npm-publish: ${{ steps.release.outputs.npm_publish }}'));
    });

    it('requires a Version Plan outside release runs, through the shipped-surface filter', () => {
      const planStep = step(job('quality'), 'Require a Version Plan for release-affecting changes');
      assert(job('quality').includes('fetch-depth: 0'));
      assert.equal(
        planStep.if,
        "needs.preflight.outputs.kind != 'release-pull-request' && needs.preflight.outputs.kind != 'release'",
      );
      assert(planStep.run.includes('node scripts/plan-check.mjs --base="origin/$BASE_REF" --head=HEAD'));
      assert(planStep.run.includes('node scripts/plan-check.mjs --base="$BEFORE_SHA" --head=HEAD'));
      assert(!ci.includes('nx release plan:check'), 'the plan check runs only through plan-check.mjs');
      assert(needsOf('quality').includes('preflight'));
    });

    describe('the preflight script', () => {
      const script = step(job('preflight'), 'release').run;
      const repository = (() => {
        const directory = newRepository();
        mkdirSync(join(directory, 'scripts'));
        cpSync(join(root, 'scripts/ci-release.mjs'), join(directory, 'scripts/ci-release.mjs'));
        mkdirSync(join(directory, '.nx/version-plans'), { recursive: true });
        writeFileSync(
          join(directory, '.nx/version-plans/first.md'),
          '---\npicovoxel: minor\n---\n\nFirst release.\n',
        );
        writeFileSync(join(directory, 'package.json'), '{ "name": "picovoxel", "version": "0.0.0" }\n');
        writeFileSync(join(directory, 'CHANGELOG.md'), '# Changelog\n');
        const base = commitAll(directory, 'feat(api): add the API');
        git(directory, 'update-ref', 'refs/remotes/origin/main', base);
        writeFileSync(join(directory, 'src.ts'), 'export {};\n');
        const ordinary = commitAll(directory, 'fix(mesh): an ordinary change');
        git(directory, 'checkout', '--quiet', '-b', 'release/next', base);
        rmSync(join(directory, '.nx/version-plans/first.md'));
        writeFileSync(join(directory, 'package.json'), '{ "name": "picovoxel", "version": "0.1.0" }\n');
        writeFileSync(
          join(directory, 'CHANGELOG.md'),
          '# Changelog\n\n## 0.1.0 (2026-09-28)\n\n- First release.\n',
        );
        const release = commitAll(directory, 'chore(release): picovoxel v0.1.0 (#14)');
        git(directory, 'checkout', '--quiet', '-b', 'widened', base);
        rmSync(join(directory, '.nx/version-plans/first.md'));
        writeFileSync(
          join(directory, 'package.json'),
          '{ "name": "picovoxel", "version": "0.1.0", "dependencies": { "leftpad": "1.0.0" } }\n',
        );
        writeFileSync(
          join(directory, 'CHANGELOG.md'),
          '# Changelog\n\n## 0.1.0 (2026-09-28)\n\n- First release.\n',
        );
        const widened = commitAll(directory, 'chore(release): picovoxel v0.1.0');
        return { base, directory, ordinary, release, widened };
      })();

      const derive = ({ event, ref, sha, headRef = 'release/next', headRepository = 'taucad/picovoxel' }) => {
        git(repository.directory, 'checkout', '--quiet', '--detach', sha);
        const pullRequest = event === 'pull_request';
        return runStep(script, {
          cwd: repository.directory,
          env: {
            BASE_REF: pullRequest ? 'main' : '',
            EVENT_NAME: event,
            HEAD_REF: pullRequest ? headRef : '',
            HEAD_REPOSITORY: pullRequest ? headRepository : '',
            REF_NAME: ref,
            REPOSITORY: 'taucad/picovoxel',
            SOURCE_SHA: sha,
          },
        });
      };

      it('publishes the release commit pushed to main', () => {
        const { output, status, stderr } = derive({
          event: 'push',
          ref: 'refs/heads/main',
          sha: repository.release,
        });
        assert.equal(status, 0, stderr);
        assert.deepEqual(output, {
          kind: 'release',
          npm_publish: 'true',
          release_tag: 'v0.1.0',
          version: '0.1.0',
        });
      });

      it('does not publish an ordinary main commit', () => {
        const { output } = derive({ event: 'push', ref: 'refs/heads/main', sha: repository.ordinary });
        assert.deepEqual(output, { kind: 'main', npm_publish: 'false', version: '0.0.0' });
      });

      it('does not publish a pull request, the release pull request included', () => {
        const ordinary = derive({
          event: 'pull_request',
          ref: 'refs/pull/13/merge',
          sha: repository.ordinary,
          headRef: 'topic',
        });
        assert.deepEqual(ordinary.output, { kind: 'pull-request', npm_publish: 'false', version: '0.0.0' });
        const release = derive({ event: 'pull_request', ref: 'refs/pull/14/merge', sha: repository.release });
        assert.deepEqual(release.output, {
          kind: 'release-pull-request',
          npm_publish: 'false',
          version: '0.1.0',
        });
      });

      it('fails a release pull request from any branch but release/next, or from a fork', () => {
        for (const origin of [{ headRef: 'topic' }, { headRepository: 'attacker/picovoxel' }]) {
          const { status, stderr } = derive({
            event: 'pull_request',
            ref: 'refs/pull/15/merge',
            sha: repository.release,
            ...origin,
          });
          assert.equal(status, 1);
          assert.match(stderr, /a release pull request must come from release\/next/u);
        }
      });

      it('fails a release commit whose manifest changes more than the version', () => {
        for (const event of ['push', 'pull_request']) {
          const { status, stderr } = derive({ event, ref: 'refs/heads/main', sha: repository.widened });
          assert.equal(status, 1);
          assert.match(stderr, /may change only the package\.json version; it changes dependencies/u);
        }
      });

      it('does not publish a manual run of the release commit', () => {
        const { output } = derive({
          event: 'workflow_dispatch',
          ref: 'refs/heads/main',
          sha: repository.release,
        });
        assert.deepEqual(output, { kind: 'dispatch', npm_publish: 'false', version: '0.1.0' });
      });

      it('fails the run on a release commit pushed anywhere but main', () => {
        const { status, stderr } = derive({
          event: 'push',
          ref: 'refs/heads/release/next',
          sha: repository.release,
        });
        assert.equal(status, 1);
        assert.match(stderr, /publication source must be protected main/u);
      });
    });
  });

  describe('publication', () => {
    it('publishes only from a main push that preflight derived as a release', () => {
      const body = job('publish');
      assert.match(
        body,
        /^ {4}if: needs\.preflight\.outputs\.npm-publish == 'true' && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/mu,
      );
      assert(!body.includes('always()'), 'every job publish needs must have succeeded');
      for (const dependency of [
        'preflight',
        'candidate',
        'test-unit',
        'test-subjects',
        'coverage',
        'consumer',
        'browser',
        'security',
      ]) {
        assert(needsOf('publish').includes(dependency), `publish must need ${dependency}`);
      }
    });

    it('downloads the candidate without a checkout or a build', () => {
      const steps = stepsOf(job('publish'));
      assert.deepEqual(
        steps.map(({ name, text }) => name ?? /uses: ([\w/-]+)@/u.exec(text)?.[1]),
        ['actions/download-artifact', 'actions/setup-node', 'Publish the exact candidate with provenance'],
      );
      assert.equal(
        occurrences(ci, 'uses: actions/download-artifact@'),
        1,
        'only publish, which has no checkout, bypasses the verified download',
      );
      assert(steps[0].text.includes('name: npm-candidate'));
      assert(steps[1].text.includes('registry-url: https://registry.npmjs.org'));
      assert.equal(occurrences(ci, 'npm publish'), 1);
    });

    describe('the publish script', () => {
      const script = step(job('publish'), 'Publish the exact candidate with provenance').run;
      const tarball = Buffer.from('picovoxel 0.1.0 candidate bytes');
      const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;

      /**
       * Run the step against a candidate directory and a fake npm. `view` is
       * what `npm view … dist.integrity` does: print an integrity, print
       * nothing, or fail with an npm error code.
       */
      const publish = ({ bytes = tarball, packages, version = '0.1.0', view }) => {
        const directory = temporaryDirectory();
        mkdirSync(join(directory, 'candidate'));
        writeFileSync(join(directory, 'candidate/picovoxel-0.1.0.tgz'), bytes);
        writeFileSync(
          join(directory, 'candidate/manifest.json'),
          JSON.stringify({
            packages: packages ?? [
              { name: 'picovoxel', version: '0.1.0', filename: 'picovoxel-0.1.0.tgz', integrity },
            ],
            version: '0.1.0',
          }),
        );
        const bin = temporaryDirectory();
        const calls = join(bin, 'calls');
        writeFileSync(calls, '');
        writeFileSync(
          join(bin, 'npm'),
          [
            '#!/usr/bin/env bash',
            `echo "$*" >> '${calls}'`,
            'if [[ "$1" == view ]]; then',
            '  case "$FAKE_VIEW" in',
            '    code:*) echo "npm error code ${FAKE_VIEW#code:}" >&2; exit 1 ;;',
            '    *) printf "%s" "$FAKE_VIEW" ;;',
            '  esac',
            'fi',
            '',
          ].join('\n'),
        );
        chmodSync(join(bin, 'npm'), 0o755);
        const result = runStep(script, {
          cwd: directory,
          env: { FAKE_VIEW: view ?? 'code:E404', VERSION: version },
          path: [bin],
        });
        return { ...result, calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean) };
      };

      it('publishes a version the registry does not have, exactly once, with provenance', () => {
        const { calls, status, stderr } = publish({});
        assert.equal(status, 0, stderr);
        assert.deepEqual(calls, [
          'view picovoxel@0.1.0 dist.integrity',
          'publish ./candidate/picovoxel-0.1.0.tgz --access public --provenance',
        ]);
      });

      it('skips a version the registry already serves with the same bytes', () => {
        const { calls, status } = publish({ view: integrity });
        assert.equal(status, 0);
        assert.deepEqual(calls, ['view picovoxel@0.1.0 dist.integrity']);
      });

      it('fails, without publishing, on other registry bytes, a missing integrity or a registry error', () => {
        for (const view of ['sha512-other', '', 'code:ECONNREFUSED', 'code:E500', 'code:E403', 'code:E401']) {
          const { calls, status, stderr } = publish({ view });
          assert.equal(status, 1, `npm view "${view}" must fail the job`);
          assert(!calls.some((call) => call.startsWith('publish')), `npm view "${view}" must not publish`);
          assert.match(stderr, /::error::/u);
        }
      });

      it('fails before any registry call on bytes that are not the tested tarball', () => {
        const { calls, status, stderr } = publish({ bytes: Buffer.from('tampered') });
        assert.equal(status, 1);
        assert.match(stderr, /is not the tested tarball/u);
        assert.deepEqual(calls, []);
      });

      it('fails before any registry call on a candidate that is not the release version', () => {
        const { calls, status, stderr } = publish({ version: '0.2.0' });
        assert.equal(status, 1);
        assert.match(stderr, /candidate picovoxel is 0\.1\.0, but the release commit is 0\.2\.0/u);
        assert.deepEqual(calls, []);
      });

      it('fails on an empty candidate manifest', () => {
        const { calls, status, stderr } = publish({ packages: [] });
        assert.equal(status, 1);
        assert.match(stderr, /the candidate manifest lists no packages/u);
        assert.deepEqual(calls, []);
      });
    });

    it('verifies the registry artifact and its provenance before recording the release', () => {
      const body = job('registry-verify');
      assert(
        body.includes(
          "if: always() && needs.preflight.outputs.npm-publish == 'true' && needs.publish.result == 'success'",
        ),
      );
      assert(needsOf('registry-verify').includes('publish'));
      assert.deepEqual(
        stepsOf(body)
          .map(({ name }) => name)
          .filter(Boolean),
        [
          'Wait for the registry to serve the candidate with its attestation',
          'Verify registry bytes and provenance',
          'Record the verified release',
        ],
      );
      assert.equal(
        step(body, 'Wait for the registry to serve the candidate with its attestation')
          .text.trim()
          .split('\n')
          .at(-1)
          .trim(),
        'run: node scripts/registry-wait.mjs --manifest candidate/manifest.json --interval-seconds 30 --timeout-minutes 30',
      );
      const verify = step(body, 'Verify registry bytes and provenance').run;
      const order = [
        'npm install --ignore-scripts "${package_specs[@]}"',
        'npm audit signatures --json --include-attestations > /tmp/npm-audit-signatures.json',
        'node scripts/verify-release-attestations.mjs',
        "'${{ github.sha }}'",
        "'${{ github.run_id }}'",
      ];
      let last = -1;
      for (const command of order) {
        const index = verify.indexOf(command);
        assert(index > last, `registry-verify must run, in order: ${command}`);
        last = index;
      }
      assert(!body.includes('--force'), 'the consumer install must not override npm conflict checks');
      assert.equal(occurrences(ci, '|| gh release create'), 1);
      // npm's --include-attestations needs a current npm; Node 26 bundles one.
      assert(body.includes('node-version: ${{ env.NODE_LATEST }}'));
      assert.match(ci, /^ {2}NODE_LATEST: '26'$/mu);
    });

    describe('recording the release', () => {
      const record = step(job('registry-verify'), 'Record the verified release');

      /** A checkout whose origin holds `tags`, and a fake gh that knows `releases`. */
      const run = ({ tags = {}, annotated = false, releases = [], origin }) => {
        const remote = newRepository();
        const released = commitAll(remote, 'chore(release): picovoxel v0.1.0');
        const other = commitAll(remote, 'fix: later');
        for (const [tag, target] of Object.entries(tags)) {
          const sha = target === 'release' ? released : other;
          if (annotated) git(remote, 'tag', '-a', '-m', tag, tag, sha);
          else git(remote, 'tag', tag, sha);
        }
        const checkout = newRepository();
        git(checkout, 'remote', 'add', 'origin', origin ?? remote);
        const bin = temporaryDirectory();
        const calls = join(bin, 'calls');
        writeFileSync(calls, '');
        writeFileSync(
          join(bin, 'gh'),
          [
            '#!/usr/bin/env bash',
            `echo "$*" >> '${calls}'`,
            `if [[ "$1 $2" == "release view" ]]; then [[ " ${releases.join(' ')} " == *" $3 "* ]]; exit; fi`,
            '',
          ].join('\n'),
        );
        chmodSync(join(bin, 'gh'), 0o755);
        const result = runStep(record.run, {
          cwd: checkout,
          env: { SHA: released, VERSION: '0.1.0' },
          path: [bin],
        });
        return { ...result, released, calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean) };
      };

      it('creates the release and its tag at the release commit', () => {
        const { calls, released, status, stderr } = run({});
        assert.equal(status, 0, stderr);
        assert.deepEqual(calls, [
          'release view v0.1.0',
          `release create v0.1.0 --target ${released} --generate-notes`,
        ]);
      });

      it('accepts an existing tag, lightweight or annotated, only at the release commit', () => {
        for (const annotated of [false, true]) {
          const { calls, released, status, stderr } = run({ tags: { 'v0.1.0': 'release' }, annotated });
          assert.equal(status, 0, stderr);
          assert.deepEqual(calls, [
            'release view v0.1.0',
            `release create v0.1.0 --target ${released} --generate-notes`,
          ]);
          const later = run({ tags: { 'v0.1.0': 'other' }, annotated });
          assert.equal(later.status, 1);
          assert.match(later.stderr, /tag v0\.1\.0 points at [0-9a-f]{40}, not the release commit/u);
          assert.deepEqual(later.calls, []);
        }
      });

      it('leaves an existing release alone', () => {
        const { calls, status } = run({ tags: { 'v0.1.0': 'release' }, releases: ['v0.1.0'] });
        assert.equal(status, 0);
        assert.deepEqual(calls, ['release view v0.1.0']);
      });

      it('fails when the tags cannot be listed', () => {
        const { calls, status, stderr } = run({ origin: join(temporaryDirectory(), 'missing') });
        assert.equal(status, 1);
        assert.match(stderr, /could not list tag v0\.1\.0/u);
        assert.deepEqual(calls, []);
      });
    });

    it('binds verification to this repository and ci.yml on main', () => {
      const verifier = read('scripts/verify-release-attestations.mjs');
      assert(verifier.includes("const REPOSITORY = 'https://github.com/taucad/picovoxel';"));
      assert(verifier.includes("const WORKFLOW = '.github/workflows/ci.yml';"));
      assert(verifier.includes("const REF = 'refs/heads/main';"));
      assert(workflows.has('ci.yml'), 'the Trusted Publisher identity names ci.yml');
    });

    it('previews same-repository pull requests only, without OIDC', () => {
      for (const name of ['preview', 'preview-consumer']) {
        const body = job(name);
        assert(
          body.includes(SAME_REPOSITORY_PULL_REQUEST),
          `${name} must be gated to same-repository pull requests`,
        );
        assert(!body.includes('id-token'), `${name} must not request OIDC`);
      }
      assert.equal(occurrences(job('preview'), 'pnpm exec pkg-pr-new publish'), 1);
      assert(needsOf('preview-consumer').includes('preview'));
    });
  });

  describe('ci-gate', () => {
    const body = job('ci-gate');
    const required = (() => {
      const list = /const required = \[([\s\S]*?)\];/u.exec(body);
      assert(list, 'ci-gate must declare its required jobs');
      return [...list[1].matchAll(/'([\w-]+)'/gu)].map((match) => match[1]);
    })();

    it('needs every other job', () => {
      const others = [...ciJobs.keys()].filter((name) => name !== 'ci-gate').sort(byText);
      assert.deepEqual([...needsOf('ci-gate')].sort(byText), others);
      assert(body.includes('if: always()'));
    });

    it('requires every always-run job and asserts the conditional ones as expected skips', () => {
      const conditional = ['publish', 'registry-verify', 'preview', 'preview-consumer'];
      assert.deepEqual([...required, ...conditional].sort(byText), [...needsOf('ci-gate')].sort(byText));
      assert(body.includes("required.push('publish', 'registry-verify');"));
      assert(body.includes("skipped.push('publish', 'registry-verify');"));
      assert(
        body.includes("if (process.env.PREVIEW === 'true') required.push('preview', 'preview-consumer');"),
      );
      assert(body.includes("else skipped.push('preview', 'preview-consumer');"));
      assert(body.includes('PUBLISH: ${{ needs.preflight.outputs.npm-publish }}'));
      assert(
        body.includes(
          "PREVIEW: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository }}",
        ),
      );
    });

    it('fails a pull request run on which publish did not skip', () => {
      const script = step(body, 'Assert required job results').run;
      const results = Object.fromEntries(needsOf('ci-gate').map((name) => [name, { result: 'success' }]));
      const gate = (overrides, env) =>
        runStep(script, {
          cwd: root,
          env: { RESULTS: JSON.stringify({ ...results, ...overrides }), ...env },
        });
      const pullRequest = { PUBLISH: 'false', PREVIEW: 'true' };
      const skippedPublication = { publish: { result: 'skipped' }, 'registry-verify': { result: 'skipped' } };
      assert.equal(gate(skippedPublication, pullRequest).status, 0);
      const ran = gate({ ...skippedPublication, publish: { result: 'success' } }, pullRequest);
      assert.equal(ran.status, 1);
      assert.match(ran.stderr, /publish \(expected skip\)/u);
      assert.equal(
        gate({}, { PUBLISH: 'true', PREVIEW: 'false' }).status,
        1,
        'a release run must skip previews',
      );
      assert.equal(
        gate(
          { preview: { result: 'skipped' }, 'preview-consumer': { result: 'skipped' } },
          { PUBLISH: 'true', PREVIEW: 'false' },
        ).status,
        0,
      );
      assert.equal(gate({ ...skippedPublication, coverage: { result: 'failure' } }, pullRequest).status, 1);
    });
  });
});

describe('release pull request workflow', () => {
  const releaseJobs = jobsOf(releasePr);
  const generate = job('generate', releaseJobs);
  const propose = job('propose', releaseJobs);

  it('runs after a successful CI push run on this repository main, or by hand', () => {
    assert.match(
      releasePr,
      /^on:\n {2}workflow_run:\n {4}workflows: \[CI\]\n {4}branches: \[main\]\n {4}types: \[completed\]\n {2}workflow_dispatch:\n/mu,
    );
    assert.match(ci, /^name: CI$/mu, 'workflow_run matches ci.yml by its name');
    for (const condition of [
      "github.event_name == 'workflow_dispatch' ||",
      "github.event.workflow_run.conclusion == 'success' &&",
      "github.event.workflow_run.event == 'push' &&",
      "github.event.workflow_run.path == '.github/workflows/ci.yml' &&",
      'github.event.workflow_run.head_repository.full_name == github.repository',
    ]) {
      assert(generate.includes(condition), `the generate job must require ${condition}`);
    }
    assert.deepEqual([...releaseJobs.keys()], ['generate', 'propose']);
    assert.match(propose, /^ {4}needs: generate\n {4}if: needs\.generate\.outputs\.current == 'true'$/mu);
  });

  it('keeps the bot credentials out of the job that runs dependency code', () => {
    assert.match(releasePr, /^permissions:\n {2}actions: read\n {2}contents: read\n\n/mu);
    assert.match(releasePr, /^concurrency:\n {2}group: release-pr\n {2}cancel-in-progress: false$/mu);
    // generate installs and runs the release gate: no environment, no secret,
    // no bot token.
    for (const credential of [
      'environment:',
      'secrets.',
      'steps.bot',
      'create-github-app-token',
      'git push',
    ]) {
      assert(!generate.includes(credential), `generate must not hold ${credential}`);
    }
    assert(generate.includes('uses: ./.github/actions/setup'));
    // propose holds the credentials and installs and runs no dependency code.
    // A plain environment, so its main-only branch policy binds the job, and
    // the default token only reads the repository.
    assert.match(
      propose,
      /^ {4}environment: release-pr\n {4}permissions:\n {6}contents: read\n {4}steps:$/mu,
    );
    assert(!releasePr.includes('deployment:'), 'no job may opt out of the environment deployment');
    for (const code of ['./.github/actions/setup', 'pnpm', 'npm ', 'npx']) {
      assert(!propose.includes(code), `propose must not run ${code}`);
    }
    const mint = step(propose, 'Mint tau-release-bot token').text;
    assert(mint.includes('client-id: ${{ secrets.RELEASE_BOT_APP_ID }}'));
    assert(!mint.includes('app-id:'), 'app-id is deprecated in create-github-app-token v3');
    assert(mint.includes('private-key: ${{ secrets.RELEASE_BOT_APP_PRIVATE_KEY }}'));
    assert.equal(occurrences(releasePr, 'secrets.'), 2);
    // Only the pushing and gh steps receive the token, and no checkout stores it.
    assert.equal(occurrences(releasePr, 'uses: actions/checkout@'), 2);
    assert.equal(occurrences(releasePr, 'persist-credentials: false'), 2);
    assert(!releasePr.includes('token: ${{ steps.bot.outputs.token }}'), 'no action receives the bot token');
    // The token is minted only after the bundle is validated.
    const order = stepsOf(propose).map(({ name }) => name);
    assert(
      order.indexOf('Mint tau-release-bot token') > order.indexOf('Validate the release commit'),
      'the bot token must be minted after validation',
    );
    const holders = stepsOf(propose)
      .filter(({ text }) => text.includes('steps.bot.outputs.token'))
      .map(({ name }) => name);
    assert.deepEqual(holders, [
      'Close the release pull request',
      'Push release/next',
      'Upsert the release pull request',
    ]);
    assert(!releasePr.includes('npm publish'));
  });

  it('passes every expression into scripts through the environment', () => {
    for (const { name, script } of runBlocks(releasePr)) {
      assert(!script.includes('${{'), `step "${name}" must read expressions from env, not interpolate them`);
    }
  });

  it('regenerates from the tested commit with the wasm artifacts of that CI run', () => {
    assert(step(generate, 'Checkout').text.includes('ref: ${{ steps.source.outputs.sha }}'));
    const download = step(generate, 'Download the tested wasm artifacts').text;
    assert(download.includes('uses: ./.github/actions/download-verified-artifact'));
    assert(download.includes('pattern: wasm-*'));
    assert(download.includes('run-id: ${{ steps.source.outputs.run_id }}'));
    assert(download.includes('github-token: ${{ github.token }}'));
    for (const file of ['src/pico.mjs', 'src/pico.wasm', 'src/pico-multi.mjs', 'src/pico-multi.wasm']) {
      assert(download.includes(file), `the download must require ${file}`);
    }
    for (const buildStep of ['emcc', 'build-wasm', 'fetch-deps', 'npm pack']) {
      assert(!releasePr.includes(buildStep), `release-pr.yml must not run ${buildStep}`);
    }
    assert(step(propose, 'Checkout').text.includes('ref: ${{ needs.generate.outputs.sha }}'));
  });

  describe('resolving the CI run', () => {
    const script = step(generate, 'Resolve the CI run').run;
    const fakeGh = (tsv) => {
      const directory = temporaryDirectory();
      writeFileSync(join(directory, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' '${tsv}'\n`);
      chmodSync(join(directory, 'gh'), 0o755);
      return directory;
    };
    const valid = ['.github/workflows/ci.yml', 'push', 'main', 'success', 'taucad/picovoxel', 'b'.repeat(40)];
    const dispatch = (fields, runId = '42') =>
      runStep(script, {
        cwd: temporaryDirectory(),
        env: { EVENT_NAME: 'workflow_dispatch', INPUT_RUN_ID: runId, REPOSITORY: 'taucad/picovoxel' },
        path: [fakeGh(fields.join('\t'))],
      });

    it('takes the run and commit from a workflow_run event', () => {
      const { output, status } = runStep(script, {
        cwd: temporaryDirectory(),
        env: { EVENT_NAME: 'workflow_run', RUN_ID: '7', RUN_SHA: 'c'.repeat(40) },
      });
      assert.equal(status, 0);
      assert.deepEqual(output, { run_id: '7', sha: 'c'.repeat(40) });
    });

    it('accepts a dispatched run id of a successful main push run of ci.yml', () => {
      const { output, status, stderr } = dispatch(valid);
      assert.equal(status, 0, stderr);
      assert.deepEqual(output, { run_id: '42', sha: 'b'.repeat(40) });
    });

    it('refuses any other dispatched run', () => {
      const forgeries = [
        ['.github/workflows/bench.yml', 1],
        ['pull_request', 2],
        ['release/next', 3],
        ['failure', 4],
        ['attacker/picovoxel', 5],
      ];
      for (const [value, field] of forgeries) {
        const fields = [...valid];
        fields[field - 1] = value;
        const { output, status, stderr } = dispatch(fields);
        assert.equal(status, 1, `a run with ${value} must be refused`);
        assert.match(stderr, /is not a successful main push run of ci\.yml/u);
        assert.deepEqual(output, {});
      }
      assert.match(dispatch(valid, '42; true').stderr, /ci_run_id must be a run id/u);
    });
  });

  it('skips a CI run that main has moved past', () => {
    const tip = step(generate, 'Require the tip of main');
    const directory = newRepository();
    const older = commitAll(directory, 'feat: one');
    const latest = commitAll(directory, 'feat: two');
    git(directory, 'update-ref', 'refs/remotes/origin/main', latest);
    assert.deepEqual(runStep(tip.run, { cwd: directory, env: { SOURCE_SHA: latest } }).output, {
      current: 'true',
    });
    assert.deepEqual(runStep(tip.run, { cwd: directory, env: { SOURCE_SHA: older } }).output, {
      current: 'false',
    });
    assert.equal(step(generate, 'Check pending Version Plans').if, "steps.tip.outputs.current == 'true'");
  });

  /**
   * A scratch repository shaped like this one at the tested commit: a pending
   * plan, the seed changelog, the release policy script, and a fake pnpm whose
   * `release:prepare` makes the edits nx makes.
   */
  const scratchRelease = () => {
    const directory = newRepository();
    mkdirSync(join(directory, 'scripts'));
    cpSync(join(root, 'scripts/ci-release.mjs'), join(directory, 'scripts/ci-release.mjs'));
    mkdirSync(join(directory, '.nx/version-plans'), { recursive: true });
    writeFileSync(
      join(directory, '.nx/version-plans/first.md'),
      '---\npicovoxel: minor\n---\n\nFirst release.\n',
    );
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({ name: 'picovoxel', version: '0.0.0' }, null, 2)}\n`,
    );
    writeFileSync(join(directory, 'CHANGELOG.md'), '# Changelog\n');
    writeFileSync(join(directory, 'README.md'), '# picovoxel\n');
    const source = commitAll(directory, 'feat(api): add the API');
    const bin = temporaryDirectory();
    writeFileSync(
      join(bin, 'pnpm'),
      [
        '#!/usr/bin/env bash',
        '[[ "$*" == "release:prepare -- --from-plans" ]] || { echo "unexpected pnpm $*" >&2; exit 1; }',
        `node -e "const f='package.json',m=JSON.parse(require('fs').readFileSync(f));m.version='0.1.0';require('fs').writeFileSync(f,JSON.stringify(m,null,2)+'\\\\n')"`,
        "printf '# Changelog\\n\\n## 0.1.0 (2026-09-28)\\n\\n- First release.\\n' > CHANGELOG.md",
        'rm .nx/version-plans/first.md',
        'if [[ "$FAKE_EXTRA" == stage ]]; then echo changed >> README.md; git add README.md; fi',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'pnpm'), 0o755);
    return { bin, directory, source };
  };

  describe('generating the release commit', () => {
    const script = step(generate, 'Generate the release commit').run;

    it('commits only the release files, as the bot, and bundles the one commit', () => {
      const { bin, directory, source } = scratchRelease();
      const { status, stderr } = runStep(script, {
        cwd: directory,
        env: { SOURCE_SHA: source },
        path: [bin],
      });
      assert.equal(status, 0, stderr);
      assert.equal(git(directory, 'rev-parse', 'HEAD^'), source);
      assert.equal(git(directory, 'log', '-1', '--format=%s'), 'chore(release): picovoxel v0.1.0');
      assert.equal(
        git(directory, 'log', '-1', '--format=%an <%ae>'),
        'tau-release-bot[bot] <tau-release-bot[bot]@users.noreply.github.com>',
      );
      assert.deepEqual(git(directory, 'diff', '--name-status', source, 'HEAD').split('\n'), [
        'D\t.nx/version-plans/first.md',
        'M\tCHANGELOG.md',
        'M\tpackage.json',
      ]);
      const heads = git(directory, 'bundle', 'list-heads', 'release-commit/release.bundle');
      assert.equal(heads, `${git(directory, 'rev-parse', 'HEAD')} refs/heads/release-bundle`);
      assert.match(git(directory, 'bundle', 'verify', 'release-commit/release.bundle'), /requires this ref/u);
    });

    it('refuses a release commit that would carry any other staged file', () => {
      const { bin, directory, source } = scratchRelease();
      const { status, stderr } = runStep(script, {
        cwd: directory,
        env: { FAKE_EXTRA: 'stage', SOURCE_SHA: source },
        path: [bin],
      });
      assert.equal(status, 1);
      assert.match(stderr, /release generation changed unexpected files: README\.md/u);
      assert.equal(git(directory, 'rev-parse', 'HEAD'), source, 'nothing may be committed');
    });
  });

  describe('proposing the release commit', () => {
    const validate = step(propose, 'Validate the release commit').run;

    /** A propose checkout at the tested commit, holding the bundle `edit` produced. */
    const proposal = (edit) => {
      const { bin, directory, source } = scratchRelease();
      const generated = runStep(step(generate, 'Generate the release commit').run, {
        cwd: directory,
        env: { SOURCE_SHA: source },
        path: [bin],
      });
      assert.equal(generated.status, 0, generated.stderr);
      edit?.(directory, source);
      git(directory, 'update-ref', 'refs/heads/release-bundle', 'HEAD');
      git(
        directory,
        'bundle',
        'create',
        'release-commit/release.bundle',
        `${source}..refs/heads/release-bundle`,
      );
      git(directory, 'checkout', '--quiet', '--detach', source);
      return runStep(validate, {
        cwd: directory,
        env: { GITHUB_WORKSPACE: directory, REPOSITORY: 'taucad/picovoxel', SOURCE_SHA: source },
      });
    };
    const amend = (directory, change) => {
      change();
      git(directory, 'add', 'package.json', 'README.md');
      git(
        directory,
        '-c',
        'user.name=tau-release-bot[bot]',
        '-c',
        'user.email=tau-release-bot[bot]@users.noreply.github.com',
        'commit',
        '--quiet',
        '--amend',
        '--no-edit',
      );
    };

    it('accepts the generated commit and names its version', () => {
      const { output, status, stderr } = proposal();
      assert.equal(status, 0, stderr);
      assert.match(output.sha, /^[0-9a-f]{40}$/u);
      assert.equal(output.version, '0.1.0');
    });

    it('refuses a bundle the release policy would reject', () => {
      const widened = proposal((directory) =>
        amend(directory, () => {
          const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
          writeFileSync(
            join(directory, 'package.json'),
            JSON.stringify({ ...manifest, dependencies: { leftpad: '1.0.0' } }),
          );
        }),
      );
      assert.equal(widened.status, 1);
      assert.match(widened.stderr, /may change only the package\.json version/u);
      const extra = proposal((directory) =>
        amend(directory, () => writeFileSync(join(directory, 'README.md'), 'x\n')),
      );
      assert.equal(extra.status, 1);
      assert.match(extra.stderr, /unexpected files: README\.md/u);
    });

    it('refuses another author, another subject, or more than one commit', () => {
      const author = proposal((directory) =>
        git(directory, 'commit', '--quiet', '--amend', '--no-edit', '--reset-author'),
      );
      assert.equal(author.status, 1);
      assert.match(author.stderr, /authored by Test <test@example\.invalid>/u);
      const subject = proposal((directory) =>
        git(
          directory,
          '-c',
          'user.name=tau-release-bot[bot]',
          '-c',
          'user.email=tau-release-bot[bot]@users.noreply.github.com',
          'commit',
          '--quiet',
          '--amend',
          '-m',
          'chore(release): picovoxel v0.2.0',
        ),
      );
      assert.equal(subject.status, 1);
      assert.match(subject.stderr, /subject is 'chore\(release\): picovoxel v0\.2\.0'/u);
      const two = proposal((directory) => {
        git(directory, 'reset', '--quiet', '--soft', 'HEAD~1');
        git(directory, 'commit', '--quiet', '-m', 'first half');
        git(
          directory,
          '-c',
          'user.name=tau-release-bot[bot]',
          '-c',
          'user.email=tau-release-bot[bot]@users.noreply.github.com',
          'commit',
          '--quiet',
          '--allow-empty',
          '-m',
          'chore(release): picovoxel v0.1.0',
        );
      });
      assert.equal(two.status, 1);
      assert.match(two.stderr, /is not one commit on/u);
    });

    it('refuses a merge commit or a pull-request suffix that the release policy alone would accept', () => {
      const asBot = (directory, ...args) =>
        git(
          directory,
          '-c',
          'user.name=tau-release-bot[bot]',
          '-c',
          'user.email=tau-release-bot[bot]@users.noreply.github.com',
          ...args,
        );
      // The release tree, but as a merge whose first parent is the tested commit.
      const merge = proposal((directory, source) => {
        const release = git(directory, 'rev-parse', 'HEAD');
        git(directory, 'checkout', '--quiet', '--detach', source);
        asBot(directory, 'merge', '--quiet', '--no-ff', '-m', 'chore(release): picovoxel v0.1.0', release);
      });
      assert.equal(merge.status, 1);
      assert.match(merge.stderr, /is not one commit on/u);
      const suffix = proposal((directory) =>
        asBot(directory, 'commit', '--quiet', '--amend', '-m', 'chore(release): picovoxel v0.1.0 (#5)'),
      );
      assert.equal(suffix.status, 1);
      assert.match(suffix.stderr, /subject is 'chore\(release\): picovoxel v0\.1\.0 \(#5\)'/u);
    });

    /** Run one pushing step with a fake git that records its arguments. */
    const pushWith = (name, env) => {
      const bin = temporaryDirectory();
      const calls = join(bin, 'calls');
      writeFileSync(calls, '');
      writeFileSync(
        join(bin, 'git'),
        `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> '${calls}'\necho --- >> '${calls}'\n`,
      );
      writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\n');
      chmodSync(join(bin, 'git'), 0o755);
      chmodSync(join(bin, 'gh'), 0o755);
      const result = runStep(step(propose, name).run, {
        cwd: temporaryDirectory(),
        env: { BOT_TOKEN: 'token-value', REPOSITORY: 'taucad/picovoxel', ...env },
        path: [bin],
      });
      const header = `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from('x-access-token:token-value').toString('base64')}`;
      return { ...result, calls: readFileSync(calls, 'utf8').split('---\n').filter(Boolean), header };
    };

    it('pushes only the validated commit to release/next, passing the token to that command alone', () => {
      const commit = 'd'.repeat(40);
      const { calls, header, status, stderr } = pushWith('Push release/next', { COMMIT: commit });
      assert.equal(status, 0, stderr);
      assert.deepEqual(calls, [
        [
          '-c',
          header,
          'push',
          '--force',
          'https://github.com/taucad/picovoxel.git',
          `${commit}:refs/heads/release/next`,
          '',
        ].join('\n'),
      ]);
      assert.equal(
        step(propose, 'Push release/next').text.includes('COMMIT: ${{ steps.commit.outputs.sha }}'),
        true,
      );
    });

    it('deletes only release/next when no plan is pending and no pull request is open', () => {
      const { calls, header, status, stderr } = pushWith('Close the release pull request', {});
      assert.equal(status, 0, stderr);
      assert.deepEqual(calls, [
        [
          '-c',
          header,
          'push',
          'https://github.com/taucad/picovoxel.git',
          '--delete',
          'release/next',
          '',
        ].join('\n'),
      ]);
    });
  });

  describe('describing the release', () => {
    const describeStep = step(propose, 'Describe the release').run;
    /** The `{ … } >> "$GITHUB_OUTPUT"` group that contains `marker`. */
    const outputGroup = (marker) => {
      const lines = describeStep.split('\n');
      const at = lines.findIndex((line) => line.includes(marker));
      assert.notEqual(at, -1, `the describe step must contain ${marker}`);
      let start = at;
      while (lines[start].trim() !== '{') start -= 1;
      const end = lines.findIndex((line, index) => index > at && line.trim() === '} >> "$GITHUB_OUTPUT"');
      return `${lines.slice(start, end + 1).join('\n')}\n`;
    };

    it('lists project and default plan bumps, and survives a plan that states neither', () => {
      const plans = outputGroup("echo 'plans<<PLANSEOF'");
      assert(
        plans.includes("grep -HE '^(picovoxel|__default__):' .nx/version-plans/*.md | sed 's/^/- /' || true"),
      );
      const directory = temporaryDirectory();
      mkdirSync(join(directory, '.nx/version-plans'), { recursive: true });
      writeFileSync(join(directory, '.nx/version-plans/a.md'), '---\npicovoxel: minor\n---\n\nA.\n');
      writeFileSync(join(directory, '.nx/version-plans/b.md'), '---\n__default__: patch\n---\n\nB.\n');
      const listed = runStep(plans, { cwd: directory });
      assert.equal(listed.status, 0, listed.stderr);
      assert.equal(
        listed.output.plans,
        '- .nx/version-plans/a.md:picovoxel: minor\n- .nx/version-plans/b.md:__default__: patch',
      );
      rmSync(join(directory, '.nx/version-plans/a.md'));
      writeFileSync(join(directory, '.nx/version-plans/b.md'), '---\n"picovoxel": minor\n---\n\nB.\n');
      const unmatched = runStep(plans, { cwd: directory });
      assert.equal(unmatched.status, 0, unmatched.stderr);
      assert.equal(unmatched.output.plans, '');
    });

    it('logs the commits since the previous release tag, or the recent history before the first', () => {
      const log = outputGroup("echo 'commit_log<<LOGEOF'");
      const directory = newRepository();
      commitAll(directory, 'feat: before the release');
      git(directory, 'tag', 'v0.1.0');
      commitAll(directory, 'fix: after the release');
      const source = commitAll(directory, 'feat: the tip');
      const env = { SOURCE_SHA: source, previous_version: '0.1.0' };
      const tagged = runStep(log, { cwd: directory, env });
      assert.equal(tagged.status, 0, tagged.stderr);
      assert.deepEqual(
        tagged.output.commit_log.split('\n').map((line) => line.slice(line.indexOf(' ', 2) + 1)),
        ['feat: the tip', 'fix: after the release'],
      );
      const first = runStep(log, { cwd: directory, env: { ...env, previous_version: '0.0.0' } });
      assert.equal(first.status, 0, first.stderr);
      assert.equal(
        first.output.commit_log.split('\n').length,
        3,
        'without a tag the log is the recent history',
      );
      assert.equal(first.output.previous_version, '0.0.0');
    });
  });
});
