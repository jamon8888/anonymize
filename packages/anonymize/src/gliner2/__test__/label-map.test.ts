import { describe, it, expect } from "bun:test";
import { expandLabels, collapseLabel, PIPELINE_TO_MODEL } from "../label-map";

describe("expandLabels", () => {
  it("expands person to 5 model labels", () => {
    const expanded = expandLabels(["person"]);
    expect(expanded).toEqual([
      "person",
      "full_name",
      "first_name",
      "middle_name",
      "last_name",
    ]);
  });

  it("skips labels not in the model map", () => {
    const expanded = expandLabels(["organization", "person"]);
    expect(expanded).not.toContain("organization");
    expect(expanded).toContain("person");
  });

  it("deduplicates when multiple pipeline labels share a model label", () => {
    const expanded = expandLabels([
      "social security number",
      "birth number",
      "person",
    ]);
    const nins = expanded.filter((l) => l === "national_id_number");
    expect(nins).toHaveLength(1);
  });
});

describe("collapseLabel", () => {
  it("prefers requested pipeline label on collision", () => {
    const result = collapseLabel("national_id_number", new Set(["social security number"]));
    expect(result).toBe("social security number");
  });

  it("falls back to reverse map default when no collision", () => {
    const result = collapseLabel("email", new Set(["person"]));
    expect(result).toBe("email address");
  });

  it("passes through unknown model labels", () => {
    const result = collapseLabel("unknown_label", new Set());
    expect(result).toBe("unknown_label");
  });
});

describe("invariant: round-trip all mapped labels", () => {
  it("round-trips every mapped label into one of the requested pipeline labels", () => {
    for (const [pipelineLabel, modelLabels] of Object.entries(PIPELINE_TO_MODEL)) {
      for (const modelLabel of modelLabels) {
        expect(
          collapseLabel(modelLabel, new Set([pipelineLabel])),
        ).toBe(pipelineLabel);
      }
    }
  });

  it("prefers first requested label in collision case", () => {
    // national_id_number maps to multiple pipeline labels
    const requested = new Set(["social security number", "birth number"]);
    const result = collapseLabel("national_id_number", requested);
    // Should prefer the one that appears first in PIPELINE_TO_MODEL
    expect(result).toBe("birth number");
  });

  it("uses caller order when multiple requested labels map to same model label", () => {
    const requested = new Set(["birth number", "social security number"]);
    const result = collapseLabel("national_id_number", requested);
    // Should prefer the one that appears first in PIPELINE_TO_MODEL
    expect(result).toBe("birth number");
  });
});