import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(readFileSync(join(here, 'inputs.json'), 'utf8'));
const props = readFileSync(join(here, 'package/build/PicoVoxel.PicoGK.props'), 'utf8');
const baseProject = readFileSync(join(here, 'package/base/PicoGK.csproj'), 'utf8');
const property = (name) => new RegExp(`<${name}>([^<]+)</${name}>`, 'u').exec(props)?.[1];

test('the consumer props pin the identities the archives were qualified against', () => {
  assert.equal(property('PicoVoxelPicoGKSdk'), pins.sdk);
  assert.equal(property('PicoVoxelPicoGKRuntime'), pins.runtime);
  assert.equal(property('PicoVoxelPicoGKEmscripten'), pins.emscripten);
  assert.equal(property('PicoVoxelPicoGKEmscriptenRevision'), pins.emscriptenRevision);
  assert.equal(property('PicoVoxelPicoGKRoslyn'), pins.roslyn);
});

test('the props record the managed dependency the base project restores', () => {
  const version = property('PicoVoxelPicoGKSkiaSharp');
  assert.match(baseProject, new RegExp(`Include="SkiaSharp" Version="${version}"`, 'u'));
});

test('every payload directory the props expose is rooted in the package', () => {
  for (const [, value] of props.matchAll(
    /<PicoVoxelPicoGK(?:Root|Manifest|Base\w*|Patches|Managed\w+|Compose|Generator|RetentionProps|Toolchain|RoslynRoot|Engine\w+)>([^<]+)</gu,
  )) {
    assert.match(value, /^\$\(PicoVoxelPicoGK(Root|Base)\)|^\$\(\[MSBuild\]/u, value);
  }
});

test('the consumer targets refuse an unqualified SDK before anything compiles', () => {
  const targets = readFileSync(join(here, 'package/build/PicoVoxel.PicoGK.targets'), 'utf8');
  assert.match(targets, /BeforeTargets="PrepareForBuild"/u);
  assert.match(targets, /'\$\(NETCoreSdkVersion\)' != '\$\(PicoVoxelPicoGKSdk\)'/u);
});

test('the base project compiles one source selection for either target', () => {
  assert.match(baseProject, /<Compile Include="source\/\*\*\/\*\.cs" \/>/u);
  assert.doesNotMatch(baseProject, /<DefineConstants>/u);
});
