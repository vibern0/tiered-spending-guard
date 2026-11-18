import { expect } from "chai";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
}

describe("core / SDK ownership", () => {
  const root = resolve(__dirname, "../../../../..");
  it("names the two workspaces and routes backend consumers through SDK", () => {
    expect(JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")).name).to.equal("@tiered-spending-guard/core");
    const sdk = JSON.parse(readFileSync(join(root, "packages/sdk/package.json"), "utf8"));
    expect(sdk.name).to.equal("@tiered-spending-guard/sdk");
    expect(sdk.exports["./pwa"].default).to.equal("./src/pwa/index.ts");
    const backend = JSON.parse(readFileSync(join(root, "apps/backend/package.json"), "utf8"));
    expect(backend.dependencies["@tiered-spending-guard/sdk"]).to.equal("workspace:*");
    expect(backend.dependencies).not.to.have.property("@tiered-spending-guard/core");
    for (const path of sources(join(root, "apps/backend/src"))) expect(readFileSync(path, "utf8")).not.to.match(/(?:from|import\()\s*["'][^"']*(?:security-core|packages\/core|@tiered-spending-guard\/core)/, path);
  });
  it("keeps SDK implementation independent of operational source and test-only helpers off the PWA facade", () => {
    for (const path of sources(join(root, "packages/sdk/src"))) {
      expect(readFileSync(path, "utf8")).not.to.match(/(?:from|import\()\s*["'][^"']*(?:scripts\/|core\/|security-core|@tiered-spending-guard\/core)/, path);
    }
    const index = readFileSync(join(root, "packages/sdk/src/pwa/index.ts"), "utf8");
    expect(index).not.to.include("ForTestsOnly");
  });
  it("shares deployment verification brands between SDK public and implementation imports", async () => {
    const publicApi = await import("@tiered-spending-guard/sdk/config/deployments");
    const implementation = await import("../../../../sdk/src/config/deployments");
    expect(publicApi.verifyOfficialDeploymentDependencies).to.equal(implementation.verifyOfficialDeploymentDependencies);
    expect(publicApi.isVerifiedDeploymentInfrastructure).to.equal(implementation.isVerifiedDeploymentInfrastructure);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const branded = implementation.brandVerifiedDeploymentInfrastructureForTestsOnly({} as never);
      expect(publicApi.isVerifiedDeploymentInfrastructure(branded)).to.equal(true);
      expect(publicApi.isVerifiedDeploymentInfrastructure({ ...branded })).to.equal(false);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
