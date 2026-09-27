import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { waitForRegistry } from '../../scripts/registry-wait.mjs';

const manifest = {
  packages: [
    { name: 'picovoxel', version: '0.1.0', filename: 'picovoxel-0.1.0.tgz', integrity: 'sha512-candidate' },
  ],
  version: '0.1.0',
};

const published = (integrity) => ({
  dist: {
    attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/picovoxel@0.1.0' },
    integrity,
  },
});

const harness = (view) => {
  const logged = [];
  const sleeps = [];
  const viewed = [];
  let clock = 0;
  return {
    logged,
    sleeps,
    viewed,
    options: {
      log: (message) => logged.push(message),
      manifest,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      view: (name, version) => {
        viewed.push(`${name}@${version}`);
        return view(viewed.length);
      },
    },
  };
};

describe('bounded registry visibility wait', () => {
  it('resolves once the registry serves the candidate integrity with an attestation', async () => {
    const { logged, options, sleeps, viewed } = harness((call) =>
      call < 3 ? null : published('sha512-candidate'),
    );

    await waitForRegistry(options);

    assert.deepEqual(sleeps, [30_000, 60_000]);
    assert.deepEqual(viewed, ['picovoxel@0.1.0', 'picovoxel@0.1.0', 'picovoxel@0.1.0']);
    assert.equal(logged[0], 'attempt 1 after 0s: 0/1 packages available');
    assert.equal(logged.at(-1), 'all 1 packages are visible with matching integrity');
  });

  it('fails at once when the registry serves other bytes', async () => {
    const { options, sleeps } = harness(() => published('sha512-tampered'));

    await assert.rejects(waitForRegistry(options), {
      name: 'Error',
      message:
        'picovoxel@0.1.0: registry integrity sha512-tampered differs from the candidate sha512-candidate',
    });
    assert.deepEqual(sleeps, []);
  });

  it('keeps waiting for a published version whose attestation is not served', async () => {
    const { options } = harness(() => ({ dist: { integrity: 'sha512-candidate' } }));

    await assert.rejects(waitForRegistry(options), /unavailable: picovoxel \(no attestations\)/u);
  });

  it('times out on the deadline, naming the package that never appeared', async () => {
    const { options, sleeps } = harness(() => null);

    await assert.rejects(
      waitForRegistry(options),
      /^Error: timed out after 30 minutes; unavailable: picovoxel \(not published\)$/u,
    );
    // 30 s doubling to the 300 s cap, the last wait trimmed so the final poll
    // lands exactly on the thirty-minute deadline.
    assert.deepEqual(sleeps, [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000, 150_000]);
    assert.equal(
      sleeps.reduce((total, wait) => total + wait, 0),
      30 * 60_000,
    );
  });

  it('honours a configured interval, ceiling and timeout', async () => {
    const { options, sleeps } = harness(() => null);

    await assert.rejects(
      waitForRegistry({ ...options, intervalMs: 1_000, maxIntervalMs: 4_000, timeoutMs: 20_000 }),
      /timed out after 0\.3 minutes/u,
    );
    assert.deepEqual(sleeps, [1_000, 2_000, 4_000, 4_000, 4_000, 4_000, 1_000]);
  });

  it('refuses an interval, ceiling or timeout that is not a positive number', async () => {
    const { options, sleeps } = harness(() => null);
    for (const [key, value] of [
      ['intervalMs', Number.NaN],
      ['maxIntervalMs', 0],
      ['timeoutMs', -1],
      ['timeoutMs', Number.POSITIVE_INFINITY],
    ]) {
      await assert.rejects(
        waitForRegistry({ ...options, [key]: value }),
        new RegExp(`${key} must be a positive number`, 'u'),
      );
    }
    assert.deepEqual(sleeps, []);
  });

  it('refuses a manifest without packages', async () => {
    const { options } = harness(() => null);

    await assert.rejects(
      waitForRegistry({ ...options, manifest: { packages: [], version: '0.1.0' } }),
      /the candidate manifest lists no packages/u,
    );
    await assert.rejects(waitForRegistry({ ...options, manifest: {} }), /lists no packages/u);
  });
});
