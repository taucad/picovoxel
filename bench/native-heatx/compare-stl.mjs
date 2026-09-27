#!/usr/bin/env node
// Binary-STL parity checker for the native HeatX arms.
//
// The tube-complex lattice arm (U5) is a Class-2 change: it computes the same
// shapes through a different narrow-band construction, so its STL is NOT
// byte-identical to the exact arms and a size/hash comparison says only "they
// differ". This says BY HOW MUCH, in the quantities the SK-0.8/G1 gate shape is
// written in: watertight volume, surface area, axis-aligned bounds.
//
// Streaming by construction — these files reach ~500 MB at 0.5 mm, and a
// readFileSync pair would be a gigabyte resident for four numbers.
//
// Usage:
//   node compare-stl.mjs <reference.stl> <candidate.stl> [--voxel 1.0] [--json]
//
// Gates (G1 shape): |Δvolume| and |Δarea| ≤ 3% relative, every bounds ordinate
// within one voxel. Triangle count is REPORTED, never gated — a band-edge
// difference of a few triangles is the expected signature of this class, and
// counting triangles is not a geometry claim.
//
// Exit code 0 = all gates pass, 1 = a gate failed or an input is unreadable.

import { createReadStream, statSync } from 'node:fs';

const VOL_AREA_TOLERANCE = 0.03; // relative
const HEADER_BYTES = 84; // 80-byte header + uint32 triangle count
const TRI_BYTES = 50; // 12 float32 (normal + 3 vertices) + uint16 attribute

/// Reads one binary STL and returns its geometry summary. Never holds more than
/// one chunk plus a partial triangle.
async function scan(path) {
    const fileBytes = statSync(path).size;

    let expected = -1;
    let carry = Buffer.alloc(0);
    let triangles = 0;
    // Divergence theorem: 6V = Σ v0 · (v1 × v2), area = Σ ½|(v1−v0) × (v2−v0)|.
    let volume6 = 0;
    let area2 = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];

    for await (const chunk of createReadStream(path)) {
        const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        let at = 0;

        if (expected < 0) {
            if (buf.length < HEADER_BYTES) {
                carry = buf;
                continue;
            }
            expected = buf.readUInt32LE(80);
            if (HEADER_BYTES + TRI_BYTES * expected !== fileBytes) {
                throw new Error(
                    `${path}: not a binary STL of ${expected} triangles ` +
                        `(expected ${HEADER_BYTES + TRI_BYTES * expected} bytes, file is ${fileBytes})`,
                );
            }
            at = HEADER_BYTES;
        }

        while (buf.length - at >= TRI_BYTES) {
            // Skip the stored normal at +0: it is redundant and writers disagree.
            const ax = buf.readFloatLE(at + 12);
            const ay = buf.readFloatLE(at + 16);
            const az = buf.readFloatLE(at + 20);
            const bx = buf.readFloatLE(at + 24);
            const by = buf.readFloatLE(at + 28);
            const bz = buf.readFloatLE(at + 32);
            const cx = buf.readFloatLE(at + 36);
            const cy = buf.readFloatLE(at + 40);
            const cz = buf.readFloatLE(at + 44);

            volume6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);

            const ux = bx - ax;
            const uy = by - ay;
            const uz = bz - az;
            const vx = cx - ax;
            const vy = cy - ay;
            const vz = cz - az;
            const nx = uy * vz - uz * vy;
            const ny = uz * vx - ux * vz;
            const nz = ux * vy - uy * vx;
            area2 += Math.sqrt(nx * nx + ny * ny + nz * nz);

            for (const [x, y, z] of [
                [ax, ay, az],
                [bx, by, bz],
                [cx, cy, cz],
            ]) {
                if (x < min[0]) min[0] = x;
                if (y < min[1]) min[1] = y;
                if (z < min[2]) min[2] = z;
                if (x > max[0]) max[0] = x;
                if (y > max[1]) max[1] = y;
                if (z > max[2]) max[2] = z;
            }

            triangles++;
            at += TRI_BYTES;
        }

        carry = buf.subarray(at);
    }

    if (triangles !== expected) {
        throw new Error(`${path}: header declares ${expected} triangles, read ${triangles}`);
    }

    return { path, bytes: fileBytes, triangles, volume: volume6 / 6, area: area2 / 2, min, max };
}

const rel = (a, b) => (a === b ? 0 : Math.abs(b - a) / Math.max(Math.abs(a), Number.MIN_VALUE));
const f = (n, d = 4) => n.toFixed(d);

function main(argv) {
    const files = [];
    let voxel = 1.0;
    let asJson = false;

    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--voxel') voxel = Number(argv[++i]);
        else if (argv[i] === '--json') asJson = true;
        else files.push(argv[i]);
    }

    if (files.length !== 2 || !(voxel > 0)) {
        console.error('usage: node compare-stl.mjs <reference.stl> <candidate.stl> [--voxel 1.0] [--json]');
        process.exit(1);
    }

    return Promise.all(files.map(scan)).then(([a, b]) => {
        const dVol = rel(a.volume, b.volume);
        const dArea = rel(a.area, b.area);
        const boundsDelta = Math.max(
            ...[0, 1, 2].flatMap((i) => [Math.abs(b.min[i] - a.min[i]), Math.abs(b.max[i] - a.max[i])]),
        );

        const gates = {
            volume: dVol <= VOL_AREA_TOLERANCE,
            area: dArea <= VOL_AREA_TOLERANCE,
            bounds: boundsDelta < voxel,
        };
        const pass = Object.values(gates).every(Boolean);

        if (asJson) {
            console.log(JSON.stringify({ reference: a, candidate: b, voxel, dVol, dArea, boundsDelta, gates, pass }));
        } else {
            const rows = [
                ['triangles', a.triangles, b.triangles, `${b.triangles - a.triangles >= 0 ? '+' : ''}${b.triangles - a.triangles}`],
                ['bytes', a.bytes, b.bytes, `${b.bytes - a.bytes >= 0 ? '+' : ''}${b.bytes - a.bytes}`],
                ['volume mm³', f(a.volume, 3), f(b.volume, 3), `${(dVol * 100).toExponential(3)}%`],
                ['area mm²', f(a.area, 3), f(b.area, 3), `${(dArea * 100).toExponential(3)}%`],
                ['bounds mm', a.min.map((v) => f(v, 3)).join(','), b.min.map((v) => f(v, 3)).join(','), `max Δ ${f(boundsDelta, 6)}`],
                ['', a.max.map((v) => f(v, 3)).join(','), b.max.map((v) => f(v, 3)).join(','), `(1 voxel = ${voxel})`],
            ];
            console.log(`reference: ${a.path}\ncandidate: ${b.path}\n`);
            for (const [k, ra, rb, d] of rows) {
                console.log(`${k.padEnd(12)} ${String(ra).padStart(22)} ${String(rb).padStart(22)}   ${d}`);
            }
            console.log(
                `\nvolume ≤3%  ${gates.volume ? 'PASS' : 'FAIL'}` +
                    `\narea   ≤3%  ${gates.area ? 'PASS' : 'FAIL'}` +
                    `\nbounds <1vx ${gates.bounds ? 'PASS' : 'FAIL'}` +
                    `\n\n${pass ? 'PASS' : 'FAIL'}`,
            );
        }

        process.exit(pass ? 0 : 1);
    });
}

main(process.argv.slice(2)).catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
});
