/** Gate one browser's AOT/dynamic outputs against the same-engine native fixture. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareMesh, compareStl, identity } from '../../compare-files.mjs';

const subjects = {
  gyroid: [
    { mesh: 'capture-0.mesh', stl: 'capture-0.stl', meshPin: '2b43725651c3733a' },
    { mesh: 'capture-1.mesh', stl: 'capture-1.stl' },
  ],
  heatx: [
    { mesh: 'final.mesh', stl: 'HelixHeatX.STL', meshPin: '2a13ca3e320a6075', stlPin: 'b9dac944dc434a69' },
  ],
};

/** Preserve original mesh ordering and fail even when all targets share a regression. */
export function compareParity(subject, directories) {
  if (!Object.hasOwn(subjects, subject)) throw new Error('Expected gyroid or heatx');
  const captures = subjects[subject].map((expected) => {
    const mesh = readFileSync(join(directories.native, expected.mesh));
    const stl = readFileSync(join(directories.native, expected.stl));
    // Validate the native envelope before computing the header-free historical digest.
    compareMesh(mesh, mesh);
    compareStl(stl, stl);
    const meshPin = identity(mesh.subarray(8)).historicalFnv64;
    const stlPin = identity(stl).historicalFnv64;
    const historical = {
      mesh: { expected: expected.meshPin ?? null, actual: meshPin },
      stl: { expected: expected.stlPin ?? null, actual: stlPin },
      passed:
        (!expected.meshPin || meshPin === expected.meshPin) &&
        (!expected.stlPin || stlPin === expected.stlPin),
    };
    const comparisons = ['aot', 'dynamic'].map((mode) => ({
      mode,
      mesh: compareMesh(mesh, readFileSync(join(directories[mode], expected.mesh))),
      stl: compareStl(stl, readFileSync(join(directories[mode], expected.stl))),
    }));
    return { files: { mesh: expected.mesh, stl: expected.stl }, historical, comparisons };
  });
  return {
    subject,
    passed: captures.every(
      (capture) =>
        capture.historical.passed &&
        capture.comparisons.every((row) => row.mesh.identical && row.stl.identical),
    ),
    captures,
  };
}

/**
 * The files one subject's run must produce.
 *
 * Every driver expects this one set, so a run that writes a differently named capture is a missing
 * capture rather than a silently narrower comparison.
 *
 * @param {string} subject - `gyroid` or `heatx`.
 * @returns {string[]} The sorted file names.
 */
export function parityCaptureFiles(subject) {
  if (!Object.hasOwn(subjects, subject)) throw new Error('Expected gyroid or heatx');
  return subjects[subject]
    .flatMap(({ mesh, stl }) => [mesh, stl])
    .sort((left, right) => left.localeCompare(right));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [subject, native, aot, dynamic, output, ...extra] = process.argv.slice(2);
  if (!output || extra.length)
    throw new Error(
      'Usage: compare.mjs <gyroid|heatx> <native directory> <AOT directory> <dynamic directory> <new report.json>',
    );
  const result = compareParity(subject, { native, aot, dynamic });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  if (!result.passed) process.exitCode = 1;
}
