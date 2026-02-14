// @meridian/axis — Cron expression parser (Phase 9.4)
// Custom 5-field cron parser: minute hour day-of-month month day-of-week
// Supports: *, ranges (1-5), lists (1,3,5), steps (*/5), aliases (@hourly, etc.)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed cron schedule with expanded field sets.
 */
export interface CronSchedule {
  /** Minutes (0-59) */
  minutes: ReadonlySet<number>;
  /** Hours (0-23) */
  hours: ReadonlySet<number>;
  /** Days of month (1-31) */
  daysOfMonth: ReadonlySet<number>;
  /** Months (1-12) */
  months: ReadonlySet<number>;
  /** Days of week (0-6, Sunday=0) */
  daysOfWeek: ReadonlySet<number>;
  /** Original expression string */
  expression: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 6],   // day of week
];

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Predefined schedule aliases. */
const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single cron field value into a set of numbers.
 *
 * Supports:
 * - `*` — all values in range
 * - `N` — single value
 * - `N-M` — range (inclusive)
 * - `N,M,O` — list
 * - `N/S` — start at N, step by S
 * - `* /S` — every S from range start (written without space)
 * - Named months/days (jan-dec, sun-sat) in month/dow fields
 */
function parseField(
  field: string,
  min: number,
  max: number,
  nameMap?: Record<string, number>,
): Set<number> {
  const result = new Set<number>();

  // Handle comma-separated list
  const parts = field.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '') continue;

    // Resolve named values
    const resolved = nameMap
      ? trimmed.replace(
          /[a-z]+/gi,
          (match) => String(nameMap[match.toLowerCase()] ?? match),
        )
      : trimmed;

    if (resolved.includes('/')) {
      // Step: */S or N/S or N-M/S
      const [rangeStr, stepStr] = resolved.split('/');
      if (!stepStr) {
        throw new Error(`Invalid step expression: ${part}`);
      }
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) {
        throw new Error(`Invalid step value: ${stepStr}`);
      }

      let start = min;
      let end = max;

      if (rangeStr !== '*') {
        if (rangeStr && rangeStr.includes('-')) {
          const [rStart, rEnd] = rangeStr.split('-');
          if (!rStart || !rEnd) {
            throw new Error(`Invalid range in step expression: ${part}`);
          }
          start = parseInt(rStart, 10);
          end = parseInt(rEnd, 10);
        } else if (rangeStr) {
          start = parseInt(rangeStr, 10);
        }
      }

      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid range in field: ${part}`);
      }

      for (let i = start; i <= end; i += step) {
        result.add(i);
      }
    } else if (resolved.includes('-')) {
      // Range: N-M
      const [startStr, endStr] = resolved.split('-');
      if (!startStr || !endStr) {
        throw new Error(`Invalid range expression: ${part}`);
      }
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid range: ${part}`);
      }

      for (let i = start; i <= end; i++) {
        result.add(i);
      }
    } else if (resolved === '*') {
      // Wildcard: all values
      for (let i = min; i <= max; i++) {
        result.add(i);
      }
    } else {
      // Single value
      const value = parseInt(resolved, 10);
      if (isNaN(value)) {
        throw new Error(`Invalid cron field value: ${part}`);
      }
      result.add(value);
    }
  }

  // Validate all values are in range
  for (const value of result) {
    if (value < min || value > max) {
      throw new Error(
        `Value ${value} out of range [${min}-${max}] in field: ${field}`,
      );
    }
  }

  if (result.size === 0) {
    throw new Error(`Empty field: ${field}`);
  }

  return result;
}

/**
 * Parse a cron expression string into a CronSchedule.
 *
 * Accepts either:
 * - 5-field format: `minute hour day-of-month month day-of-week`
 * - Alias: `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`/`@annually`
 *
 * @throws Error if the expression is invalid
 */
