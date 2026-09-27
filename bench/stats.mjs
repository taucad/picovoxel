const sorted = (values) => [...values].sort((a, b) => a - b);

const median = (values) => {
  const ordered = sorted(values);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
};

const nearestRank = (values, percentile) => {
  const ordered = sorted(values);
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)];
};

const requireSamples = (values, name = 'samples') => {
  if (values.length === 0) throw new RangeError(`${name} must contain at least one sample`);
  values.forEach((value, index) => {
    if (!(value > 0) || !Number.isFinite(value)) {
      throw new RangeError(`${name}[${index}] must be a finite positive number, got ${value}`);
    }
  });
};

export const summarizeSamples = (values) => {
  requireSamples(values);
  const centre = median(values);
  return {
    samples: [...values],
    median: centre,
    min: Math.min(...values),
    max: Math.max(...values),
    mad: median(values.map((value) => Math.abs(value - centre))),
    p95: nearestRank(values, 0.95),
  };
};

const randomGenerator = (seed) => {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
};

export const summarizeBootstrapMedian = (values, { iterations = 10_000, seed = 0x7069636f } = {}) => {
  requireSamples(values);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new RangeError(`iterations must be a positive integer, got ${iterations}`);
  }
  const random = randomGenerator(seed);
  const bootstrap = Array.from({ length: iterations }, () =>
    median(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)])),
  );
  return {
    ...summarizeSamples(values),
    ci95: {
      low: nearestRank(bootstrap, 0.025),
      high: nearestRank(bootstrap, 0.975),
    },
    bootstrap: { iterations, seed },
  };
};

export const summarizePairedSamples = ({ slowMs, fastMs, iterations = 10_000, seed = 0x7069636f }) => {
  if (slowMs.length === 0 || slowMs.length !== fastMs.length) {
    throw new RangeError('slowMs and fastMs must contain the same non-zero number of samples');
  }
  requireSamples(slowMs, 'slowMs');
  requireSamples(fastMs, 'fastMs');
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new RangeError(`iterations must be a positive integer, got ${iterations}`);
  }

  const ratios = slowMs.map((slow, index) => slow / fastMs[index]);
  const logRatios = ratios.map(Math.log);
  const random = randomGenerator(seed);
  const bootstrap = Array.from({ length: iterations }, () => {
    const sample = Array.from({ length: logRatios.length }, () => logRatios[Math.floor(random() * logRatios.length)]);
    return median(sample);
  });

  return {
    slow: summarizeSamples(slowMs),
    fast: summarizeSamples(fastMs),
    ratios,
    medianRatio: Math.exp(median(logRatios)),
    ci95: {
      low: Math.exp(nearestRank(bootstrap, 0.025)),
      high: Math.exp(nearestRank(bootstrap, 0.975)),
    },
    bootstrap: { iterations, seed },
  };
};

export const fitLinearCost = (points) => {
  if (points.length < 2) throw new RangeError('linear cost fit needs at least two points');
  for (const [index, point] of points.entries()) {
    if (!Number.isFinite(point.bytes) || point.bytes < 0 || !Number.isFinite(point.ms) || point.ms <= 0) {
      throw new RangeError(`invalid linear cost point at index ${index}`);
    }
  }
  const meanBytes = points.reduce((sum, point) => sum + point.bytes, 0) / points.length;
  const meanMs = points.reduce((sum, point) => sum + point.ms, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.bytes - meanBytes) ** 2, 0);
  if (denominator === 0) throw new RangeError('linear cost fit needs distinct byte counts');
  const msPerByte =
    points.reduce((sum, point) => sum + (point.bytes - meanBytes) * (point.ms - meanMs), 0) / denominator;
  const baseMs = meanMs - msPerByte * meanBytes;
  const residual = points.reduce((sum, point) => sum + (point.ms - (baseMs + msPerByte * point.bytes)) ** 2, 0);
  const total = points.reduce((sum, point) => sum + (point.ms - meanMs) ** 2, 0);
  return {
    baseMs,
    baseUs: baseMs * 1_000,
    msPerByte,
    nsPerByte: msPerByte * 1_000_000,
    rSquared: total === 0 ? 1 : 1 - residual / total,
  };
};

export const collectPairedSamples = async ({ repeats = 30, warmups = 1, slow, fast }) => {
  if (!Number.isInteger(repeats) || repeats <= 0 || !Number.isInteger(warmups) || warmups < 0) {
    throw new RangeError(`repeats must be positive and warmups non-negative, got ${repeats}/${warmups}`);
  }

  for (let index = 0; index < warmups; index += 1) {
    await slow();
    await fast();
  }

  const slowMs = [];
  const fastMs = [];
  const order = [];
  for (let index = 0; index < repeats; index += 1) {
    const fastFirst = index % 2 === 0;
    if (fastFirst) {
      fastMs.push(await fast());
      slowMs.push(await slow());
      order.push('fast-first');
    } else {
      slowMs.push(await slow());
      fastMs.push(await fast());
      order.push('slow-first');
    }
  }
  requireSamples(slowMs, 'slowMs');
  requireSamples(fastMs, 'fastMs');
  return { slowMs, fastMs, order };
};

export const assertAccelerationEngaged = ({ requestedLane, activeLane, adapter, dispatchCount, resultConsumed }) => {
  if (
    activeLane === requestedLane &&
    adapter &&
    Number.isInteger(dispatchCount) &&
    dispatchCount > 0 &&
    resultConsumed
  ) {
    return;
  }
  throw new Error(
    `accelerated path did not engage: requested=${requestedLane} active=${activeLane} ` +
      `adapter=${adapter ? 'present' : 'missing'} dispatches=${dispatchCount} resultConsumed=${resultConsumed}`,
  );
};

export const preserveAppendix = (generated, existing) => {
  const appendix = existing.indexOf('## Appendix');
  return appendix === -1 ? generated : generated + existing.slice(appendix);
};
