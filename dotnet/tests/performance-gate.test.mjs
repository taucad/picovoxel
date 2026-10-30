import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isJudgedMode, judgedSubjects, judgePerformance, runRatioCeiling } from '../gate-performance.mjs';

// The ceiling is ruled on the long subject, so the cases that exercise it measure that one.
const native = { subject: 'heatx', best: { runMilliseconds: 1000, peakResidentKilobytes: 400_000 } };
const shortSubject = { ...native, subject: 'gyroid' };
const measured = (overrides = {}) => ({
  engine: 'chromium',
  mode: 'dynamic-threaded-tape',
  timings: { boot: 900, stage: 120, compile: 3400, run: 1200, heapBytes: 268_435_456 },
  transfer: { requests: 180, bytes: 90_000_000 },
  ...overrides,
});

test('the ruled ceiling is the one R31 names and is applied to geometry time', () => {
  assert.equal(runRatioCeiling, 2);
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
  const judged = judgePerformance(native, [measured({ timings: { boot: 1, run: 2400 } })]);
  assert.equal(judged.passed, false);
  assert.equal(judged.paths[0].status, 'failed');
  assert.match(judged.paths[0].reason, /2\.40x the matched native run/);
});

test('a path between the first ceiling and the ruled one passes, because the ruling moved', () => {
  // 1.40x failed under the 1.3 this program measured against first and passes under the 2 it rules
  // now. The case is kept rather than replaced so the change of ruling is visible in the suite.
  const judged = judgePerformance(native, [measured({ timings: { boot: 1, run: 1400 } })]);
  assert.equal(judged.passed, true);
  assert.equal(judged.paths[0].ratio, 1.4);
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
    measured({ engine: 'webkit', mode: 'dynamic-threaded-callback', timings: { boot: 1, run: 2600 } }),
  ]);
  assert.equal(judged.passed, false);
  assert.deepEqual(
    judged.paths.map((path) => path.status),
    ['passed', 'failed'],
  );
});

test('the ruling names the long subject, and only it', () => {
  assert.deepEqual([...judgedSubjects], ['heatx']);
});

test("the short subject's ratio is recorded rather than gated, and still reported", () => {
  const judged = judgePerformance(shortSubject, [measured({ timings: { boot: 1, run: 2749 } })]);
  // 2.749x is the figure CI measured on the short subject's serial path. It is kept, with its
  // number, and it does not decide this gate: the ceiling is a statement about geometry, and
  // 167 ms of geometry is dominated by costs that are paid once.
  assert.equal(judged.judged, false);
  assert.equal(judged.passed, true);
  assert.equal(judged.paths[0].status, 'recorded');
  assert.equal(judged.paths[0].ratio, 2.749);
  assert.match(judged.paths[0].note, /recorded not gated/u);
  // `recorded` is not spelled `passed`, so no reader can mistake one for the other.
  assert.equal(judged.paths[0].reason, undefined);
});

test('an unmeasured path fails on the short subject too, where no ceiling is judged', () => {
  const judged = judgePerformance(shortSubject, [measured({ timings: { boot: 900 } })]);
  assert.equal(judged.passed, false);
  assert.equal(judged.paths[0].status, 'unmeasured');
  // And a run with no path at all is not a pass on either subject.
  assert.equal(judgePerformance(shortSubject, []).passed, false);
});

test('the ceiling judges threaded paths only, as ruled on 2026-10-30', () => {
  for (const mode of ['aot-threaded', 'dynamic-threaded-tape', 'dynamic-threaded-callback'])
    assert.equal(isJudgedMode(mode), true, mode);
  for (const mode of ['aot', 'dynamic-tape', 'dynamic-callback'])
    assert.equal(isJudgedMode(mode), false, mode);
});

test('a serial path over the ceiling on the long subject is recorded with its ratio, not failed', () => {
  // 2.220x is the serial tape figure Chromium measured on the long subject in run 40992452108.
  const judged = judgePerformance(native, [
    measured({ mode: 'aot-threaded', timings: { boot: 1, run: 1320 } }),
    measured({ mode: 'dynamic-tape', timings: { boot: 1, run: 2220 } }),
  ]);
  assert.equal(judged.passed, true);
  assert.deepEqual(
    judged.paths.map((path) => path.status),
    ['passed', 'recorded'],
  );
  assert.equal(judged.paths[1].ratio, 2.22);
  assert.match(judged.paths[1].note, /recorded not gated/u);
});

test('an unmeasured serial path still fails the long subject', () => {
  const judged = judgePerformance(native, [measured(), measured({ mode: 'aot', timings: { boot: 1 } })]);
  assert.equal(judged.passed, false);
  assert.equal(judged.paths[1].status, 'unmeasured');
});

test('the long subject with no threaded path measured has nothing to pass', () => {
  const judged = judgePerformance(native, [measured({ mode: 'aot', timings: { boot: 1, run: 1100 } })]);
  assert.equal(judged.paths[0].status, 'recorded');
  assert.equal(judged.passed, false);
});

test('a per-engine baseline divides each path by native timed on its own runner', () => {
  const judged = judgePerformance(
    {
      chromium: { ...native, best: { runMilliseconds: 1000 } },
      webkit: { ...native, best: { runMilliseconds: 2000 } },
    },
    [
      measured({ timings: { boot: 1, run: 2400 } }),
      measured({ engine: 'webkit', timings: { boot: 1, run: 2400 } }),
    ],
  );
  assert.deepEqual(
    judged.paths.map((path) => [path.engine, path.native, path.ratio, path.status]),
    [
      ['chromium', 1000, 2.4, 'failed'],
      ['webkit', 2000, 1.2, 'passed'],
    ],
  );
  assert.equal(judged.passed, false);
});

test('a path whose engine has no baseline on its runner is unmeasured and fails', () => {
  const judged = judgePerformance({ chromium: native }, [measured(), measured({ engine: 'firefox' })]);
  assert.equal(judged.paths[1].status, 'unmeasured');
  assert.match(judged.paths[1].reason, /no native baseline/i);
  assert.equal(judged.passed, false);
});

test('per-engine baselines must measure one subject', () => {
  assert.throws(
    () => judgePerformance({ chromium: native, webkit: shortSubject }, [measured()]),
    /different subjects/,
  );
});

test("a path's own baseline is used before its engine's", () => {
  const judged = judgePerformance(
    { chromium: native, 'chromium:dynamic-threaded-tape': { ...native, best: { runMilliseconds: 600 } } },
    [measured(), measured({ mode: 'aot-threaded' })],
  );
  assert.deepEqual(
    judged.paths.map((path) => [path.mode, path.native, path.ratio]),
    [
      ['dynamic-threaded-tape', 600, 2],
      ['aot-threaded', 1000, 1.2],
    ],
  );
});
