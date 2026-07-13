import { AiPriceError } from "@caseweaver/ai-sdk";

export type DecimalString = string & { readonly __decimal: unique symbol };

interface ParsedDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalPattern = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

function parse(value: string | number): ParsedDecimal {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new AiPriceError("Price must be finite.");
  }
  const text = String(value).trim();
  const match = decimalPattern.exec(text);
  if (match === null) {
    throw new AiPriceError("Price must be a decimal number.");
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent)) {
    throw new AiPriceError("Price exponent is invalid.");
  }
  const coefficient = BigInt(`${integer}${fraction}`) * sign;
  const scale = fraction.length - exponent;
  if (scale < -38 || scale > 100) {
    throw new AiPriceError("Price precision is outside supported bounds.");
  }
  return { coefficient, scale };
}

function scaledCoefficient(value: ParsedDecimal, targetScale: number): bigint {
  return value.coefficient * 10n ** BigInt(targetScale - value.scale);
}

function format(coefficient: bigint, scale: number): DecimalString {
  if (coefficient === 0n) {
    return "0" as DecimalString;
  }
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString();
  let rendered: string;
  if (scale <= 0) {
    rendered = `${digits}${"0".repeat(-scale)}`;
  } else if (digits.length <= scale) {
    rendered = `0.${"0".repeat(scale - digits.length)}${digits}`;
  } else {
    rendered = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  const normalized = rendered.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return `${negative ? "-" : ""}${normalized}` as DecimalString;
}

export function decimal(value: string | number): DecimalString {
  const parsed = parse(value);
  const rendered = format(parsed.coefficient, parsed.scale);
  const [, fraction = ""] = rendered.replace(/^-/, "").split(".");
  const digits = rendered.replace(/[-.]/g, "").replace(/^0+/, "");
  if (fraction.length > 18 || digits.length > 38) {
    throw new AiPriceError("Price cannot be stored as numeric(38,18).");
  }
  return rendered;
}

export function decimalIsNegative(value: DecimalString): boolean {
  return value.startsWith("-");
}

export function addDecimals(
  left: DecimalString,
  right: DecimalString,
): DecimalString {
  const leftParsed = parse(left);
  const rightParsed = parse(right);
  const scale = Math.max(leftParsed.scale, rightParsed.scale);
  return decimal(
    format(
      scaledCoefficient(leftParsed, scale) +
        scaledCoefficient(rightParsed, scale),
      scale,
    ),
  );
}

export function multiplyDecimalByInteger(
  value: DecimalString,
  multiplier: number,
): DecimalString {
  if (!Number.isSafeInteger(multiplier) || multiplier < 0) {
    throw new AiPriceError("Usage unit count must be a non-negative integer.");
  }
  const parsed = parse(value);
  return decimal(format(parsed.coefficient * BigInt(multiplier), parsed.scale));
}

export function compareDecimals(
  left: DecimalString,
  right: DecimalString,
): number {
  const leftParsed = parse(left);
  const rightParsed = parse(right);
  const scale = Math.max(leftParsed.scale, rightParsed.scale);
  const leftCoefficient = scaledCoefficient(leftParsed, scale);
  const rightCoefficient = scaledCoefficient(rightParsed, scale);
  return leftCoefficient === rightCoefficient
    ? 0
    : leftCoefficient > rightCoefficient
      ? 1
      : -1;
}