export function parseCronExpression(expression: string): CronSchedule {
  const trimmed = expression.trim();

  // Check for aliases
  if (trimmed.startsWith('@')) {
    const expanded = ALIASES[trimmed.toLowerCase()];
    if (!expanded) {
      throw new Error(`Unknown cron alias: ${trimmed}`);
    }
    return parseCronExpression(expanded);
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Expected 5 fields in cron expression, got ${fields.length}: "${trimmed}"`,
    );
  }

  const [minuteStr, hourStr, domStr, monthStr, dowStr] = fields;

  // Fields array guaranteed to have 5 elements due to check above
  if (!minuteStr || !hourStr || !domStr || !monthStr || !dowStr) {
    throw new Error(`Invalid cron expression: empty field in "${trimmed}"`);
  }

  const rangeMinute = FIELD_RANGES[0];
  const rangeHour = FIELD_RANGES[1];
  const rangeDom = FIELD_RANGES[2];
  const rangeMonth = FIELD_RANGES[3];
  const rangeDow = FIELD_RANGES[4];

  if (!rangeMinute || !rangeHour || !rangeDom || !rangeMonth || !rangeDow) {
    throw new Error('Internal error: FIELD_RANGES not properly initialized');
  }

  const minutes = parseField(minuteStr, ...rangeMinute);
  const hours = parseField(hourStr, ...rangeHour);
  const daysOfMonth = parseField(domStr, ...rangeDom);
  const months = parseField(monthStr, ...rangeMonth, MONTH_NAMES);
  const daysOfWeek = parseField(dowStr, ...rangeDow, DOW_NAMES);

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    expression: trimmed,
  };
}

/**
 * Validate a cron expression without parsing it into a schedule.
 * Returns true if the expression is valid.
 */
export function isValidCronExpression(expression: string): boolean {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Next-run calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the next time a cron schedule should fire after the given date.
 *
 * The search starts from the minute **after** the `after` date.
 * Returns undefined if no match is found within 4 years (prevents infinite loop).
 *
 * @param schedule - Parsed cron schedule
 * @param after - Start searching after this date (default: now)
 * @returns The next fire time, or undefined if none found within 4 years
 */
export function getNextRun(
  schedule: CronSchedule,
  after: Date = new Date(),
): Date | undefined {
  // Start from the next whole minute
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Safety: stop searching after 4 years
  const maxDate = new Date(after);
  maxDate.setFullYear(maxDate.getFullYear() + 4);

  while (candidate < maxDate) {
    const month = candidate.getMonth() + 1; // 1-12
    const dom = candidate.getDate();
    const dow = candidate.getDay(); // 0-6
    const hour = candidate.getHours();
    const minute = candidate.getMinutes();

    // Check month
    if (!schedule.months.has(month)) {
      // Skip to first day of next month
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // Check day (must match both day-of-month AND day-of-week)
    const domMatch = schedule.daysOfMonth.has(dom);
    const dowMatch = schedule.daysOfWeek.has(dow);

    // Standard cron behavior: if both dom and dow are restricted (not *),
    // match if EITHER matches. If only one is restricted, it must match.
    const domIsWild = schedule.daysOfMonth.size === 31;
    const dowIsWild = schedule.daysOfWeek.size === 7;

    let dayMatch: boolean;
    if (domIsWild && dowIsWild) {
      dayMatch = true;
    } else if (domIsWild) {
      dayMatch = dowMatch;
    } else if (dowIsWild) {
      dayMatch = domMatch;
    } else {
      // Both restricted: match if either matches (standard cron behavior)
      dayMatch = domMatch || dowMatch;
    }

    if (!dayMatch) {
      // Skip to next day
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    // Check hour
    if (!schedule.hours.has(hour)) {
      // Skip to next hour
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    // Check minute
    if (!schedule.minutes.has(minute)) {
      // Skip to next minute
      candidate.setMinutes(candidate.getMinutes() + 1);
      continue;
    }

    // All fields match
    return new Date(candidate);
  }

  return undefined;
}
