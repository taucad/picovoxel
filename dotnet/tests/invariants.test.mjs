import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeInvariants, statements } from './invariants.mjs';
import { contractPaths, npmContractDiff } from './npm-contract.mjs';

const pins = JSON.parse(readFileSync(new URL('../inputs.json', import.meta.url), 'utf8'));

/** One complete evidence directory, which every case then degrades in exactly one way. */
const evidence = (overrides = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'picogk-invariants-'));
  const files = {
    'parity-gyroid.json': { subject: 'gyroid', passed: true },
    'author-sources.json': {
      unmodified: true,
      subjects: { ShapeKernel: { commit: 'a'.repeat(40), files: 3 } },
    },
    'archive-serial.json': {
      toolchain: { emscripten: pins.emscripten, emscriptenRevision: pins.emscriptenRevision },
    },
    'archive-threaded.json': {
      toolchain: { emscripten: pins.emscripten, emscriptenRevision: pins.emscriptenRevision },
    },
    'npm-contract.json': { mergeBase: 'b'.repeat(40), touched: [] },
    'desktop-neutrality.json': { status: 'passed', host: 'darwin-arm64', suite: 'picogk:test-dotnet' },
    ...overrides,
  };
  for (const [name, value] of Object.entries(files))
    if (value !== null) writeFileSync(join(root, name), `${JSON.stringify(value)}\n`);
  return root;
};

test('complete evidence passes every invariant and names each claim', () => {
  const root = evidence();
  try {
    const result = judgeInvariants(root);
    assert.equal(result.passed, true);
    assert.deepEqual(
      Object.fromEntries(Object.entries(result.invariants).map(([name, row]) => [name, row.status])),
      { I1: 'passed', I2: 'passed', I3: 'passed', I4: 'passed', I5: 'passed' },
    );
    for (const [name, row] of Object.entries(result.invariants))
      assert.equal(row.statement, statements[name]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an absent report is unproven, never a pass', () => {
  for (const [missing, invariant] of [
    ['parity-gyroid.json', 'I1'],
    ['author-sources.json', 'I2'],
    ['archive-threaded.json', 'I3'],
    ['npm-contract.json', 'I4'],
    ['desktop-neutrality.json', 'I5'],
  ]) {
    const root = evidence({ [missing]: null });
    try {
      const result = judgeInvariants(root);
      assert.equal(result.passed, false);
      assert.equal(result.invariants[invariant].status, 'unproven');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  // An empty directory proves nothing at all, and says so five times over.
  const empty = mkdtempSync(join(tmpdir(), 'picogk-invariants-'));
  try {
    const result = judgeInvariants(empty);
    assert.equal(result.passed, false);
    assert.equal(
      Object.values(result.invariants).every((row) => row.status === 'unproven'),
      true,
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('failed evidence fails its own invariant', () => {
  for (const [name, value, invariant] of [
    ['parity-gyroid.json', { subject: 'gyroid', passed: false }, 'I1'],
    ['author-sources.json', { unmodified: false, subjects: {} }, 'I2'],
    ['archive-serial.json', { toolchain: { emscripten: '6.0.2', emscriptenRevision: 'other' } }, 'I3'],
    ['npm-contract.json', { mergeBase: 'c'.repeat(40), touched: ['test/surface-manifest.json'] }, 'I4'],
    ['desktop-neutrality.json', { status: 'failed' }, 'I5'],
  ]) {
    const root = evidence({ [name]: value });
    try {
      const result = judgeInvariants(root);
      assert.equal(result.passed, false);
      assert.equal(result.invariants[invariant].status, 'failed');
      assert.match(result.invariants[invariant].reason, /\S/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a scheduled subject is judged beside the per-run one, and a shallow checkout cannot prove I4', () => {
  const root = evidence({ 'parity-heatx.json': { subject: 'heatx', passed: false } });
  try {
    const result = judgeInvariants(root);
    assert.equal(result.invariants.I1.status, 'failed');
    assert.deepEqual(
      result.invariants.I1.subjects.map((row) => [row.subject, row.passed]),
      [
        ['gyroid', true],
        ['heatx', false],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const shallow = mkdtempSync(join(tmpdir(), 'picogk-shallow-'));
  try {
    mkdirSync(join(shallow, 'repository'));
    assert.throws(() => npmContractDiff(join(shallow, 'repository'), 'origin/main'), /shallow checkout/u);
    assert.deepEqual(contractPaths, ['test/fixtures', 'test/surface-manifest.json']);
  } finally {
    rmSync(shallow, { recursive: true, force: true });
  }
});
