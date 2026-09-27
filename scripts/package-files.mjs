import path from 'node:path';

// Initial 0.1.0 package contract, measured on 2026-09-27 from the unbundled
// build (close-out T1.2, D13) on 38bdac8 (the lane menu added dist/lanes.js):
// one .js per source module (unhashed), a .d.ts for every module a public
// declaration reaches, the four copied Emscripten artifacts, the CommonJS
// diagnostic and the docs. Change the list and the ceiling together in the
// causing pull request. PR #8 review: +1 for dist/cjs-error.d.cts. PR #9
// (createPicoRuntime): +2 for dist/pico.exports.js and dist/pico-multi.exports.js,
// the per-build export names the wasmModule pre-flight checks (generated beside
// the CI-built wasm). PR3: +3 for the shipped compatibility.md, CHANGELOG.md
// and BREAKING_CHANGES.md.
const PACKAGE_FILE_COUNT_CEILING = 137;

export const PACKAGE_FILES = [
  'BREAKING_CHANGES.md',
  'CHANGELOG.md',
  'MIGRATING-FROM-CSHARP.md',
  'NOTICE',
  'README.md',
  'dist/cjs-error.cjs',
  'dist/cjs-error.d.cts',
  'dist/context.js',
  'dist/dispose.d.ts',
  'dist/dispose.js',
  'dist/errors.d.ts',
  'dist/errors.js',
  'dist/fieldUtils.d.ts',
  'dist/fieldUtils.js',
  'dist/fields.d.ts',
  'dist/fields.js',
  'dist/glb.js',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/lanes.js',
  'dist/lattice.d.ts',
  'dist/lattice.js',
  'dist/latticelibrary.d.ts',
  'dist/latticelibrary.js',
  'dist/latticelibrary/beamThickness.d.ts',
  'dist/latticelibrary/beamThickness.js',
  'dist/latticelibrary/cellArrays.d.ts',
  'dist/latticelibrary/cellArrays.js',
  'dist/latticelibrary/coordinateTrafo.d.ts',
  'dist/latticelibrary/coordinateTrafo.js',
  'dist/latticelibrary/latticeTypes.d.ts',
  'dist/latticelibrary/latticeTypes.js',
  'dist/latticelibrary/randomDeformationField.d.ts',
  'dist/latticelibrary/randomDeformationField.js',
  'dist/latticelibrary/rawTpmsPatterns.d.ts',
  'dist/latticelibrary/rawTpmsPatterns.js',
  'dist/latticelibrary/splittingLogic.d.ts',
  'dist/latticelibrary/splittingLogic.js',
  'dist/latticelibrary/tpmsPresets.d.ts',
  'dist/latticelibrary/tpmsPresets.js',
  'dist/latticelibrary/unitCells.d.ts',
  'dist/latticelibrary/unitCells.js',
  'dist/mesh.d.ts',
  'dist/mesh.js',
  'dist/metadata.d.ts',
  'dist/metadata.js',
  'dist/multi.d.ts',
  'dist/multi.js',
  'dist/numerics.d.ts',
  'dist/numerics.js',
  'dist/numerics/angles.d.ts',
  'dist/numerics/angles.js',
  'dist/numerics/comparison.d.ts',
  'dist/numerics/comparison.js',
  'dist/numerics/coordinates.d.ts',
  'dist/numerics/coordinates.js',
  'dist/numerics/frame.d.ts',
  'dist/numerics/frame.js',
  'dist/numerics/matrix.d.ts',
  'dist/numerics/matrix.js',
  'dist/numerics/quaternion.d.ts',
  'dist/numerics/quaternion.js',
  'dist/numerics/vector.d.ts',
  'dist/numerics/vector.js',
  'dist/pico-multi.exports.js',
  'dist/pico-multi.mjs',
  'dist/pico-multi.wasm',
  'dist/pico.exports.js',
  'dist/pico.mjs',
  'dist/pico.wasm',
  'dist/polyline.d.ts',
  'dist/polyline.js',
  'dist/raw.d.ts',
  'dist/raw.generated.d.ts',
  'dist/raw.generated.js',
  'dist/raw.js',
  'dist/registry.d.ts',
  'dist/registry.js',
  'dist/session.d.ts',
  'dist/session.js',
  'dist/shapekernel.d.ts',
  'dist/shapekernel.js',
  'dist/shapekernel/baseBox.d.ts',
  'dist/shapekernel/baseBox.js',
  'dist/shapekernel/baseCylinder.d.ts',
  'dist/shapekernel/baseCylinder.js',
  'dist/shapekernel/baseLens.d.ts',
  'dist/shapekernel/baseLens.js',
  'dist/shapekernel/basePipe.d.ts',
  'dist/shapekernel/basePipe.js',
  'dist/shapekernel/baseRevolve.d.ts',
  'dist/shapekernel/baseRevolve.js',
  'dist/shapekernel/baseRing.d.ts',
  'dist/shapekernel/baseRing.js',
  'dist/shapekernel/baseShape.d.ts',
  'dist/shapekernel/baseShape.js',
  'dist/shapekernel/baseSphere.d.ts',
  'dist/shapekernel/baseSphere.js',
  'dist/shapekernel/frames.d.ts',
  'dist/shapekernel/frames.js',
  'dist/shapekernel/implicitUtility.d.ts',
  'dist/shapekernel/implicitUtility.js',
  'dist/shapekernel/latticePipe.d.ts',
  'dist/shapekernel/latticePipe.js',
  'dist/shapekernel/localFrame.d.ts',
  'dist/shapekernel/localFrame.js',
  'dist/shapekernel/meshUtility.d.ts',
  'dist/shapekernel/meshUtility.js',
  'dist/shapekernel/modulations.d.ts',
  'dist/shapekernel/modulations.js',
  'dist/shapekernel/sh.d.ts',
  'dist/shapekernel/sh.js',
  'dist/shapekernel/splineOperations.d.ts',
  'dist/shapekernel/splineOperations.js',
  'dist/shapekernel/splines.d.ts',
  'dist/shapekernel/splines.js',
  'dist/shapekernel/uf.d.ts',
  'dist/shapekernel/uf.js',
  'dist/shapekernel/vecOperations.d.ts',
  'dist/shapekernel/vecOperations.js',
  'dist/slicing.d.ts',
  'dist/slicing.js',
  'dist/stl.d.ts',
  'dist/stl.js',
  'dist/tape.d.ts',
  'dist/tape.js',
  'dist/three.d.ts',
  'dist/three.js',
  'dist/types.d.ts',
  'dist/types.js',
  'dist/vdb.d.ts',
  'dist/vdb.js',
  'dist/voxels.d.ts',
  'dist/voxels.js',
  'compatibility.md',
  'license',
  'package.json',
].sort();

