interface DispatchRequest {
  readonly elementCount: number;
  readonly maxWorkgroupsPerDimension: number;
  readonly workgroupSize: number;
}

export interface DispatchPlan {
  readonly dispatchedInvocations: number;
  readonly dispatchX: number;
  readonly dispatchY: number;
}

export const planDispatch = ({
  elementCount,
  maxWorkgroupsPerDimension,
  workgroupSize,
}: DispatchRequest): DispatchPlan => {
  if (
    !Number.isSafeInteger(elementCount) ||
    elementCount <= 0 ||
    !Number.isSafeInteger(maxWorkgroupsPerDimension) ||
    maxWorkgroupsPerDimension <= 0 ||
    !Number.isSafeInteger(workgroupSize) ||
    workgroupSize <= 0
  ) {
    throw new RangeError('Dispatch inputs must be positive safe integers');
  }

  const workgroups = Math.ceil(elementCount / workgroupSize);
  const dispatchX = Math.min(workgroups, maxWorkgroupsPerDimension);
  const dispatchY = Math.ceil(workgroups / dispatchX);
  if (dispatchY > maxWorkgroupsPerDimension) {
    throw new RangeError(`${elementCount} invocations exceeds the negotiated 2D dispatch capacity`);
  }
  return {
    dispatchedInvocations: dispatchX * dispatchY * workgroupSize,
    dispatchX,
    dispatchY,
  };
};
