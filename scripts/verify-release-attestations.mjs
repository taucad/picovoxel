#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROVENANCE_TYPE = 'https://slsa.dev/provenance/v1';
const BUILD_TYPE = 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';
const BUILDER_ID = 'https://github.com/actions/runner/github-hosted';
const REPOSITORY = 'https://github.com/taucad/picovoxel';
const WORKFLOW = '.github/workflows/ci.yml';
const REF = 'refs/heads/main';

const byText = (left, right) => left.localeCompare(right);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const decodeProvenance = (entry) => {
  const attestation = entry.attestationBundles?.find(
    ({ predicateType }) => predicateType === PROVENANCE_TYPE,
  );
  assert(attestation, `${entry.name}@${entry.version} has no verified provenance attestation`);
  return JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
};

const expectedDigest = (integrity) => {
  assert(integrity.startsWith('sha512-'), `unsupported integrity: ${integrity}`);
  return Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
};

const verifyPackage = ({ audit, candidate, commit, runId }) => {
  const entry = audit.verified?.find(
    ({ name, version }) => name === candidate.name && version === candidate.version,
  );
  assert(entry, `${candidate.name}@${candidate.version} has no verified npm signature`);
  assert(
    entry.attestations?.provenance?.predicateType === PROVENANCE_TYPE,
    `${candidate.name} lacks provenance`,
  );

  const statement = decodeProvenance(entry);
  const subject = statement.subject?.find(
    ({ name }) => name === `pkg:npm/${candidate.name}@${candidate.version}`,
  );
  assert(subject?.digest?.sha512 === expectedDigest(candidate.integrity), `${candidate.name} digest differs`);

  const definition = statement.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  assert(definition?.buildType === BUILD_TYPE, `${candidate.name} has the wrong build type`);
  assert(workflow?.repository === REPOSITORY, `${candidate.name} has the wrong source repository`);
  assert(workflow?.path === WORKFLOW, `${candidate.name} has the wrong source workflow`);
  assert(workflow?.ref === REF, `${candidate.name} was not built from main`);

  const source = definition.resolvedDependencies?.find(({ uri }) => uri === `git+${REPOSITORY}@${REF}`);
  assert(source?.digest?.gitCommit === commit, `${candidate.name} has the wrong source commit`);
  assert(
    statement.predicate?.runDetails?.builder?.id === BUILDER_ID,
    `${candidate.name} used the wrong builder`,
  );
  // Any attempt of the publishing run is the same commit, workflow and builder,
  // and a partial re-run of `registry-verify` carries a later attempt number than
  // the one that minted the provenance, so bind to the run, not the attempt.
  assert(
    new RegExp(`^${escapeRegExp(REPOSITORY)}/actions/runs/${runId}/attempts/[1-9]\\d*$`, 'u').test(
      statement.predicate?.runDetails?.metadata?.invocationId ?? '',
    ),
    `${candidate.name} has the wrong workflow invocation`,
  );
};

/**
 * Prove that the registry serves exactly the candidate set this run published:
 * every package signed by npm, with SLSA provenance naming this repository,
 * `ci.yml` on main, the release commit, this workflow run and the candidate's
 * sha512 digest.
 */
export const verifyReleaseAttestations = ({ audit, commit, expectedNames, manifest, runId }) => {
  assert((audit.invalid ?? []).length === 0, 'npm reported invalid signatures');
  assert((audit.missing ?? []).length === 0, 'npm reported missing signatures');
  assert(/^[0-9a-f]{40}$/u.test(commit), `commit must be a full SHA: ${commit}`);
  assert(/^[1-9]\d*$/u.test(runId), `run id must be a positive integer: ${runId}`);

  const names = manifest.packages.map(({ name }) => name).sort(byText);
  assert(
    JSON.stringify(names) === JSON.stringify([...expectedNames].sort(byText)),
    `candidate set [${names.join(', ')}] differs from the released set [${expectedNames.join(', ')}]`,
  );
  for (const candidate of manifest.packages) {
    assert(
      candidate.version === manifest.version,
      `${candidate.name} is recorded at ${candidate.version}, not the release version ${manifest.version}`,
    );
    verifyPackage({ audit, candidate, commit, runId });
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [auditPath, manifestPath, commit, runId] = process.argv.slice(2);
    assert(auditPath && manifestPath && commit && runId, 'expected audit, manifest, commit, run');
    const { name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    verifyReleaseAttestations({
      audit: JSON.parse(readFileSync(auditPath, 'utf8')),
      commit,
      expectedNames: [name],
      manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
      runId,
    });
    process.stdout.write('release provenance matches taucad/picovoxel ci.yml on main\n');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
