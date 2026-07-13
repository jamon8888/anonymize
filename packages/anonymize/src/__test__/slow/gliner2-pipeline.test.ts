import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { runPipeline, type NerInferenceFn } from "../../pipeline";
import { buildGliner2Inference } from "../../gliner2/inference";
import type { PipelineConfig } from "../../types";
import { DEFAULT_ENTITY_LABELS } from "../../constants";

const hasBinary = process.env["ANONYMIZE_GLINER2_SERVER_PATH"] !== undefined;

describe.skipIf(!hasBinary)("GLiNER2 pipeline integration", () => {
  let nerInference: NerInferenceFn;

  beforeAll(async () => {
    nerInference = buildGliner2Inference({
      modelLoadTimeout: 180_000,
    });
    // Warm up — triggers model download + server start
    await nerInference("Warm up.", ["person"], 0.5);
  }, 200_000);

  afterAll(() => {
    // Cleanup handled by GC / process exit for the client
  });

  const baseConfig: PipelineConfig = {
    threshold: 0.5,
    enableTriggerPhrases: false,
    enableRegex: false,
    enableLegalForms: false,
    enableNameCorpus: false,
    enableDenyList: false,
    enableGazetteer: false,
    enableCountries: false,
    enableNer: true,
    enableConfidenceBoost: false,
    enableCoreference: false,
    labels: [...DEFAULT_ENTITY_LABELS],
    workspaceId: "test",
  };

  it("detects person via NER in pipeline output", async () => {
    const text = "Maria Jensen called yesterday.";
    const entities = await runPipeline({
      fullText: text,
      config: baseConfig,
      gazetteerEntries: [],
      nerInference,
    });
    const people = entities.filter((e) => e.label === "person");
    expect(people.length).toBeGreaterThan(0);
    expect(people.some((p) => p.text.includes("Maria"))).toBe(true);
  }, 60_000);

  it("NER entities have source='ner'", async () => {
    const text = "Email john@test.com for info.";
    const entities = await runPipeline({
      fullText: text,
      config: { ...baseConfig, labels: ["email address"] },
      gazetteerEntries: [],
      nerInference,
    });
    for (const e of entities) {
      expect(e.source).toBe("ner");
    }
  }, 30_000);
});