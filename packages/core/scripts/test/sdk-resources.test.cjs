const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateResources, verifyResources, invalidateResources, RESOURCE_FILES } = require('../sdk-resources.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sdk-resources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const core = path.join(root, 'packages/core');
  const sdk = path.join(root, 'packages/sdk');
  const write = (name, bytes) => {
    const target = path.join(core, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  };
  for (const name of RESOURCE_FILES) write(name, JSON.stringify({ source: name, bytecode: '0x6000' })+'\n');
  for (const name of ['contracts/Guard.sol', 'hardhat.config.ts', 'package.json', 'scripts/sdk-resources.cjs', 'artifacts/build-info/compiler.json']) write(name, 'reviewed input\n');
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'reviewed lock\n');
  return { core, sdk, write, generated: path.join(sdk, 'generated') };
}

test('copies exact public bytes and produces a deterministic, verifiable manifest', t => {
  const f = fixture(t);
  generateResources(f.core, f.sdk);
  const first = fs.readFileSync(path.join(f.generated, 'manifest.json'), 'utf8');
  for (const file of RESOURCE_FILES) assert.deepEqual(fs.readFileSync(path.join(f.generated, file)), fs.readFileSync(path.join(f.core, file)));
  verifyResources(f.core, f.sdk);
  generateResources(f.core, f.sdk);
  assert.equal(fs.readFileSync(path.join(f.generated, 'manifest.json'), 'utf8'), first);
});

test('rejects missing and modified generated resources', t => {
  const f = fixture(t);
  generateResources(f.core, f.sdk);
  fs.writeFileSync(path.join(f.generated, RESOURCE_FILES[0]), '{}');
  assert.throws(() => verifyResources(f.core, f.sdk), /resource|stale/i);
  generateResources(f.core, f.sdk);
  fs.unlinkSync(path.join(f.generated, RESOURCE_FILES[0]));
  assert.throws(() => verifyResources(f.core, f.sdk), /resource|ENOENT/i);
});

test('detects changed contract, compiler, lockfile and artifact inputs', t => {
  const f = fixture(t);
  for (const file of ['contracts/Guard.sol', 'hardhat.config.ts', '../../pnpm-lock.yaml', 'artifacts/build-info/compiler.json', RESOURCE_FILES[0]]) {
    generateResources(f.core, f.sdk);
    f.write(file, 'changed input\n');
    assert.throws(() => verifyResources(f.core, f.sdk), /stale|input/i, file);
  }
});

test('failed generation invalidates a previously complete output', t => {
  const f = fixture(t);
  generateResources(f.core, f.sdk);
  fs.unlinkSync(path.join(f.core, RESOURCE_FILES[0]));
  assert.throws(() => generateResources(f.core, f.sdk));
  assert.equal(fs.existsSync(f.generated), false);
});

test('clean invalidates generated output', t => {
  const f = fixture(t);
  generateResources(f.core, f.sdk);
  invalidateResources(f.sdk);
  assert.equal(fs.existsSync(f.generated), false);
  assert.throws(() => verifyResources(f.core, f.sdk));
});

test('coverage generation is refused without replacing reviewed output', t => {
  const f = fixture(t);
  generateResources(f.core, f.sdk);
  const first = fs.readFileSync(path.join(f.generated, 'manifest.json'), 'utf8');
  const previous = process.env.SOLIDITY_COVERAGE;
  process.env.SOLIDITY_COVERAGE = 'true';
  try {
    assert.throws(() => generateResources(f.core, f.sdk), /coverage/i);
    assert.equal(fs.readFileSync(path.join(f.generated, 'manifest.json'), 'utf8'), first);
  } finally {
    if (previous === undefined) delete process.env.SOLIDITY_COVERAGE;
    else process.env.SOLIDITY_COVERAGE = previous;
  }
});
