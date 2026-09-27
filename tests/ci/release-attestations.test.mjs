import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyReleaseAttestations } from '../../scripts/verify-release-attestations.mjs';

const version = '0.1.0';
const commit = 'a'.repeat(40);
const runId = '123';
const artifact = Buffer.from('picovoxel-0.1.0.tgz bytes');
const candidate = {
  name: 'picovoxel',
  version,
  filename: 'picovoxel-0.1.0.tgz',
  integrity: `sha512-${artifact.toString('base64')}`,
};
const manifest = { packages: [candidate], version };

const statement = (attempt = 1) => ({
  _type: 'https://in-toto.io/Statement/v1',
  subject: [{ name: `pkg:npm/picovoxel@${version}`, digest: { sha512: artifact.toString('hex') } }],
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {
    buildDefinition: {
      buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      externalParameters: {
        workflow: {
          ref: 'refs/heads/main',
          repository: 'https://github.com/taucad/picovoxel',
          path: '.github/workflows/ci.yml',
        },
      },
      resolvedDependencies: [
        { uri: 'git+https://github.com/taucad/picovoxel@refs/heads/main', digest: { gitCommit: commit } },
      ],
    },
    runDetails: {
      builder: { id: 'https://github.com/actions/runner/github-hosted' },
      metadata: {
        invocationId: `https://github.com/taucad/picovoxel/actions/runs/${runId}/attempts/${attempt}`,
      },
    },
  },
});

