// The coverage-cpp gate over the report coverage-cpp-report.sh writes: every own C++
// translation unit at 100% lines and 100% functions, less the audited exclusions below;
// regions and branches may not fall below scripts/coverage-cpp-ratchet.json.
//
// Usage: node scripts/coverage-cpp-gate.mjs <lcov.info> <summary.json> [--update-ratchet]
// --update-ratchet rewrites the ratchet to this run's region and branch figures; commit
// it when coverage rises, so the floor follows.
//
// Locally, with the multi pair already in src/ (the light files load both variants):
//   COVERAGE=1 bash scripts/build-pico-module.sh        # instrumented serial into src/
//   PICOVOXEL_CPP_COVERAGE_DIR=/tmp/prof pnpm run test:unit
//   PROFILE_DIR=/tmp/prof bash scripts/coverage-cpp-report.sh
//   node scripts/coverage-cpp-gate.mjs coverage/cpp/lcov.info coverage/cpp/summary.json
// Rebuild without COVERAGE=1 afterwards: the instrumented pair is not the shipped one.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RATCHET = join(ROOT, 'scripts/coverage-cpp-ratchet.json');

/**
 * Lines no test can execute. Each entry excludes the `count` lines after the one source
 * line that reads `anchor`, so an entry follows its code across edits and fails the gate
 * when the anchor moves away or the lines become covered. Keep this list short: every
 * entry needs a reason a reviewer can verify in the code.
 */
export const EXCLUSIONS = [
  {
    file: 'src/pico-query.cpp',
    anchor: 'if (!roIndex)',
    count: 5,
    reason:
      'ClosestSurfacePoint::create returns null only when an interrupter reports an ' +
      'interruption, and Voxels_ClosestPointBatch passes none; the guard keeps the ' +
      'openvdb contract rather than a reachable path.',
  },
];

/** Parses lcov into per-file maps of line number to hit count. */
export function parseLcov(text) {
  const files = new Map();
  let lines;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      lines = new Map();
      files.set(line.slice(3), lines);
    } else if (line.startsWith('DA:')) {
      const [number, count] = line.slice(3).split(',');
      lines.set(Number(number), Number(count));
    }
  }
  return files;
}

/** Per-file line and function counts and region and branch percentages from `llvm-cov export -summary-only`. */
export function parseSummary(json) {
  const figures = {};
  for (const { filename, summary } of json.data[0].files) {
    figures[filename] = {
      lines: { count: summary.lines.count, covered: summary.lines.covered },
      functions: { count: summary.functions.count, covered: summary.functions.covered },
      regions: summary.regions.percent,
      branches: summary.branches.percent,
    };
  }
  return figures;
}

/**
 * Applies the exclusions, the 100% line and function thresholds and the ratchet. llvm-cov's
 * own summary is the measure; lcov locates the missed lines, and the two must agree.
 * `source(file)` returns a file's lines (index 0 is line 1).
 */
export function evaluate({ lcov, summary, ratchet, exclusions, source }) {
  const failures = [];
  const rows = [];
  const excluded = new Map();
  for (const { file, anchor, count } of exclusions) {
    const at = source(file).flatMap((line, index) => (line.trim() === anchor ? [index + 1] : []));
    if (at.length !== 1) {
      failures.push(
        `${file}: the exclusion anchor '${anchor}' matches ${at.length} lines, not 1; re-audit it`,
      );
      continue;
    }
    const set = excluded.get(file) ?? new Set();
    for (let number = at[0] + 1; number <= at[0] + count; number++) {
      const hits = lcov.get(file)?.get(number);
      if (hits === undefined) failures.push(`${file}:${number} is excluded but has no coverage record`);
      else if (hits > 0) failures.push(`${file}:${number} is excluded but covered; drop the exclusion`);
      set.add(number);
    }
    excluded.set(file, set);
  }

  const files = [...new Set([...Object.keys(summary), ...lcov.keys()])].sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    const now = summary[file];
    const lines = lcov.get(file);
    if (!now || !lines) {
      failures.push(`${file}: present in only one of lcov and the llvm-cov summary`);
      continue;
    }
    const skip = excluded.get(file) ?? new Set();
    const missed = [...lines]
      .filter(([number, hits]) => hits === 0 && !skip.has(number))
      .map(([number]) => number);
    if (missed.length > 0) failures.push(`${file}: uncovered lines ${missed.join(', ')}`);
    const missedByLlvm = now.lines.count - now.lines.covered;
    if (missed.length === 0 && missedByLlvm !== skip.size) {
      failures.push(`${file}: llvm-cov counts ${missedByLlvm} missed lines, lcov accounts for ${skip.size}`);
    }
    if (now.functions.covered < now.functions.count) {
      failures.push(`${file}: ${now.functions.count - now.functions.covered} uncovered functions`);
    }
    const floor = ratchet[file];
    if (!floor) failures.push(`${file}: missing from scripts/coverage-cpp-ratchet.json`);
    else {
      for (const metric of ['regions', 'branches']) {
        if (now[metric] < floor[metric]) {
          failures.push(
            `${file}: ${metric} ${now[metric].toFixed(2)}% fell below the ratchet ${floor[metric]}%`,
          );
        }
      }
    }
    rows.push({
      file,
      lines: `${now.lines.covered}/${now.lines.count - skip.size}`,
      excluded: skip.size,
      functions: `${now.functions.covered}/${now.functions.count}`,
      regions: now.regions,
      branches: now.branches,
    });
  }
  for (const file of Object.keys(ratchet)) {
    if (!summary[file]) failures.push(`${file}: in the ratchet but absent from the report`);
  }
  return { rows, failures };
}

/** The ratchet a run supports: each percentage floored to two decimals. */
export function ratchetFrom(summary) {
  const floor = (value) => Math.floor(value * 100) / 100;
  return Object.fromEntries(
    Object.entries(summary)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, { regions, branches }]) => [file, { regions: floor(regions), branches: floor(branches) }]),
  );
}

/** Renders the per-TU result table in Markdown. */
export function table(rows) {
  const percent = (value) => (value === undefined ? 'n/a' : `${value.toFixed(2)}%`);
  return [
    '| TU | Lines | Excluded | Functions | Regions | Branches |',
    '|---|---|---|---|---|---|',
    ...rows.map(
      (row) =>
        `| ${row.file} | ${row.lines} | ${row.excluded} | ${row.functions} | ${percent(row.regions)} | ${percent(row.branches)} |`,
    ),
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [lcovPath, summaryPath, flag] = process.argv.slice(2);
  if (!lcovPath || !summaryPath) {
    console.error('usage: node scripts/coverage-cpp-gate.mjs <lcov.info> <summary.json> [--update-ratchet]');
    process.exit(2);
  }
  const summary = parseSummary(JSON.parse(readFileSync(summaryPath, 'utf8')));
  if (flag === '--update-ratchet') {
    writeFileSync(RATCHET, `${JSON.stringify(ratchetFrom(summary), null, 2)}\n`);
  }
  const { rows, failures } = evaluate({
    lcov: parseLcov(readFileSync(lcovPath, 'utf8')),
    summary,
    ratchet: JSON.parse(readFileSync(RATCHET, 'utf8')),
    exclusions: EXCLUSIONS,
    source: (file) => readFileSync(join(ROOT, file), 'utf8').split('\n'),
  });
  const report = `${table(rows)}\n`;
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## C++ coverage\n\n${report}`);
  for (const failure of failures) console.error(`coverage-cpp: ${failure}`);
  process.exit(failures.length > 0 ? 1 : 0);
}
