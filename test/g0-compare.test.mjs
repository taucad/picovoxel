// The identity record math (bench/g0-compare.mjs): comparators, the tolerance
// gate and the verdicts, driven by hand-built records — no geometry runs.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import {
  G0_FIELDS,
  SWEEP,
  compareG0,
  compareG1,
  fastLegVerdict,
  hexFloat,
  measureHealthy,
  oraclesAgree,
  replayGates,
  tightLegVerdict,
} from '../bench/g0-compare.mjs';

const base = Object.fromEntries(G0_FIELDS.map((field) => [field, 'v']));
/** A healthy G1 record: hexFloat(100) makes the live and rebuilt volumes agree. */
const g1 = {
  ...base,
  volumeHex: hexFloat(100),
  propVolume: 100,
  propArea: 50,
  boundsMin: [0, 0, 0],
  boundsMax: [10, 10, 10],
  diagnose: '',
};
/** Rebuilt at 1.93× the live volume — the observed measure pathology. */
const sick = { ...g1, propVolume: 193 };
const where = { fixture: 'heatx', build: 'single', size: 0.5 };

let log;
let error;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

test('hexFloat is the zero-padded bit pattern of a float64', () => {
  assert.equal(hexFloat(1), '3ff0000000000000');
  assert.equal(hexFloat(0), '0000000000000000');
});

test('compareG0 flags exactly the fields that differ', () => {
  assert.deepEqual(compareG0(base, { ...base }), []);
  for (const field of G0_FIELDS) {
    assert.deepEqual(compareG0(base, { ...base, [field]: 'x' }), [field], `mutation of ${field}`);
  }
});

test('oraclesAgree: the field and mesh oracles must render one verdict', () => {
  assert.ok(oraclesAgree(base, { ...base }), 'identical records agree');
  assert.ok(oraclesAgree(base, { ...base, gridHash: 'x', multiset: 'x' }), 'both-sides drift agrees');
  assert.ok(!oraclesAgree(base, { ...base, gridHash: 'x' }), 'field-only drift must disagree');
  assert.ok(!oraclesAgree(base, { ...base, multiset: 'x' }), 'mesh-only drift must disagree');
});

test('measureHealthy: the rebuilt/live volume ratio must stay inside (1/1.5, 1.5)', () => {
  assert.ok(measureHealthy(g1));
  assert.ok(!measureHealthy(sick));
  assert.ok(!measureHealthy({ ...g1, propVolume: 60 }), 'a collapsed rebuild is unhealthy too');
  assert.ok(measureHealthy({ ...g1, volumeHex: hexFloat(0), propVolume: 0 }), 'empty and empty agree');
  assert.ok(
    !measureHealthy({ ...g1, volumeHex: hexFloat(0), propVolume: 5 }),
    'empty live, non-empty rebuild',
  );
});

test('compareG1: 3% volume and area, one voxel of bounds, no new level-set dirt', () => {
  assert.deepEqual(compareG1(g1, g1, 0.5), []);
  assert.deepEqual(compareG1({ ...g1, propVolume: 102.9 }, g1, 0.5), [], '2.9% volume drift passes');
  assert.equal(compareG1({ ...g1, propVolume: 103.1 }, g1, 0.5).length, 1, '3.1% volume drift fails');
  assert.equal(compareG1({ ...g1, propArea: 48.4 }, g1, 0.5).length, 1, '3.2% area drift fails');
  assert.equal(compareG1({ ...g1, boundsMax: [10, 10, 10.6] }, g1, 0.5).length, 1, '>1 voxel max bound');
  assert.equal(compareG1({ ...g1, boundsMin: [0, -0.6, 0] }, g1, 0.5).length, 1, '>1 voxel min bound');
  assert.deepEqual(compareG1({ ...g1, boundsMin: [-0.4, 0, 0] }, g1, 0.5), [], '<1 voxel passes');
  assert.equal(compareG1({ ...g1, diagnose: 'dirty' }, g1, 0.5).length, 1, 'fast-only dirt fails');
  assert.deepEqual(
    compareG1({ ...g1, diagnose: 'dirty' }, { ...g1, diagnose: 'dirty' }, 0.5),
    [],
    'inherited',
  );
  // An unhealthy reference skips the mesh-measure legs, but the live-volume leg still binds.
  assert.deepEqual(compareG1(g1, sick, 0.5), []);
  assert.equal(compareG1({ ...g1, volumeHex: hexFloat(104) }, sick, 0.5).length, 1);
  assert.equal(compareG1(sick, g1, 0.5).length, 1, 'a fast-side-only measure pathology fails loudly');
});

test('fastLegVerdict fails on a G1 failure and reports coincidence, dirt and unhealthy references', () => {
  assert.equal(fastLegVerdict({ ...g1, propArea: 40 }, g1, where), true);
  assert.match(error.mock.calls.at(-1)[0], /FAIL G1 fast\/single heatx@0.5/);

  assert.equal(fastLegVerdict(g1, g1, where), false);
  assert.match(log.mock.calls.at(-1)[0], /gates clean \(G0-coincident\)$/);

  const dirty = { ...g1, gridHash: 'x', multiset: 'x', diagnose: 'kink' };
  assert.equal(fastLegVerdict(dirty, { ...g1, diagnose: 'kink' }, where), false);
  assert.match(log.mock.calls.at(-1)[0], /gates clean \(WARN inherited checkLevelSet dirt/);

  assert.equal(fastLegVerdict(sick, sick, where), false);
  assert.match(log.mock.calls.at(-2)[0], /measure-UNHEALTHY/);
});

test('tightLegVerdict demands identity with the exact reference', () => {
  assert.equal(tightLegVerdict(base, { ...base }, where), false);
  assert.match(log.mock.calls.at(-1)[0], /≡ exact reference/);
  assert.equal(tightLegVerdict({ ...base, gridHash: 'x' }, base, where), true);
  assert.match(error.mock.calls.at(-1)[0], /\[gridHash\]/);
});

test('replayGates re-derives every verdict from a recorded sweep', () => {
  const directory = mkdtempSync(join(tmpdir(), 'g0-compare-'));
  const replay = (rows) => {
    const path = join(directory, `${Math.random()}.jsonl`);
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    return replayGates(path);
  };
  assert.ok(SWEEP.some(({ fixture, sizes }) => fixture === 'heatx' && sizes.includes(1)));

  const clean = [
    { ...g1, label: 'heatx@1mm/single#1' },
    { ...g1, label: 'heatx@1mm/single#2', gridHash: 'later runs never replace the first' },
    { ...g1, label: 'heatx@1mm/single:fast#1' },
    { ...g1, label: 'heatx@1mm/multi:fast#1' }, // no exact multi leg: skipped
    { ...g1, label: 'heatx@1mm/single:fast-tight' },
  ];
  assert.equal(replay(clean), false);
  assert.equal(
    replay([...clean.slice(0, 3), { ...g1, label: 'heatx@1mm/single:fast-tight', gridHash: 'x' }]),
    true,
  );
  assert.equal(
    replay([
      { ...g1, label: 'heatx@1mm/single#1' },
      { ...g1, propArea: 1, label: 'heatx@1mm/single:fast#1' },
    ]),
    true,
  );
  // A tight leg without its exact reference, and a fast leg without either, are skipped.
  assert.equal(
    replay([
      { ...g1, label: 'heatx@0.7mm/single:fast-tight' },
      { ...g1, label: 'gyroid@0.25mm/multi:fast' },
    ]),
    false,
  );
});
