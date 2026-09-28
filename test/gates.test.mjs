import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  CALIBRATION,
  MARKER,
  compareGated,
  findDrifts,
  hardwareClass,
  selectBaseline,
  thresholdFor,
} from '../bench/gates.mjs';

const tuple = {
  gridHash: 'd62d8a54aa9cf7f4a44b6d80d1c71ab5',
  activeVoxels: 1447517,
  insideTiles: 0,
  insideOffVoxels: 9451,
  volumeHex: '41220895e0000000',
  triangles: 1873340,
  vertices: 928632,
  multiset: '2d4f',
};
const samples = (median) => Array.from({ length: 15 }, (_, index) => median + (index - 7));
const result = (headMedian, baseMedian, overrides = {}) => ({
  name: 'heatx-multi-fast-1.0mm-e2e-v1',
  class: 'linux-x64-2cpu',
  head: { samplesMs: samples(headMedian), fingerprint: tuple },
  base: {
    name: 'heatx-multi-fast-1.0mm-e2e-v1',
    sha: '7040437abc',
    samplesMs: samples(baseMedian),
    fingerprint: tuple,
  },
  ...overrides,
});
const calibrated = { 'linux-x64-2cpu': { threshold: 0.1 } };

test('should name the hardware class a threshold or baseline is valid for', () => {
  assert.equal(hardwareClass({ platform: 'linux', arch: 'x64', cores: 2 }), 'linux-x64-2cpu');
  assert.equal(hardwareClass({ platform: 'darwin', cores: 12 }), 'darwin-unknown-12cpu');
});

test('should calibrate at twice the A/A spread with a 10% floor', () => {
  assert.equal(thresholdFor(0.01), 0.1);
  assert.equal(thresholdFor(0.08), 0.16);
});

test('should fail a 15% slowdown on a calibrated class and pass a 5% one', () => {
  const slow = compareGated(result(1150, 1000), calibrated);
  assert.equal(slow.failed, true);
  assert.ok(slow.markdown.startsWith(MARKER));
  assert.match(slow.markdown, /\| \+15\.0% \| \+10\.0% \|/u);
  assert.match(slow.markdown, /main `7040437`/u);
  assert.equal(compareGated(result(1050, 1000), calibrated).failed, false);
});

test('should only report a slowdown on a class with no A/A calibration', () => {
  const report = compareGated(result(1500, 1000), {});
  assert.equal(report.failed, false);
  assert.match(report.markdown, /report-only: `linux-x64-2cpu` has no A\/A calibration/u);
  assert.equal(compareGated(result(1500, 1000)).failed, false, 'linux-x64-2cpu has no calibration');
  assert.equal(CALIBRATION['linux-x64-4cpu']?.threshold, 0.1);
  assert.equal(compareGated(result(1150, 1000, { class: 'linux-x64-4cpu' })).failed, true);
});

test('should fail closed on a changed G0 tuple even when faster', () => {
  const moved = result(900, 1000, {});
  moved.head = { ...moved.head, fingerprint: { ...tuple, triangles: 1 } };
  const report = compareGated(moved, {});
  assert.equal(report.failed, true);
  assert.match(report.markdown, /changed on `triangles`\. Rename the benchmark/u);
});

test('should admit a renamed or new benchmark without comparing', () => {
  const renamed = result(5000, 1000, {});
  renamed.base = {
    ...renamed.base,
    name: 'heatx-multi-fast-1.0mm-e2e-v0',
    fingerprint: { ...tuple, gridHash: 'x' },
  };
  const report = compareGated(renamed, calibrated);
  assert.equal(report.failed, false);
  assert.match(
    report.markdown,
    /New benchmark admitted: `heatx-multi-fast-1\.0mm-e2e-v1` \(renamed from `heatx-multi-fast-1\.0mm-e2e-v0`\)/u,
  );
  assert.match(
    compareGated(result(1000, 1000, { base: null }), calibrated).markdown,
    /\(main has no gated benchmark\)/u,
  );
  assert.match(
    compareGated(result(1000, 1000, { base: null, baseReason: 'no green main run holds its artifacts' }))
      .markdown,
    /\(no green main run holds its artifacts\)/u,
  );
});

test('should report an A/A spread as a calibration and fail it only on nondeterminism', () => {
  const aa = compareGated(result(1030, 1000, { aa: true }), calibrated);
  assert.equal(aa.failed, false);
  assert.match(aa.markdown, /main again/u);
  assert.match(aa.markdown, /A\/A: spread \+3\.0% calibrates `linux-x64-2cpu` at \+10\.0%/u);
  const faster = compareGated(
    result(970, 1000, { aa: true, base: { ...result(0, 1000).base, sha: undefined } }),
    {},
  );
  assert.match(faster.markdown, /\| main \| main again \| Change/u);
  assert.match(faster.markdown, /\| -3\.0% \| A\/A: spread \+3\.0%/u);
  const split = result(1000, 1000, { aa: true });
  split.head = { ...split.head, fingerprint: { ...tuple, multiset: 'other' } };
  const nondeterministic = compareGated(split, calibrated);
  assert.equal(nondeterministic.failed, true);
  assert.match(nondeterministic.markdown, /between two runs of one tree: the benchmark is nondeterministic/u);
});

test('should pick the newest committed baseline of the same hardware class', () => {
  const workstation = { os: 'darwin 25.5.0', cores: 12 };
  const runner = { os: 'linux 6.11.0-1018-azure', arch: 'x64', cores: 2 };
  const committed = [
    { file: '2026-07-26-a.json', fingerprint: workstation },
    { file: '2026-09-28-b.json', fingerprint: runner },
    { file: '2026-09-29-c.json', fingerprint: { ...runner, cores: 4 } },
  ];
  assert.equal(
    selectBaseline(committed, { ...runner, os: 'linux 6.14.0-1012-azure' })?.file,
    '2026-09-28-b.json',
  );
  assert.equal(
    selectBaseline(committed, { os: 'darwin 26.0.0', arch: 'arm64', cores: 12 })?.file,
    '2026-07-26-a.json',
  );
  assert.equal(selectBaseline(committed, { os: 'darwin 26.0.0', arch: 'arm64', cores: 10 }), undefined);
  assert.equal(selectBaseline(committed, { os: 'linux 6.11.0', arch: 'arm64', cores: 2 }), undefined);
});

test('should report phases over twice the baseline and skip noise and new metrics', () => {
  const baseline = {
    results: {
      M1: { phases: { instantiate: { medianMs: 100 }, tiny: { medianMs: 0.2 } } },
      M2: { phases: { build: { medianMs: 10 } } },
    },
  };
  const latest = {
    results: {
      M1: { phases: { instantiate: { medianMs: 250 }, tiny: { medianMs: 5 }, fresh: { medianMs: 9 } } },
      M2: { phases: { build: { medianMs: 19 } } },
      'M12-v2@multi': { phases: { construct: { medianMs: 1e6 } } },
    },
  };
  assert.deepEqual(findDrifts(baseline, latest), ['M1/instantiate: 100ms -> 250ms (2.5x)']);
  assert.deepEqual(findDrifts(baseline, latest, 1.5), [
    'M1/instantiate: 100ms -> 250ms (2.5x)',
    'M2/build: 10ms -> 19ms (1.9x)',
  ]);
});