export const validatePackageFiles = (files) => {
  const normalized = files.map((file) => file.replaceAll(path.sep, '/')).sort();
  const missing = PACKAGE_FILES.filter((file) => !normalized.includes(file));
  const extra = normalized.filter((file) => !PACKAGE_FILES.includes(file));
  // Source, maps and native build inputs never ship: the package is dist/ plus
  // the docs and the licence.
  const forbidden = normalized.filter(
    (file) =>
      file.endsWith('.map') ||
      file.endsWith('.cpp') ||
      file.endsWith('.h') ||
      (file.endsWith('.ts') && !file.endsWith('.d.ts')) ||
      file.startsWith('src/') ||
      file.startsWith('spikes/'),
  );

  if (
    normalized.length > PACKAGE_FILE_COUNT_CEILING ||
    missing.length > 0 ||
    extra.length > 0 ||
    forbidden.length > 0
  ) {
    throw new Error(
      `npm package mismatch; count=${normalized.length}/${PACKAGE_FILE_COUNT_CEILING} ` +
        `missing=[${missing.join(', ')}] extra=[${extra.join(', ')}] forbidden=[${forbidden.join(', ')}]`,
    );
  }

  return normalized;
};

// The Symbol.dispose shim must be the first module an entry evaluates, before
// any wrapper class is defined. package.json#sideEffects names dist/dispose.js,
// which rolldown would otherwise read as permission to drop the entries' bare
// `import './dispose.ts'`; tsdown.config.ts keeps it, and this check proves the
// shipped entries still start with it.
export const DISPOSE_FIRST_ENTRIES = ['dist/index.js', 'dist/multi.js'];

export const assertDisposeFirst = (file, source) => {
  if (!/^import\s*["']\.\/dispose\.js["'];?/u.test(source)) {
    throw new Error(`${file} must import ./dispose.js before anything else`);
  }
};
