import type { Entity, NerInferenceFn, OperatorType } from "../types";
import type { NativePipelineEntity } from "../native";
import type {
  NativeOperatorConfig,
  NativeStaticRedactionResult,
} from "../native";

export type NerConfig = {
  inference: NerInferenceFn;
  labels: readonly string[];
  threshold: number;
};

type Gap = readonly [fullStart: number, fullEnd: number];

let nerPlaceholderCounter = 0;
const nextNerPlaceholder = (label: string): string => {
  nerPlaceholderCounter += 1;
  return `<<NER:${label}:${nerPlaceholderCounter}>>`;
};

const withNerEntities = (
  base: NativeStaticRedactionResult,
  nerEntities: readonly Entity[],
): NativeStaticRedactionResult => ({
  // NER entities share the runtime shape of `NativePipelineEntity`.
  // SAFETY: `Entity` and `NativePipelineEntity` have identical fields
  // (start, end, label, text, score, source, sourceDetail?); the only
  // difference is the narrower `sourceDetail` literal union, which is a
  // subtype-safe widening at runtime.
  resolvedEntities: [
    ...base.resolvedEntities,
    ...(nerEntities as readonly NativePipelineEntity[]),
  ],
  redaction: base.redaction,
});

/**
 * Merge NER-detected entities into a Rust redaction result.
 *
 * Rust already redacted its own entities; this overlays NER spans (which live
 * in the unchanged gap regions of the source text) onto the redacted text by
 * mapping fullText offsets to redactedText offsets through the Rust entity
 * gaps. If the offset alignment cannot be established, NER entities are still
 * reported in `resolvedEntities` but not redacted (degraded, lossless mode).
 */
export const applyNerToResult = async (
  base: NativeStaticRedactionResult,
  fullText: string,
  ner: NerConfig,
  operators?: NativeOperatorConfig,
): Promise<NativeStaticRedactionResult> => {
  let nerEntities: Entity[];
  try {
    nerEntities = await ner.inference(fullText, ner.labels, ner.threshold);
  } catch {
    return base;
  }
  if (nerEntities.length === 0) {
    return base;
  }

  const redactString = operators?.redactString ?? "█";
  const operatorFor = (label: string): OperatorType =>
    operators?.operators?.[label] ?? "replace";

  // SAFETY: `NativePipelineEntity` is a runtime-identical subset of `Entity`;
  // the NER overlay only reads `start`/`end`, so widening is sound.
  const rust = [...base.resolvedEntities].sort(
    (a, b) => a.start - b.start,
  ) as Entity[];

  // Build fullText gap intervals (complements of Rust entity spans) and locate
  // each gap's start offset inside the redacted text.
  const gaps: Gap[] = [];
  const gapStarts: number[] = [];
  const redactedText = base.redaction.redactedText;
  let prevEnd = 0;
  let rPos = 0;
  for (const entity of rust) {
    const gapText = fullText.slice(prevEnd, entity.start);
    if (redactedText.slice(rPos, rPos + gapText.length) !== gapText) {
      return withNerEntities(base, nerEntities);
    }
    gaps.push([prevEnd, entity.start]);
    gapStarts.push(rPos);
    rPos += gapText.length;
    const nextGapText =
      entity === rust.at(-1)
        ? fullText.slice(entity.end)
        : fullText.slice(entity.end, rustNextStart(fullText, rust, entity));
    if (nextGapText.length === 0) {
      prevEnd = entity.end;
      continue;
    }
    const found = redactedText.indexOf(nextGapText, rPos);
    if (found === -1) {
      return withNerEntities(base, nerEntities);
    }
    rPos = found;
    prevEnd = entity.end;
  }
  gaps.push([prevEnd, fullText.length]);
  gapStarts.push(rPos);

  const gapIndexFor = (entity: Entity): number =>
    gaps.findIndex(
      ([start, end]) => entity.start >= start && entity.end <= end,
    );

  const accepted: Entity[] = [];
  let newText = redactedText;
  const redactionMap = new Map(base.redaction.redactionMap);
  const operatorMap = new Map(base.redaction.operatorMap);
  let entityCount = base.redaction.entityCount;
  let delta = 0;
  let lastEnd = -1;

  for (const entity of nerEntities) {
    if (entity.start < lastEnd) {
      continue;
    }
    const k = gapIndexFor(entity);
    if (k < 0) {
      continue;
    }
    const gap = gaps.at(k);
    if (gap === undefined) {
      continue;
    }
    const [fullStart] = gap;
    const ms = (gapStarts.at(k) ?? 0) + (entity.start - fullStart) + delta;
    const me = (gapStarts.at(k) ?? 0) + (entity.end - fullStart) + delta;
    const op = operatorFor(entity.label);
    let replacement: string;
    if (op === "redact") {
      replacement = redactString;
      operatorMap.set(`ner-redact:${entityCount}`, "redact");
    } else {
      const placeholder = nextNerPlaceholder(entity.label);
      replacement = placeholder;
      redactionMap.set(placeholder, entity.text);
      operatorMap.set(placeholder, "replace");
    }
    newText = newText.slice(0, ms) + replacement + newText.slice(me);
    delta += replacement.length - (me - ms);
    entityCount += 1;
    lastEnd = entity.end;
    accepted.push(entity);
  }

  if (accepted.length === 0) {
    return withNerEntities(base, nerEntities);
  }

  return {
    resolvedEntities: [
      ...base.resolvedEntities,
      ...(accepted as readonly NativePipelineEntity[]),
    ],
    redaction: {
      redactedText: newText,
      redactionMap,
      operatorMap,
      entityCount,
    },
  };
};

const rustNextStart = (
  fullText: string,
  rust: readonly Entity[],
  current: Entity,
): number => {
  const idx = rust.indexOf(current);
  const next = rust.at(idx + 1);
  return next === undefined ? fullText.length : next.start;
};
