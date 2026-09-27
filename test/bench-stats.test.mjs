import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import {
  assertAccelerationEngaged,
  collectPairedSamples,
  fitLinearCost,
  preserveAppendix,
  summarizeBootstrapMedian,
  summarizePairedSamples,
  summarizeSamples,
} from '../bench/stats.mjs';

test('should summarize raw samples without discarding their distribution', () => {
  assert.deepEqual(summarizeSamples([1, 2, 3, 4, 100]), {
    samples: [1, 2, 3, 4, 100],
    median: 3,
    min: 1,
    max: 100,
    mad: 1,
    p95: 100,
  });
});

test('should produce a deterministic paired-ratio confidence interval', () => {
  const first = summarizePairedSamples({
    slowMs: [20, 22, 24, 26, 28],
    fastMs: [10, 11, 12, 13, 14],
    iterations: 1_000,
    seed: 42,
  });
  const second = summarizePairedSamples({
    slowMs: [20, 22, 24, 26, 28],
    fastMs: [10, 11, 12, 13, 14],
    iterations: 1_000,
    seed: 42,
  });

  assert.deepEqual(first, second);
  assert.equal(first.medianRatio, 2);
  assert.equal(first.ci95.low, 2);
  assert.equal(first.ci95.high, 2);
  assert.deepEqual(first.ratios, [2, 2, 2, 2, 2]);
});

test('should produce deterministic confidence bounds for a single-lane median', () => {
  const first = summarizeBootstrapMedian([9, 10, 11, 12, 13], {
    iterations: 2_000,
    seed: 17,
  });
  const second = summarizeBootstrapMedian([9, 10, 11, 12, 13], {
    iterations: 2_000,
    seed: 17,
  });

  assert.deepEqual(first, second);
  assert.equal(first.median, 11);
  assert.ok(first.ci95.low <= first.median);
  assert.ok(first.ci95.high >= first.median);
});

test('should fit a base latency plus a per-byte cost', () => {
  const fit = fitLinearCost([
    { bytes: 1_000, ms: 0.102 },
    { bytes: 2_000, ms: 0.104 },
    { bytes: 4_000, ms: 0.108 },
  ]);

  assert.ok(Math.abs(fit.baseUs - 100) < 1e-9);
  assert.ok(Math.abs(fit.nsPerByte - 2) < 1e-9);
});

test('should alternate paired lane order and exclude warmups', async () => {
  const calls = [];
  let slow = 0;
  let fast = 0;
  const samples = await collectPairedSamples({
    repeats: 4,
    warmups: 1,
    slow: async () => {
      calls.push('slow');
      slow += 1;
      return slow;
    },
    fast: async () => {
      calls.push('fast');
      fast += 1;
      return fast / 2;
    },
  });

  assert.deepEqual(calls, ['slow', 'fast', 'fast', 'slow', 'slow', 'fast', 'fast', 'slow', 'slow', 'fast']);
  assert.deepEqual(samples.slowMs, [2, 3, 4, 5]);
  assert.deepEqual(samples.fastMs, [1, 1.5, 2, 2.5]);
  assert.deepEqual(samples.order, ['fast-first', 'slow-first', 'fast-first', 'slow-first']);
});

test('should reject invalid or unpaired timing samples', () => {
  assert.throws(() => summarizePairedSamples({ slowMs: [2], fastMs: [1, 1] }), {
    name: 'RangeError',
    message: 'slowMs and fastMs must contain the same non-zero number of samples',
  });
  assert.throws(() => summarizeSamples([1, Number.NaN]), {
    name: 'RangeError',
    message: 'samples[1] must be a finite positive number, got NaN',
  });
});

test('should fail loudly when an accelerated path did not engage', () => {
  assert.doesNotThrow(() =>
    assertAccelerationEngaged({
      requestedLane: 'gpu',
      activeLane: 'gpu',
      adapter: 'Apple M2 Pro',
      dispatchCount: 2,
      resultConsumed: true,
    }),
  );
  assert.throws(
    () =>
      assertAccelerationEngaged({
        requestedLane: 'gpu',
        activeLane: 'cpu',
        adapter: null,
        dispatchCount: 0,
        resultConsumed: false,
      }),
    {
      name: 'Error',
      message:
        'accelerated path did not engage: requested=gpu active=cpu adapter=missing dispatches=0 resultConsumed=false',
    },
  );
});

test('should pair allocator A/B samples across blocks and name regressions honestly', () => {
  // A silent mis-pairing here would corrupt the SK-0.1 headline rather than fail
  // loudly, so the script is driven end to end over two blocks per side.
  const run = (win, lose) => ({
    fingerprint: {},
    results: {
      M: { phases: { win: { samplesMs: win }, lose: { samplesMs: lose } }, identity: null },
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'alloc-ab-'));
  const write = (name, body) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };
  // Two blocks per side: 'win' halves under B, 'lose' doubles under B.
  const a1 = write('a1.json', run([100, 100], [10, 10]));
  const a2 = write('a2.json', run([100, 100], [10, 10]));
  const b1 = write('b1.json', run([50, 50], [20, 20]));
  const b2 = write('b2.json', run([50, 50], [20, 20]));

  const out = execFileSync(process.execPath, [resolve('bench/alloc-ab.mjs'), `${a1},${a2}`, `${b1},${b2}`], {
    encoding: 'utf8',
  });

  assert.match(out, /\| M \| win \| 100\.000 \| 50\.000 \| -50\.0% \| 2\.000× \|.*\| faster \|/);
  assert.match(out, /\| M \| lose \| 10\.000 \| 20\.000 \| \+100\.0% \| 0\.500× \|.*\| \*\*REGRESSION\*\* \|/);
  assert.match(out, /2 phases compared: 1 faster, 1 regressions/);
  assert.match(out, /REGRESSION M\/lose: 0\.500×/);
});

test('should skip allocator phases whose sample counts do not match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alloc-ab-'));
  const body = (samples) => ({ fingerprint: {}, results: { M: { phases: { p: { samplesMs: samples } } } } });
  const a = join(dir, 'a.json');
  const b = join(dir, 'b.json');
  writeFileSync(a, JSON.stringify(body([1, 2, 3])));
  writeFileSync(b, JSON.stringify(body([1, 2])));
  const out = execFileSync(process.execPath, [resolve('bench/alloc-ab.mjs'), a, b], { encoding: 'utf8' });
  assert.match(out, /skipped \(sample-count mismatch\)/);
  assert.match(out, /M\/p \(A=3 B=2 samples\)/);
});

test('should preserve the hand-written benchmark appendix', () => {
  assert.equal(
    preserveAppendix('# generated\n', '# old table\n\n## Appendix\n\nkeep me\n'),
    '# generated\n## Appendix\n\nkeep me\n',
  );
  assert.equal(preserveAppendix('# generated\n', '# old table\n'), '# generated\n');
});
