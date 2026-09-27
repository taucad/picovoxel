import { describe, expect, it } from 'vitest';

import { planDispatch } from '../spikes/webgpu/dispatch.ts';

describe('planDispatch', () => {
  it('uses one dimension while it fits', () => {
    expect(
      planDispatch({
        elementCount: 1_000_000,
        maxWorkgroupsPerDimension: 65_535,
        workgroupSize: 64,
      }),
    ).toEqual({
      dispatchX: 15_625,
      dispatchY: 1,
      dispatchedInvocations: 1_000_000,
    });
  });

  it('reshapes 16M invocations across two dimensions', () => {
    expect(
      planDispatch({
        elementCount: 16 * 1024 * 1024,
        maxWorkgroupsPerDimension: 65_535,
        workgroupSize: 64,
      }),
    ).toEqual({
      dispatchX: 65_535,
      dispatchY: 5,
      dispatchedInvocations: 20_971_200,
    });
  });

  it('rejects work that cannot fit the negotiated two-dimensional limit', () => {
    expect(() =>
      planDispatch({
        elementCount: 65_535 * 65_535 * 64 + 1,
        maxWorkgroupsPerDimension: 65_535,
        workgroupSize: 64,
      }),
    ).toThrow('exceeds the negotiated 2D dispatch capacity');
  });
});
