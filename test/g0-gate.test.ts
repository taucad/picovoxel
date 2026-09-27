// The per-commit identity gate (G0):
// N=2 run-to-run identity + a pinned reference, HeatX on the multi build at
// {1.0, 0.7} mm. The two halves are complementary and neither is droppable:
// identity catches races (p-per-run faults compound across commits — a 1-in-6
// race is 95%-caught within 9 commits at N=2); the reference catches
// deterministic wrongness (p=1 stable-wrong, e.g. a wrong seal count,
// invisible to identity at any N). The multi build is the race-prone one; the
// reference is build-invariant (single≡multi), so matching it IS the
// cross-build check.
//
// Pins regenerate deliberately: UPDATE_PINS=1. A drift here is a geometry
// change — name the cause in the commit that moves the pin.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { G0_FIELDS, compareG0, oraclesAgree } from '../bench/g0-compare.mjs';
import { g0Record } from '../bench/g0-identity.mjs';
import { assertPinSource } from '../bench/pin-guard.mjs';

const fixturePath = join(import.meta.dirname, 'fixtures', 'g0-reference.json');
const updatePins = process.env.UPDATE_PINS === '1';

/** The environment-free slice of a record — what the reference pins. */
const tuple = (record: Record<string, unknown>) => Object.fromEntries(G0_FIELDS.map((f) => [f, record[f]]));

/** A G0 record with its value provenance typed for the pin guard. */
type G0Run = Omit<Awaited<ReturnType<typeof g0Record>>, 'provenance'> & { provenance: string | undefined };

for (const size of [1.0, 0.7]) {
  const key = `heatx@${size}mm`;
  // 105 s for both scales on the M2 Pro reference machine (within the ≤5 min
  // charter bar); the generous timeout is for CI-class hardware only.
  test(
    `G0 per-commit gate — HeatX @ ${size} mm multi: N=2 identity + reference`,
    { timeout: 1_800_000 },
    async () => {
      const runs: G0Run[] = [
        await g0Record({ fixture: 'heatx', build: 'multi', size }),
        await g0Record({ fixture: 'heatx', build: 'multi', size }),
      ];
      for (const run of runs) {
        assert.equal(run.nonFiniteRecords, 0, 'a non-finite coordinate is never legitimate output');
      }
      assert.deepEqual(compareG0(runs[0]!, runs[1]!), [], 'run-to-run G0 identity (the race canary)');
      assert.ok(oraclesAgree(runs[0]!, runs[1]!), 'field and mesh oracles agree');

      assertPinSource(runs[0]!.provenance, key); // LANES item 3 — only exact sources pin
      if (updatePins) {
        const pins = (existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, 'utf8')) : {}) as Record<
          string,
          unknown
        >;
        pins[key] = tuple(runs[0]!);
        writeFileSync(fixturePath, `${JSON.stringify(pins, null, 1)}\n`);
      } else {
        const pins = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(
          tuple(runs[0]!),
          pins[key],
          `${key} drifted from its G0 reference — a geometry change; regenerate deliberately with UPDATE_PINS=1 and name the cause`,
        );
      }
    },
  );
}
