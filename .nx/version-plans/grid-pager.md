---
picovoxel: minor
---

Grid paging: Voxels grids are paged by default. When a runtime's resident grids exceed the pager's budget (2 GiB by default, the headroom of the 4 GiB heap), the least recently used are parked, compressed with LZ4, outside the wasm heap, and restored on their next use. Output bytes are unchanged with paging on or off, and below the budget nothing is parked. `createPico({ pager })` and `createPicoRuntime({ pager })` take `budgetBytes`, `codec`, `mode` (`'serial'`, `'pooled'` or `'pipelined'`), `arena`, `store` (`'ram'` or a `'disk'` scratch file) and `storeMaxBytes`; `pager: false` turns it off. Paging out of heap or store space is `PICO_OUT_OF_MEMORY`.

`pico.footprint` reports the heap and the far store side by side (`heapBytes`, `farBytes`) with the pager's counters, for hosts that recycle workers by memory. A `Metadata` view held across a park throws `PICO_DISPOSED`; `voxels.metadata` hands out a fresh one.

A failed call's own error now always reaches the caller: cleanup after a failure no longer replaces it.

New raw exports: `K7_nPark`, `K7_hRestore`, `K7_nArena`, `K7_nRearm` and `K7_nLastError`, the park TU behind the pager. LZ4 is a new bundled dependency (BSD-2-Clause, see NOTICE).
