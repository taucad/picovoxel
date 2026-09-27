import empty from './shaders/empty.wgsl';
import gyroidUnrolled from './shaders/gyroid-unrolled.wgsl';
import mulAddProbe from './shaders/mul-add-probe.wgsl';
import nanovdbLeafTransform from './shaders/nanovdb-leaf-transform.wgsl';
import nanovdbSample from './shaders/nanovdb-sample.wgsl';
import reduce from './shaders/reduce.wgsl';
import saxpy from './shaders/saxpy.wgsl';
import tapeGyroidSpecialized from './shaders/tape-gyroid-specialized.wgsl';
import tapeIndirectArgs from './shaders/tape-indirect-args.wgsl';
import tapeInterpreterSubgroup from './shaders/tape-interpreter-subgroup.wgsl';
import tapeInterpreter from './shaders/tape-interpreter.wgsl';

export const SHADER_SOURCES = Object.freeze({
  empty,
  'gyroid-unrolled': gyroidUnrolled,
  'mul-add-probe': mulAddProbe,
  'nanovdb-leaf-transform': nanovdbLeafTransform,
  'nanovdb-sample': nanovdbSample,
  reduce,
  saxpy,
  'tape-gyroid-specialized': tapeGyroidSpecialized,
  'tape-indirect-args': tapeIndirectArgs,
  'tape-interpreter': tapeInterpreter,
  'tape-interpreter-subgroup': tapeInterpreterSubgroup,
});
