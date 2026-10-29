import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgePerformance, runRatioCeiling } from '../gate-performance.mjs';

const native = { subject: 'gyroid', best: { runMilliseconds: 1000, peakResidentKilobytes: 400_000 } };
const measured = (overrides = {}) => ({
  engine: 'chromium',
  mode: 'tape',
  timings: { boot: 900, stage: 120, compile: 3400, run: 1200, heapBytes: 268_435_456 },
  transfer: { requests: 180, bytes: 90_000_000 },
  ...overrides,
});

test('the ruled ceiling is the one R31 names and is applied to geometry time', () => {
  assert.equal(runRatioCeiling, 1.3);
  const judged = judgePerformance(native, [measured()]);
  assert.equal(judged.passed, true);
  assert.equal(judged.paths[0].ratio, 1.2);
  // Everything else is kept, not gated: no ceiling was ruled for them.
  assert.deepEqual(judged.paths[0].recorded, {
    coldStartMilliseconds: 900,
    stageMilliseconds: 120,
    compileMilliseconds: 3400,
    editCompileMilliseconds: undefined,
    editRunMilliseconds: undefined,
    transferBytes: 90_000_000,
    transferRequests: 180,
    heapBytes: 268_435_456,
  });
});

test('a path over the ceiling fails and says by how much', () => {
  const judged = judgePerformance(native, [measured({ timings: { boot: 1, run: 1400 } })]);
  assert.equal(judged.passed, false);
  assert.equal(judged.paths[0].status, 'failed');
  assert.match(judged.paths[0].reason, /1\.40x the matched native run/);
});

test('a slow cold start, edit, transfer or heap is recorded without failing the gate', () => {
  const judged = judgePerformance(native, [
    measured({
      timings: {
        boot: 60_000,
        compile: 90_000,
        editCompile: 45_000,
        editRun: 1100,
        run: 1100,
        heapBytes: 4e9,
      },
      transfer: { requests: 900, bytes: 4e9 },
    }),
  ]);
  assert.equal(judged.passed, true);
  assert.equal(judged.paths[0].recorded.coldStartMilliseconds, 60_000);
  assert.equal(judged.paths[0].recorded.editCompileMilliseconds, 45_000);
});

test('a path that reported no geometry time is unmeasured, and unmeasured never passes', () => {
  const judged = judgePerformance(native, [measured({ timings: { boot: 900 } })]);
  assert.equal(judged.passed, false);
  assert.equal(judged.paths[0].status, 'unmeasured');
  assert.match(judged.paths[0].reason, /no geometry time/);
  // No path at all is not a pass either.
  assert.equal(judgePerformance(native, []).passed, false);
});

test('one slow path fails the whole judgement, whatever the others did', () => {
  const judged = judgePerformance(native, [
    measured({ engine: 'firefox' }),
    measured({ engine: 'webkit', mode: 'callback', timings: { boot: 1, run: 2600 } }),
  ]);
  assert.equal(judged.passed, false);
  assert.deepEqual(
    judged.paths.map((path) => path.status),
    ['passed', 'failed'],
  );
});
