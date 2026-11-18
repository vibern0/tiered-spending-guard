import { expect } from "chai";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../../../scripts/repository";
import { loadFundingKey } from "../../../scripts/live/secrets";

function scripts(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? scripts(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
}

describe("operational repository root", () => {
  it("finds the workspace root from core package cwd and from root cwd", () => {
    const current = process.cwd();
    const root = repositoryRoot();
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces).to.deep.equal(['packages/*', 'apps/*']);
    try {
      process.chdir(join(root, 'packages/core'));
      expect(repositoryRoot()).to.equal(root);
      process.chdir(root);
      expect(repositoryRoot()).to.equal(root);
    } finally { process.chdir(current); }
    expect(() => readFileSync(join(root, "packages/core/config/sepolia.ordinary-review.json"))).not.to.throw();
    expect(() => loadFundingKey(join(root, 'packages/sdk/package.json'), root)).to.throw(/secret file rejected/i);
  });
  it("keeps all operational defaults on the shared source-relative root", () => {
    for (const path of scripts(join(repositoryRoot(), 'packages/core/scripts'))) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.to.match(/process\.cwd\(\)\.replace\(/, path);
      expect(source).not.to.include('resolve(process.cwd(), "..")', path);
    }
  });
});
