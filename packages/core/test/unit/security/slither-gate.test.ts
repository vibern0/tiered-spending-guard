import { expect } from "chai";
import { validateSlitherExit, validateSlitherReport, type SlitherReport } from "../../../scripts/security/slither-gate";

const finding = {
  check: "detector",
  first_markdown_element: "contracts/Example.sol#L1",
  elements: [{ type: "function", name: "example" }],
};
const baseline = ["detector|example|contracts/Example.sol#L1"];
const valid = (): SlitherReport => ({ success: true, error: null, results: { detectors: [finding] } });

describe("Slither gate report validation", () => {
  it("rejects nonzero or tool-error exits unless 255 has a valid findings report", () => {
    expect(() => validateSlitherExit(255)).to.throw(/exit 255/);
    expect(() => validateSlitherExit(255, null, true)).not.to.throw();
    expect(() => validateSlitherExit(null)).to.throw(/exit null/);
    expect(() => validateSlitherExit(0, new Error("spawn failed"))).to.throw(/spawn failed/);
  });

  it("accepts only a successful report with an explicit detector array", () => {
    expect(validateSlitherReport(valid(), baseline)).to.deep.equal(baseline);
  });

  for (const [label, report] of [
    ["nonzero success", { ...valid(), success: false }],
    ["missing success", { error: null, results: { detectors: [finding] } }],
    ["error field", { ...valid(), error: "tool failed" }],
    ["missing detectors", { ...valid(), results: {} }],
    ["malformed detector", { ...valid(), results: { detectors: [{}] } }],
  ] as const) {
    it(`rejects ${label}`, () => expect(() => validateSlitherReport(report as SlitherReport, baseline)).to.throw());
  }

  it("rejects findings that are not in the reviewed baseline", () => {
    expect(() => validateSlitherReport({ ...valid(), results: { detectors: [{ ...finding, check: "new-detector" }] } }, baseline)).to.throw(/new-detector/);
  });
});
