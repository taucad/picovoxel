import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

const stepScript = (workflow, name) => {
  const matches = runBlocks(workflow).filter((block) => block.name === name);
  assert.equal(matches.length, 1, `exactly one step named "${name}" must run a script`);
  return matches[0].script;
};

/** The id: run block of a step identified by `id:` rather than a name. */
const idScript = (body, id) => {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*- id: ${id}\\s*$`, 'u').test(line));
  assert.notEqual(start, -1, `step ${id} must exist`);
  const stepIndent = indentation(lines[start]);
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() !== '' && indentation(line) <= stepIndent,
  );
  const step = lines
    .slice(start, end === -1 ? undefined : end)
    .join('\n')
    .replace(/^(\s*)- id: \S+/u, '$1- name: __id__');
  return stepScript(step, '__id__');
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
      assert(!/^\s+environment:/mu.test(ci), 'no ci.yml job may declare an environment');
    });

    it('cancels stale pull request runs and serializes main', () => {
      assert(
        ci.includes(
          "group: ${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || 'publish-main' }}",
        ),
      );
      assert(ci.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
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
      for (const [name, scripts] of dependencyFree) {
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
      assert.deepEqual(
        building.map(([name]) => name),
        ['wasm'],
      );
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
        for (const step of buildSteps) {
          assert(!job(name).includes(step), `${name} must not run ${step}`);
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
      ]) {
        assert(body.includes(`${flag} `), `ci-release.mjs must receive ${flag}`);
      }
      assert(body.includes('SOURCE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}'));
      assert(body.includes('npm-publish: ${{ steps.release.outputs.npm_publish }}'));
    });

    it('requires a Version Plan outside release runs', () => {
      const body = job('quality');
      assert(body.includes('fetch-depth: 0'));
      assert(
        body.includes(
          "if: needs.preflight.outputs.kind != 'release-pull-request' && needs.preflight.outputs.kind != 'release'",
        ),
      );
      assert(body.includes('pnpm nx release plan:check --base="origin/$BASE_REF" --head=HEAD'));
      assert(body.includes('pnpm nx release plan:check --base="$BEFORE_SHA" --head=HEAD'));
      assert(needsOf('quality').includes('preflight'));
    });

    describe('the preflight script', () => {
      const script = idScript(job('preflight'), 'release');
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
        return { base, directory, ordinary, release };
      })();

      const derive = ({ event, ref, sha }) => {
        git(repository.directory, 'checkout', '--quiet', '--detach', sha);
        return runStep(script, {
          cwd: repository.directory,
          env: {
            BASE_REF: event === 'pull_request' ? 'main' : '',
            EVENT_NAME: event,
            REF_NAME: ref,
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
        });
        assert.deepEqual(ordinary.output, { kind: 'pull-request', npm_publish: 'false', version: '0.0.0' });
        const release = derive({ event: 'pull_request', ref: 'refs/pull/14/merge', sha: repository.release });
        assert.deepEqual(release.output, {
          kind: 'release-pull-request',
          npm_publish: 'false',
          version: '0.1.0',
        });
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
      assert(
        body.includes(
          "if: needs.preflight.outputs.npm-publish == 'true' && github.event_name == 'push' && github.ref == 'refs/heads/main'",
        ),
      );
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

    it('publishes the tested candidate tarball, verified, without a checkout or a build', () => {
      const body = job('publish');
      assert(!body.includes('actions/checkout'), 'publish runs nothing from the repository');
      assert.equal(
        occurrences(ci, 'uses: actions/download-artifact@'),
        1,
        'only publish, which has no checkout, bypasses the verified download',
      );
      assert(body.includes('uses: actions/download-artifact@'));
      assert(body.includes('name: npm-candidate'));
      const check = body.indexOf('openssl dgst -sha512 -binary "./candidate/$filename"');
      const view = body.indexOf('npm view "$name@$version" dist.integrity');
      const publish = body.indexOf('npm publish "./candidate/$filename" --access public --provenance');
      assert(check !== -1 && view !== -1 && publish !== -1);
      assert(check < view && view < publish, 'verify the bytes, then the registry, then publish');
      assert.equal(occurrences(ci, 'npm publish'), 1);
      assert(
        body.includes('if [[ "$version" != "$VERSION" ]]'),
        'the candidate must be the release commit version',
      );
      assert(body.includes('registry-url: https://registry.npmjs.org'));
    });

    it('verifies the registry artifact and its provenance before recording the release', () => {
      const body = job('registry-verify');
      assert(
        body.includes(
          "if: always() && needs.preflight.outputs.npm-publish == 'true' && needs.publish.result == 'success'",
        ),
      );
      assert(needsOf('registry-verify').includes('publish'));
      const steps = [
        'node scripts/registry-wait.mjs --manifest candidate/manifest.json --interval-seconds 30 --timeout-minutes 30',
        'npm install --force --ignore-scripts "${package_specs[@]}"',
        'npm audit signatures --json --include-attestations > /tmp/npm-audit-signatures.json',
        'node scripts/verify-release-attestations.mjs',
        "'${{ github.sha }}'",
        "'${{ github.run_id }}'",
        'gh release create "$tag" --target \'${{ github.sha }}\' --generate-notes',
      ];
      let last = -1;
      for (const step of steps) {
        const index = body.indexOf(step);
        assert(index > last, `registry-verify must run, in order: ${step}`);
        last = index;
      }
      assert.equal(occurrences(ci, 'gh release create'), 1);
      // npm's --include-attestations needs a current npm; Node 26 bundles one.
      assert(body.includes('node-version: ${{ env.NODE_LATEST }}'));
      assert.match(ci, /^ {2}NODE_LATEST: '26'$/mu);
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
      const script = stepScript(ci, 'Assert required job results');
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
  const prepare = job('prepare', jobsOf(releasePr));

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
      'github.event.workflow_run.head_repository.full_name == github.repository',
    ]) {
      assert(prepare.includes(condition), `the prepare job must require ${condition}`);
    }
  });

  it('holds only the permissions its steps need, with the bot credentials in the release-pr environment', () => {
    assert.match(releasePr, /^permissions:\n {2}actions: read\n\n/mu);
    assert.match(prepare, /environment:\n {6}name: release-pr\n {6}deployment: false/u);
    assert(prepare.includes('app-id: ${{ secrets.RELEASE_BOT_APP_ID }}'));
    assert(prepare.includes('private-key: ${{ secrets.RELEASE_BOT_APP_PRIVATE_KEY }}'));
    assert(prepare.includes('permission-contents: write'));
    assert(prepare.includes('permission-pull-requests: write'));
    assert.equal(occurrences(releasePr, 'secrets.'), 2);
    assert(prepare.includes('git config user.name "tau-release-bot[bot]"'));
    assert(!releasePr.includes('npm publish'));
    assert.match(releasePr, /^concurrency:\n {2}group: release-pr\n {2}cancel-in-progress: false$/mu);
  });

  it('passes every expression into scripts through the environment', () => {
    for (const { name, script } of runBlocks(releasePr)) {
      assert(!script.includes('${{'), `step "${name}" must read expressions from env, not interpolate them`);
    }
  });

  it('regenerates from the tested commit with the wasm artifacts of that CI run', () => {
    assert(prepare.includes('ref: ${{ steps.source.outputs.sha }}'));
    const download = prepare.slice(prepare.indexOf('- name: Download the tested wasm artifacts'));
    assert(download.includes('uses: ./.github/actions/download-verified-artifact'));
    assert(download.includes('pattern: wasm-*'));
    assert(download.includes('run-id: ${{ steps.source.outputs.run_id }}'));
    assert(download.includes('github-token: ${{ github.token }}'));
    for (const file of ['src/pico.mjs', 'src/pico.wasm', 'src/pico-multi.mjs', 'src/pico-multi.wasm']) {
      assert(download.includes(file), `the download must require ${file}`);
    }
    assert(prepare.includes('pnpm release:prepare -- --from-plans'));
    for (const step of ['emcc', 'build-wasm', 'fetch-deps', 'npm pack']) {
      assert(!prepare.includes(step), `release-pr.yml must not run ${step}`);
    }
  });

  describe('resolving the CI run', () => {
    const script = stepScript(releasePr, 'Resolve the CI run');
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
    const script = stepScript(releasePr, 'Require the tip of main');
    const directory = newRepository();
    const older = commitAll(directory, 'feat: one');
    const tip = commitAll(directory, 'feat: two');
    git(directory, 'update-ref', 'refs/remotes/origin/main', tip);
    assert.deepEqual(runStep(script, { cwd: directory, env: { SOURCE_SHA: tip } }).output, {
      current: 'true',
    });
    assert.deepEqual(runStep(script, { cwd: directory, env: { SOURCE_SHA: older } }).output, {
      current: 'false',
    });
    assert(
      prepare.includes(
        "- name: Check pending Version Plans\n        id: plans\n        if: steps.tip.outputs.current == 'true'",
      ),
    );
  });

  describe('generating the release commit', () => {
    const generate = stepScript(releasePr, 'Generate the release commit');
    /** The `{ … } >> "$GITHUB_OUTPUT"` group that contains `marker`. */
    const outputGroup = (marker) => {
      const lines = generate.split('\n');
      const at = lines.findIndex((line) => line.includes(marker));
      assert.notEqual(at, -1, `the generate step must contain ${marker}`);
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
      const env = { SOURCE_SHA: source, version: '0.1.1', previous_version: '0.1.0' };
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
      assert.equal(first.output.version, '0.1.1');
    });
  });
});
