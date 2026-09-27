import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluate, parseLcov, parseSummary, ratchetFrom, table } from '../scripts/coverage-cpp-gate.mjs';

const lcovText = [
  'SF:src/a.cpp',
  'FNF:2',
  'FNH:2',
  'DA:1,4',
  'DA:2,0',
  'DA:3,0',
  'DA:4,7',
  'end_of_record',
  'SF:src/b.cpp',
  'FNF:1',
  'FNH:1',
  'DA:1,1',
  'end_of_record',
].join('\n');
const sourceA = ['int f() {', '    if (!p)', '        return 0;', '}'];
const figures = (lines, covered, functions, regions, branches) => ({
  lines: { count: lines, covered },
  functions: { count: functions, covered: functions },
  regions,
  branches,
});
const summary = { 'src/a.cpp': figures(4, 2, 2, 90.5, 75), 'src/b.cpp': figures(1, 1, 1, 100, 100) };
const ratchet = {
  'src/a.cpp': { regions: 90.5, branches: 75 },
  'src/b.cpp': { regions: 100, branches: 100 },
};
const exclusion = { file: 'src/a.cpp', anchor: 'int f() {', block: ['if (!p)', 'return 0;'], reason: 'test' };

const run = (overrides = {}) =>
  evaluate({
    lcov: parseLcov(lcovText),
    summary,
    ratchet,
    exclusions: [exclusion],
    source: (file) => (file === 'src/a.cpp' ? sourceA : ['x']),
    ...overrides,
  });

describe('coverage-cpp gate', () => {
  it('parses lcov line counts per file', () => {
    const files = parseLcov(lcovText);
    assert.deepEqual([...files.keys()], ['src/a.cpp', 'src/b.cpp']);
    assert.deepEqual(
      [...files.get('src/a.cpp')],
      [
        [1, 4],
        [2, 0],
        [3, 0],
        [4, 7],
      ],
    );
  });

  it('passes when every uncovered line is excluded after its anchor', () => {
    const { failures, rows } = run();
    assert.deepEqual(failures, []);
    assert.equal(rows[0].lines, '2/2');
    assert.equal(rows[0].excluded, 2);
  });

  it('fails on an uncovered line, an uncovered function and a stale or ambiguous exclusion', () => {
    assert.match(run({ exclusions: [] }).failures.join('\n'), /src\/a\.cpp: uncovered lines 2, 3/u);
    const fewer = {
      ...summary,
      'src/b.cpp': { ...summary['src/b.cpp'], functions: { count: 2, covered: 1 } },
    };
    assert.match(run({ summary: fewer }).failures.join('\n'), /src\/b\.cpp: 1 uncovered functions/u);
    // A miss llvm-cov counts but lcov does not locate still fails.
    const hidden = { ...summary, 'src/b.cpp': figures(2, 1, 1, 100, 100) };
    assert.match(
      run({ summary: hidden }).failures.join('\n'),
      /llvm-cov counts 1 missed lines, lcov accounts for 0/u,
    );
    const covered = parseLcov(lcovText.replace('DA:2,0', 'DA:2,3'));
    assert.match(run({ lcov: covered }).failures.join('\n'), /src\/a\.cpp:2 is excluded but covered/u);
    const moved = { ...exclusion, anchor: 'int g() {' };
    assert.match(run({ exclusions: [moved] }).failures.join('\n'), /matches 0 lines/u);
    // A reachable line inserted inside the block, or an edited block line, fails the entry.
    const inserted = ['int f() {', '    if (!p)', '        log();', '        return 0;', '}'];
    assert.match(
      run({ source: () => inserted }).failures.join('\n'),
      /the block after 'int f\(\) \{' changed/u,
    );
    const edited = ['int f() {', '    if (!q)', '        return 0;', '}'];
    assert.match(
      run({ source: () => edited }).failures.join('\n'),
      /the block after 'int f\(\) \{' changed/u,
    );
    const longer = { ...exclusion, block: [...exclusion.block, '}'] };
    assert.match(run({ exclusions: [longer] }).failures.join('\n'), /src\/a\.cpp:4 is excluded but covered/u);
    const past = { ...exclusion, anchor: '}', block: ['x'] };
    assert.match(
      run({ exclusions: [past], source: () => [...sourceA, 'x'] }).failures.join('\n'),
      /src\/a\.cpp:5 is excluded but has no coverage record/u,
    );
  });

  it('fails when regions or branches fall below the ratchet, and on TU set drift', () => {
    const lower = { ...summary, 'src/a.cpp': { ...summary['src/a.cpp'], regions: 90.49 } };
    assert.match(
      run({ summary: lower }).failures.join('\n'),
      /regions 90\.49% fell below the ratchet 90\.5%/u,
    );
    const extra = { ...ratchet, 'src/c.cpp': { regions: 1, branches: 1 } };
    assert.match(
      run({ lcov: parseLcov(`${lcovText}\nSF:src/c.cpp\nDA:1,1\n`) }).failures.join('\n'),
      /src\/c\.cpp: present in only one/u,
    );
    assert.match(run({ ratchet: extra }).failures.join('\n'), /src\/c\.cpp: in the ratchet but absent/u);
    const partial = { 'src/a.cpp': ratchet['src/a.cpp'] };
    assert.match(
      run({ ratchet: partial }).failures.join('\n'),
      /src\/b\.cpp: missing from scripts\/coverage-cpp-ratchet\.json/u,
    );
  });

  it('never lowers the ratchet: an update keeps the higher of the old floor and the new figure', () => {
    const previous = { 'src/a.cpp': { regions: 95, branches: 80 } };
    const worse = {
      'src/a.cpp': { regions: 90.12, branches: 85.678 },
      'src/n.cpp': { regions: 50, branches: 40 },
    };
    assert.deepEqual(ratchetFrom(worse, previous), {
      'src/a.cpp': { regions: 95, branches: 85.67 },
      'src/n.cpp': { regions: 50, branches: 40 },
    });
  });

  it('floors the ratchet to two decimals and reads the llvm-cov summary shape', () => {
    const shape = (regions, branches) => ({
      lines: { count: 3, covered: 3 },
      functions: { count: 1, covered: 1 },
      regions: { percent: regions },
      branches: { percent: branches },
    });
    const json = {
      data: [
        {
          files: [
            { filename: 'src/b.cpp', summary: shape(97.339, 81.5789) },
            { filename: 'src/a.cpp', summary: shape(100, 70) },
          ],
        },
      ],
    };
    const parsed = parseSummary(json);
    assert.deepEqual(parsed['src/a.cpp'].lines, { count: 3, covered: 3 });
    assert.deepEqual(ratchetFrom(parsed), {
      'src/a.cpp': { regions: 100, branches: 70 },
      'src/b.cpp': { regions: 97.33, branches: 81.57 },
    });
    assert.match(table(run().rows), /\| src\/a\.cpp \| 2\/2 \| 2 \| 2\/2 \| 90\.50% \| 75\.00% \|/u);
  });
});
