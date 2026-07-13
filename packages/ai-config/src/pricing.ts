import { AiConfigurationError } from "@caseweaver/ai-sdk";

import {
  addDecimals,
  type DecimalString,
  decimal,
  multiplyDecimalByInteger,
} from "./decimal.js";

export type PriceComponentKind =
  | "input"
  | "output"
  | "cacheRead"
  | "cacheCreation"
  | "image"
  | "audio";

export type PriceConditionValue = boolean | number | string;
export type PriceConditions = Readonly<Record<string, PriceConditionValue>>;

export interface PriceComponent {
  readonly id: string;
  readonly kind: PriceComponentKind;
  readonly unit: "token" | "image" | "audio";
  readonly amount: DecimalString;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly sourceId: string;
  readonly conditions: PriceConditions;
}

export interface PriceResolutionContext {
  readonly at: string;
  readonly currency: string;
  readonly providerRegion?: string;
  readonly serviceTier?: string;
  readonly batchMode?: boolean;
  readonly contextTier?: string;
  readonly mediaType?: string;
  readonly inputTokenCount?: number;
}

export type PriceResolutionStatus = "known" | "unknown" | "incomplete";

export interface ResolvedPriceComponent {
  readonly kind: PriceComponentKind;
  readonly component?: PriceComponent;
  readonly status: PriceResolutionStatus;
  readonly reason?: string;
}

export interface PriceResolution {
  readonly status: PriceResolutionStatus;
  readonly components: readonly ResolvedPriceComponent[];
}

export interface PriceSources {
  readonly bindingOverrides: readonly PriceComponent[];
  readonly workspaceOverrides: readonly PriceComponent[];
  readonly installationOverrides: readonly PriceComponent[];
  readonly catalogComponents: readonly PriceComponent[];
}

type ConditionMatch = "matches" | "doesNotMatch" | "undecidable";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function active(component: PriceComponent, at: Date): boolean {
  const starts = new Date(component.effectiveFrom);
  const ends =
    component.effectiveTo === undefined
      ? undefined
      : new Date(component.effectiveTo);
  return (
    !Number.isNaN(starts.getTime()) &&
    (ends === undefined || !Number.isNaN(ends.getTime())) &&
    starts <= at &&
    (ends === undefined || at < ends)
  );
}

function conditionMatch(
  conditions: PriceConditions,
  context: PriceResolutionContext,
): ConditionMatch {
  let matches = true;
  for (const [key, value] of Object.entries(conditions)) {
    switch (key) {
      case "providerRegion":
        if (
          !isNonEmptyString(value) ||
          !isNonEmptyString(context.providerRegion)
        ) {
          return "undecidable";
        }
        if (context.providerRegion !== value) matches = false;
        continue;
      case "serviceTier":
        if (
          !isNonEmptyString(value) ||
          !isNonEmptyString(context.serviceTier)
        ) {
          return "undecidable";
        }
        if (context.serviceTier !== value) matches = false;
        continue;
      case "batchMode":
        if (
          typeof value !== "boolean" ||
          typeof context.batchMode !== "boolean"
        ) {
          return "undecidable";
        }
        if (context.batchMode !== value) matches = false;
        continue;
      case "contextTier":
        if (
          !isNonEmptyString(value) ||
          !isNonEmptyString(context.contextTier)
        ) {
          return "undecidable";
        }
        if (context.contextTier !== value) matches = false;
        continue;
      case "mediaType":
        if (!isNonEmptyString(value) || !isNonEmptyString(context.mediaType)) {
          return "undecidable";
        }
        if (context.mediaType !== value) matches = false;
        continue;
      case "inputTokenThreshold":
        if (
          !isNonNegativeSafeInteger(value) ||
          !isNonNegativeSafeInteger(context.inputTokenCount)
        ) {
          return "undecidable";
        }
        if (context.inputTokenCount < value) matches = false;
        continue;
      default:
        return "undecidable";
    }
  }
  return matches ? "matches" : "doesNotMatch";
}

