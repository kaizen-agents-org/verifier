import { describe, expect, it } from "vitest";
import {
  checkDetectorPolicy,
  detectorSourceChanged,
  type DetectorCorpusCase,
  type DetectorRelaxationPolicy
} from "../../../scripts/detector-relaxation-policy.js";

const detector = { id: "minimal-verdict", path: "packages/core/src/minimal-verdict.ts" };
const falsePositive: DetectorCorpusCase = {
  id: "gp-clean-failure-prose",
  kind: "golden",
  input: { verifyLogs: "The failure-path tests passed." },
  expected: { verdict: "open_pr", mustFixMax: 0, maxFalsePositives: 0 }
};
const mustBlock: DetectorCorpusCase = {
  id: "sb-real-failure",
  kind: "seeded",
  input: { verifyLogs: "The failure-path test failed." },
  expected: { verdict: "block_pr", mustFixMin: 1 }
};
const previousPolicy: DetectorRelaxationPolicy = {
  version: 1,
  detectors: [detector],
  pairs: [],
  structuralExemptions: []
};
const pair = {
  id: "failure-prose-boundary",
  detectorId: detector.id,
  falsePositiveCaseId: falsePositive.id,
  mustBlockCaseId: mustBlock.id,
  sharedTrigger: "failure-path",
  rationale: "Clean failure-path prose must not hide an actual failed failure-path test."
};

describe("detector relaxation policy", () => {
  it("rejects an unpaired semantic detector change", () => {
    expect(checkDetectorPolicy({
      changedDetectorIds: [detector.id],
      currentPolicy: previousPolicy,
      previousPolicy,
      cases: [falsePositive, mustBlock]
    })).toEqual([
      "detector minimal-verdict changed without a new paired regression declaration or structural exemption"
    ]);
  });

  it("accepts a detector change with a faithful positive/negative pair", () => {
    expect(checkDetectorPolicy({
      changedDetectorIds: [detector.id],
      currentPolicy: { ...previousPolicy, pairs: [pair] },
      previousPolicy,
      cases: [falsePositive, mustBlock]
    })).toEqual([]);
  });

  it("does not treat input property names as shared triggers", () => {
    const keyOnlyPair = { ...pair, sharedTrigger: "verifyLogs" };
    expect(checkDetectorPolicy({
      changedDetectorIds: [detector.id],
      currentPolicy: { ...previousPolicy, pairs: [keyOnlyPair] },
      previousPolicy,
      cases: [falsePositive, mustBlock]
    })).toEqual(expect.arrayContaining([
      "pair failure-prose-boundary false-positive case does not contain shared trigger verifyLogs",
      "pair failure-prose-boundary must-block case does not contain shared trigger verifyLogs"
    ]));
  });

  it("detects additions-only control-flow relaxations", () => {
    const previous = "export function blocks(value: string) { return /failed/.test(value); }";
    const relaxed = "export function blocks(value: string) { if (value.includes('allowed')) return false; return /failed/.test(value); }";
    expect(detectorSourceChanged(previous, relaxed)).toBe(true);
  });

  it("ignores comment-only and formatting changes", () => {
    const previous = "// detector\nexport const blocks = (value: string) => /failed/.test(value);";
    const reformatted = "export const blocks=(value: string)=> /failed/.test(value); // unchanged";
    expect(detectorSourceChanged(previous, reformatted)).toBe(false);
  });

  it("allows an audited structural exemption without requiring a new fixture", () => {
    expect(checkDetectorPolicy({
      changedDetectorIds: [detector.id],
      currentPolicy: {
        ...previousPolicy,
        structuralExemptions: [{
          id: "extract-pattern-constants",
          detectorId: detector.id,
          rationale: "Moves unchanged pattern constants without changing their use."
        }]
      },
      previousPolicy,
      cases: [falsePositive, mustBlock]
    })).toEqual([]);
  });

  it("rejects a must-block case weakened or reclassified as a known gap", () => {
    const weakened: DetectorCorpusCase = {
      ...mustBlock,
      expected: { verdict: "open_pr", mustFixMin: 0, knownGap: true }
    };
    expect(checkDetectorPolicy({
      changedDetectorIds: [detector.id],
      currentPolicy: { ...previousPolicy, pairs: [pair] },
      previousPolicy,
      cases: [falsePositive, weakened]
    })).toContain(
      "pair failure-prose-boundary must-block case sb-real-failure must be seeded, require block_pr and mustFixMin >= 1, and not be a known gap"
    );
  });

  it("keeps historical pair declarations append-only and immutable", () => {
    expect(checkDetectorPolicy({
      changedDetectorIds: [],
      currentPolicy: previousPolicy,
      previousPolicy: { ...previousPolicy, pairs: [pair] },
      cases: [falsePositive, mustBlock]
    })).toContain("pair failure-prose-boundary was deleted");
  });

  it("keeps historical paired corpus inputs and expectations immutable", () => {
    const historicalPolicy = { ...previousPolicy, pairs: [pair] };
    const rewrittenFalsePositive = {
      ...falsePositive,
      input: { verifyLogs: "An easier failure-path control passed." }
    };
    expect(checkDetectorPolicy({
      changedDetectorIds: [],
      currentPolicy: historicalPolicy,
      previousPolicy: historicalPolicy,
      cases: [rewrittenFalsePositive, mustBlock],
      previousCases: [falsePositive, mustBlock]
    })).toContain(
      "historical pair failure-prose-boundary corpus case gp-clean-failure-prose input and expectations are immutable"
    );

    const weakenedExpectation = {
      ...mustBlock,
      expected: { ...mustBlock.expected, mustFixMin: 2 }
    };
    expect(checkDetectorPolicy({
      changedDetectorIds: [],
      currentPolicy: historicalPolicy,
      previousPolicy: historicalPolicy,
      cases: [falsePositive, weakenedExpectation],
      previousCases: [falsePositive, mustBlock]
    })).toContain(
      "historical pair failure-prose-boundary corpus case sb-real-failure input and expectations are immutable"
    );

    const reorderedFalsePositive = {
      ...falsePositive,
      input: { nested: { second: "two", first: "one" }, verifyLogs: falsePositive.input.verifyLogs }
    };
    const originalFalsePositive = {
      ...falsePositive,
      input: { verifyLogs: falsePositive.input.verifyLogs, nested: { first: "one", second: "two" } }
    };
    expect(checkDetectorPolicy({
      changedDetectorIds: [],
      currentPolicy: historicalPolicy,
      previousPolicy: historicalPolicy,
      cases: [reorderedFalsePositive, mustBlock],
      previousCases: [originalFalsePositive, mustBlock]
    })).toEqual([]);
  });

  it("rejects duplicate corpus IDs that could mask a control", () => {
    expect(checkDetectorPolicy({
      changedDetectorIds: [],
      currentPolicy: previousPolicy,
      previousPolicy,
      cases: [falsePositive, { ...mustBlock, id: falsePositive.id }]
    })).toContain("corpus case id gp-clean-failure-prose must be unique");
  });
});
