// Coverage builds only (build-pico-module.sh COVERAGE=1): runs inside the
// MODULARIZE factory, so `Module` is this instance. The instance is kept alive
// until test/cpp-coverage-setup.ts copies its profile counters out; pthread
// workers run this too, harmlessly, on their own globalThis.
(globalThis.__picovoxelCoverageModules ??= []).push(Module);
