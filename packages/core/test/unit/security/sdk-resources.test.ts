import { expect } from "chai";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { readGeneratedResource } from "../../../../sdk/src/resources";

describe("SDK generated resource reader", () => {
  const name = "config/sepolia.pwa-phase-one.json";
  const target = resolve(__dirname, "../../../../sdk/generated", name);
  it("accepts only exact manifest-listed bytes and rejects traversal", () => {
    expect(readGeneratedResource(name)).to.equal(readFileSync(target, "utf8"));
    expect(() => readGeneratedResource("../core/package.json")).to.throw(/missing or inconsistent/);
    expect(() => readGeneratedResource("config/not-listed.json")).to.throw(/missing or inconsistent/);
  });
  it("fails closed on mutated and missing generated resources without rereading core", () => {
    const original = readFileSync(target);
    try {
      writeFileSync(target, "{}");
      expect(() => readGeneratedResource(name)).to.throw(/missing or inconsistent/);
      unlinkSync(target);
      expect(() => readGeneratedResource(name)).to.throw(/missing or inconsistent/);
    } finally {
      writeFileSync(target, original);
    }
  });
});
