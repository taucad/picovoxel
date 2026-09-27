// picovoxel/latticelibrary — TypeScript port of LEAP71_LatticeLibrary
// (Apache-2.0, © 2023-2026 LEAP 71; see NOTICE), built on picovoxel/shapekernel
// (a subpath export; no wasm changes). Explicit-session surface:
// cell arrays, lattice types and beam-thickness strategies are pure authoring
// objects; the session enters at the lattice/voxel boundary. TPMS presets
// carry both the `sdf` callback and the tape `expression` where the op set
// allows (see src/latticelibrary/tpmsPresets.ts for the callback-only three).

export {
  type BeamThickness,
  BoundaryBeamThickness,
  CellBasedBeamThickness,
  ConstantBeamThickness,
  GlobalFuncBeamThickness,
} from './latticelibrary/beamThickness.ts';
export {
  type CellArray,
  ConformalCellArray,
  conformalShowcaseShapes,
  RegularCellArray,
  RegularUnitCell,
} from './latticelibrary/cellArrays.ts';
export {
  CombinedTrafo,
  type CoordinateTrafo,
  FunctionalScaleTrafo,
  RadialTrafo,
  ScaleTrafo,
} from './latticelibrary/coordinateTrafo.ts';
export {
  BodyCentreLattice,
  type LatticeType,
  OctahedronLattice,
  RandomSplineLattice,
} from './latticelibrary/latticeTypes.ts';
export { RandomDeformationField } from './latticelibrary/randomDeformationField.ts';
export {
  RawGyroidTpmsPattern,
  RawLidinoidTpmsPattern,
  RawSchwarzDiamondTpmsPattern,
  RawSchwarzPrimitiveTpmsPattern,
  RawTransitionTpmsPattern,
  type RawTpmsPattern,
} from './latticelibrary/rawTpmsPatterns.ts';
export {
  FullVoidLogic,
  FullWallLogic,
  NegativeHalfWallLogic,
  NegativeVoidLogic,
  PositiveHalfWallLogic,
  PositiveVoidLogic,
  type SplittingLogic,
} from './latticelibrary/splittingLogic.ts';
export {
  ImplicitLidinoid,
  ImplicitModular,
  ImplicitRadialGyroid,
  ImplicitRandomizedSchwarzPrimitive,
  ImplicitSchwarzDiamond,
  ImplicitSchwarzPrimitive,
  ImplicitSplitVoidGyroid,
  ImplicitSplitWallGyroid,
} from './latticelibrary/tpmsPresets.ts';
export { CuboidCell, type UnitCell } from './latticelibrary/unitCells.ts';
