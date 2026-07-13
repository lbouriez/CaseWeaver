import { createHash } from "node:crypto";

import type { KnowledgeSchedule, ScheduleCadence } from "./types.js";

interface CronFields {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  readonly dayOfMonthWildcard: boolean;
  readonly dayOfWeekWildcard: boolean;
}

interface LocalDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function validDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`Schedule ${field} must be a valid UTC instant.`);
  }
  return parsed;
}

function parseNumber(value: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) {
    throw new RangeError("Cron fields must use numeric values.");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(
      `Cron value must be between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

function parseField(
  expression: string,
  minimum: number,
  maximum: number,
  dayOfWeek = false,
): ReadonlySet<number> {
  const result = new Set<number>();
  for (const part of expression.split(",")) {
    const [rangeExpression, stepExpression] = part.split("/");
    if (
      rangeExpression === undefined ||
      (stepExpression === undefined && part.includes("/"))
    ) {
      throw new RangeError("Cron step expressions are invalid.");
    }
    const step =
      stepExpression === undefined
        ? 1
        : parseNumber(stepExpression, 1, maximum - minimum + 1);
    let start = minimum;
    let end = maximum;
    if (rangeExpression !== "*") {
      const range = rangeExpression.split("-");
      if (range.length === 1) {
        const single = parseNumber(rangeExpression, minimum, maximum);
        start = single;
        end = single;
      } else if (range.length === 2) {
        start = parseNumber(range[0] ?? "", minimum, maximum);
        end = parseNumber(range[1] ?? "", minimum, maximum);
        if (end < start) {
          throw new RangeError("Cron ranges must be ascending.");
        }
      } else {
        throw new RangeError("Cron ranges are invalid.");
      }
    }
    for (let value = start; value <= end; value += step) {
      result.add(dayOfWeek && value === 7 ? 0 : value);
    }
  }
  return result;
}

function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new RangeError("Cron schedules must contain five fields.");
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    throw new RangeError("Cron schedules must contain five fields.");
  }
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dayOfMonth: parseField(dayOfMonth, 1, 31),
    month: parseField(month, 1, 12),
    dayOfWeek: parseField(dayOfWeek, 0, 7, true),
    dayOfMonthWildcard: dayOfMonth === "*",
    dayOfWeekWildcard: dayOfWeek === "*",
  };
}

function localDateTime(date: Date, timezone: string): LocalDateTime {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "iso8601",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const year = values.year;
  const month = values.month;
  const day = values.day;
  const hour = values.hour;
  const minute = values.minute;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    throw new RangeError(
      "Unable to calculate the local time for a cron schedule.",
    );
  }
  return { year, month, day, hour, minute };
}

function matchesCron(fields: CronFields, local: LocalDateTime): boolean {
  if (
    !fields.minute.has(local.minute) ||
    !fields.hour.has(local.hour) ||
    !fields.month.has(local.month)
  ) {
    return false;
  }
  const dayOfWeek = new Date(
    Date.UTC(local.year, local.month - 1, local.day),
  ).getUTCDay();
  const matchesDayOfMonth = fields.dayOfMonth.has(local.day);
  const matchesDayOfWeek = fields.dayOfWeek.has(dayOfWeek);
  if (fields.dayOfMonthWildcard || fields.dayOfWeekWildcard) {
    return matchesDayOfMonth && matchesDayOfWeek;
  }
  return matchesDayOfMonth || matchesDayOfWeek;
}

function jitterMs(
  scheduleId: string,
  nominalOccurrence: Date,
  maximum: number | undefined,
): number {
  if (maximum === undefined || maximum === 0) return 0;
  if (!Number.isInteger(maximum) || maximum < 0) {
    throw new RangeError("Schedule jitter must be a non-negative integer.");
  }
  const digest = createHash("sha256")
    .update(`${scheduleId}:${nominalOccurrence.toISOString()}`, "utf8")
    .digest();
  return digest.readUInt32BE(0) % (maximum + 1);
}

function nextCronOccurrence(
  scheduleId: string,
  cadence: Extract<ScheduleCadence, { readonly kind: "cron" }>,
  after: Date,
): Date {
  const fields = parseCron(cadence.expression);
  // Validates the IANA identifier before the scan. DST gaps are skipped naturally,
  // while repeated local times remain separate UTC occurrences with distinct keys.
  localDateTime(after, cadence.timezone);
  const candidate = new Date(
    Math.floor(after.getTime() / 60_000) * 60_000 + 60_000,
  );
  const maximumMinutes = 366 * 24 * 60 * 2;
  for (let minute = 0; minute < maximumMinutes; minute += 1) {
    if (matchesCron(fields, localDateTime(candidate, cadence.timezone))) {
      return new Date(
        candidate.getTime() + jitterMs(scheduleId, candidate, cadence.jitterMs),
      );
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new RangeError("Cron schedule has no occurrence within two years.");
}

export function nextRunAt(schedule: KnowledgeSchedule, after: string): string {
  const afterDate = validDate(after, "reference time");
  if (schedule.cadence.kind === "cron") {
    return nextCronOccurrence(
      schedule.id,
      schedule.cadence,
      afterDate,
    ).toISOString();
  }
  const { intervalMs } = schedule.cadence;
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError("Schedule interval must be a positive integer.");
  }
  const nominal = new Date(afterDate.getTime() + intervalMs);
  return new Date(
    nominal.getTime() +
      jitterMs(schedule.id, nominal, schedule.cadence.jitterMs),
  ).toISOString();
}

export function isDue(schedule: KnowledgeSchedule, now: string): boolean {
  if (!schedule.enabled) return false;
  return (
    validDate(schedule.nextRunAt, "next run").getTime() <=
    validDate(now, "clock").getTime()
  );
}