function selectFromScope(
  candidates: readonly PriceComponent[],
  kind: PriceComponentKind,
  context: PriceResolutionContext,
): ResolvedPriceComponent | undefined {
  const at = new Date(context.at);
  if (Number.isNaN(at.getTime())) {
    throw new AiConfigurationError(
      "Price resolution time must be an ISO instant.",
    );
  }
  const matching: PriceComponent[] = [];
  let undecidable = false;
  for (const candidate of candidates) {
    if (candidate.kind !== kind || !active(candidate, at)) continue;
    const match = conditionMatch(candidate.conditions, context);
    if (match === "undecidable") undecidable = true;
    if (match === "matches") matching.push(candidate);
  }
  if (undecidable) {
    return { kind, status: "incomplete", reason: "unsupportedCondition" };
  }
  if (matching.length === 0) return undefined;
  matching.sort((left, right) => {
    const specificity =
      Object.keys(right.conditions).length -
      Object.keys(left.conditions).length;
    if (specificity !== 0) return specificity;
    return (
      new Date(right.effectiveFrom).getTime() -
      new Date(left.effectiveFrom).getTime()
    );
  });
  const selected = matching[0];
  const runnerUp = matching[1];
  if (
    selected !== undefined &&
    runnerUp !== undefined &&
    Object.keys(selected.conditions).length ===
      Object.keys(runnerUp.conditions).length &&
    selected.effectiveFrom === runnerUp.effectiveFrom
  ) {
    throw new AiConfigurationError(
      "Overlapping price components are tied at the same precedence.",
      { component: kind },
    );
  }
  if (selected === undefined) {
    return undefined;
  }
  if (selected.currency !== context.currency) {
    return { kind, status: "incomplete", reason: "foreignCurrency" };
  }
  return { kind, component: selected, status: "known" };
}

export function resolvePrices(
  sources: PriceSources,
  kinds: readonly PriceComponentKind[],
  context: PriceResolutionContext,
): PriceResolution {
  const components = kinds.map((kind) => {
    for (const source of [
      sources.bindingOverrides,
      sources.workspaceOverrides,
      sources.installationOverrides,
      sources.catalogComponents,
    ]) {
      const selected = selectFromScope(source, kind, context);
      if (selected !== undefined) return selected;
    }
    return { kind, status: "unknown" } satisfies ResolvedPriceComponent;
  });
  const status = components.some(
    (component) => component.status === "incomplete",
  )
    ? "incomplete"
    : components.some((component) => component.status === "unknown")
      ? "unknown"
      : "known";
  return Object.freeze({ status, components: Object.freeze(components) });
}

export interface UsageUnits {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheCreation?: number;
  readonly image?: number;
  readonly audio?: number;
}

export interface CostCalculation {
  readonly status: PriceResolutionStatus;
  readonly amount?: DecimalString;
  readonly currency?: string;
  readonly components: readonly {
    readonly kind: PriceComponentKind;
    readonly units: number;
    readonly amount?: DecimalString;
  }[];
}

function unitsFor(kind: PriceComponentKind, usage: UsageUnits): number {
  const value = usage[kind] ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AiConfigurationError(
      "Usage units must be non-negative integers.",
      {
        component: kind,
      },
    );
  }
  return value;
}

export function calculateCost(
  resolution: PriceResolution,
  usage: UsageUnits,
): CostCalculation {
  let total = decimal("0");
  const calculated: {
    kind: PriceComponentKind;
    units: number;
    amount?: DecimalString;
  }[] = [];
  let status: PriceResolutionStatus = "known";
  let currency: string | undefined;
  for (const resolved of resolution.components) {
    const units = unitsFor(resolved.kind, usage);
    if (units === 0) {
      calculated.push({ kind: resolved.kind, units });
      continue;
    }
    if (resolved.status !== "known" || resolved.component === undefined) {
      status = resolved.status === "incomplete" ? "incomplete" : status;
      if (status !== "incomplete") status = "unknown";
      calculated.push({ kind: resolved.kind, units });
      continue;
    }
    if (currency === undefined) currency = resolved.component.currency;
    if (currency !== resolved.component.currency) {
      return Object.freeze({
        status: "incomplete",
        components: Object.freeze(calculated),
      });
    }
    const amount = multiplyDecimalByInteger(resolved.component.amount, units);
    total = addDecimals(total, amount);
    calculated.push({ kind: resolved.kind, units, amount });
  }
  return Object.freeze({
    status,
    amount: status === "known" ? total : undefined,
    currency: status === "known" ? currency : undefined,
    components: Object.freeze(calculated),
  });
}

export interface ReservationBounds {
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly mayUsePromptCache: boolean;
  readonly maximumImageUnits?: number;
  readonly maximumAudioUnits?: number;
}

export function conservativeReservationUsage(
  bounds: ReservationBounds,
): UsageUnits {
  const optionalUnit = (value: number | undefined): number => value ?? 0;
  return Object.freeze({
    input: bounds.maximumInputTokens,
    output: bounds.maximumOutputTokens,
    cacheRead: bounds.mayUsePromptCache ? bounds.maximumInputTokens : 0,
    cacheCreation: bounds.mayUsePromptCache ? bounds.maximumInputTokens : 0,
    image: optionalUnit(bounds.maximumImageUnits),
    audio: optionalUnit(bounds.maximumAudioUnits),
  });
}