const auditWith = (payload) => ({
  invalid: [],
  missing: [],
  verified: [
    {
      name: 'picovoxel',
      version,
      location: 'node_modules/picovoxel',
      registry: 'https://registry.npmjs.org/',
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/picovoxel@${version}`,
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
      attestationBundles: [
        {
          predicateType: 'https://slsa.dev/provenance/v1',
          bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(payload)).toString('base64') } },
        },
      ],
    },
  ],
});

const audit = auditWith(statement());
const options = { audit, commit, expectedNames: ['picovoxel'], manifest, runId };

/** Re-mint the DSSE payload after mutating the decoded statement. */
const forged = (mutate) => {
  const payload = statement();
  mutate(payload);
  return { ...options, audit: auditWith(payload) };
};

describe('release attestation verification', () => {
  it('binds the package to the repository, ci.yml on main, the commit, the run and the digest', () => {
    assert.doesNotThrow(() => verifyReleaseAttestations(options));
  });

  it('accepts any attempt of the publishing run, so a partial re-run still verifies', () => {
    assert.doesNotThrow(() => verifyReleaseAttestations({ ...options, audit: auditWith(statement(3)) }));
  });

  it('rejects another commit or another run', () => {
    assert.throws(
      () => verifyReleaseAttestations({ ...options, commit: 'b'.repeat(40) }),
      /picovoxel has the wrong source commit/u,
    );
    assert.throws(
      () => verifyReleaseAttestations({ ...options, runId: '1234' }),
      /picovoxel has the wrong workflow invocation/u,
    );
    assert.throws(
      () => verifyReleaseAttestations({ ...options, runId: '12' }),
      /picovoxel has the wrong workflow invocation/u,
    );
    for (const attempt of ['0', '1/extra', 'x']) {
      assert.throws(
        () => verifyReleaseAttestations({ ...options, audit: auditWith(statement(attempt)) }),
        /picovoxel has the wrong workflow invocation/u,
        `attempt ${attempt} must be rejected`,
      );
    }
  });

  it('rejects malformed commit and run arguments', () => {
    assert.throws(() => verifyReleaseAttestations({ ...options, commit: 'abc1234' }), /full SHA/u);
    assert.throws(() => verifyReleaseAttestations({ ...options, runId: '.*' }), /positive integer/u);
  });

  it('rejects provenance minted by another repository, workflow, branch, builder or build type', () => {
    const forgeries = [
      [
        (payload) => {
          payload.predicate.buildDefinition.externalParameters.workflow.repository =
            'https://github.com/attacker/picovoxel';
        },
        'picovoxel has the wrong source repository',
      ],
      [
        (payload) => {
          payload.predicate.buildDefinition.externalParameters.workflow.path =
            '.github/workflows/release-pr.yml';
        },
        'picovoxel has the wrong source workflow',
      ],
      [
        (payload) => {
          payload.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/release/next';
        },
        'picovoxel was not built from main',
      ],
      [
        (payload) => {
          payload.predicate.buildDefinition.resolvedDependencies[0].uri =
            'git+https://github.com/taucad/picovoxel@refs/heads/release/next';
        },
        'picovoxel has the wrong source commit',
      ],
      [
        (payload) => {
          payload.predicate.runDetails.builder.id = 'https://github.com/actions/runner/self-hosted';
        },
        'picovoxel used the wrong builder',
      ],
      [
        (payload) => {
          payload.predicate.buildDefinition.buildType = 'https://example.invalid/buildtype/v1';
        },
        'picovoxel has the wrong build type',
      ],
      [
        (payload) => {
          payload.predicate.runDetails.metadata.invocationId =
            'https://github.com/attacker/picovoxel/actions/runs/123/attempts/1';
        },
        'picovoxel has the wrong workflow invocation',
      ],
    ];
    for (const [mutate, message] of forgeries) {
      assert.throws(() => verifyReleaseAttestations(forged(mutate)), { message, name: 'Error' }, message);
    }
  });

  it('rejects registry bytes that differ from the candidate', () => {
    const tampered = { ...candidate, integrity: `sha512-${Buffer.from('other bytes').toString('base64')}` };
    assert.throws(
      () => verifyReleaseAttestations({ ...options, manifest: { packages: [tampered], version } }),
      /picovoxel digest differs/u,
    );
    assert.throws(
      () =>
        verifyReleaseAttestations({
          ...options,
          manifest: { packages: [{ ...candidate, integrity: 'sha1-abc' }], version },
        }),
      /unsupported integrity: sha1-abc/u,
    );
  });

  it('rejects a candidate set that differs from the released package', () => {
    const extra = { ...candidate, name: '@taucad/picovoxel', filename: 'taucad-picovoxel-0.1.0.tgz' };
    assert.throws(
      () => verifyReleaseAttestations({ ...options, manifest: { packages: [candidate, extra], version } }),
      /candidate set \[@taucad\/picovoxel, picovoxel\] differs from the released set \[picovoxel\]/u,
    );
    assert.throws(
      () => verifyReleaseAttestations({ ...options, manifest: { packages: [], version } }),
      /candidate set \[\] differs/u,
    );
  });

  it('rejects a candidate recorded at a version other than the release', () => {
    assert.throws(
      () => verifyReleaseAttestations({ ...options, manifest: { packages: [candidate], version: '0.2.0' } }),
      /picovoxel is recorded at 0\.1\.0, not the release version 0\.2\.0/u,
    );
  });

  it('rejects invalid, missing, unverified and unattested signatures', () => {
    assert.throws(
      () => verifyReleaseAttestations({ ...options, audit: { ...audit, invalid: [{ name: 'picovoxel' }] } }),
      /npm reported invalid signatures/u,
    );
    assert.throws(
      () => verifyReleaseAttestations({ ...options, audit: { ...audit, missing: [{ name: 'picovoxel' }] } }),
      /npm reported missing signatures/u,
    );
    // An npm without `--include-attestations` support reports no `verified` list.
    assert.throws(
      () => verifyReleaseAttestations({ ...options, audit: { invalid: [], missing: [] } }),
      /picovoxel@0\.1\.0 has no verified npm signature/u,
    );
    const unattested = structuredClone(audit);
    unattested.verified[0].attestations = {};
    assert.throws(
      () => verifyReleaseAttestations({ ...options, audit: unattested }),
      /picovoxel lacks provenance/u,
    );
    const bundleless = structuredClone(audit);
    bundleless.verified[0].attestationBundles = [];
    assert.throws(
      () => verifyReleaseAttestations({ ...options, audit: bundleless }),
      /picovoxel@0\.1\.0 has no verified provenance attestation/u,
    );
  });

  it('verifies from a checkout that installed no dependencies', () => {
    // registry-verify checks the repository out and installs nothing from it:
    // copying the script and the manifest somewhere with no node_modules above
    // them reproduces that resolution, so any package import fails here. The
    // script runs its command line only when process.argv[1] matches its own
    // resolved URL, and macOS hands out temporary paths behind a symlink.
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const work = realpathSync(mkdtempSync(join(tmpdir(), 'picovoxel-verifier-')));
    try {
      cpSync(join(root, 'scripts', 'verify-release-attestations.mjs'), join(work, 'scripts', 'verify.mjs'));
      cpSync(join(root, 'package.json'), join(work, 'package.json'));
      writeFileSync(join(work, 'audit.json'), JSON.stringify(audit));
      writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest));
      const run = (...args) =>
        execFileSync(process.execPath, [join(work, 'scripts', 'verify.mjs'), ...args], {
          cwd: work,
          encoding: 'utf8',
          stdio: 'pipe',
        });

      assert.equal(
        run(join(work, 'audit.json'), join(work, 'manifest.json'), commit, runId).trim(),
        'release provenance matches taucad/picovoxel ci.yml on main',
      );
      assert.throws(
        () => run(join(work, 'audit.json'), join(work, 'manifest.json'), commit, '999'),
        (error) => error.status === 1 && /wrong workflow invocation/u.test(error.stderr),
      );
      assert.throws(
        () => run(join(work, 'audit.json')),
        (error) => error.status === 1 && /expected audit, manifest, commit, run/u.test(error.stderr),
      );
    } finally {
      rmSync(work, { force: true, recursive: true });
    }
  });
});
