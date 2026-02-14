// @meridian/axis — Cron parser tests

import { describe, it, expect } from 'vitest';

import {
  parseCronExpression,
  isValidCronExpression,
  getNextRun,
} from './cron-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fixed reference date: Friday, 2026-02-13 10:30:00 local time.
 * getNextRun uses local Date methods (getHours, getMinutes, etc.), so we
 * construct dates via the local-time constructor for deterministic tests.
 */
const REF_DATE = new Date(2026, 1, 13, 10, 30, 0, 0);

/**
 * Helper to build a local-time Date with seconds/ms zeroed.
 * Month is 1-indexed here (unlike the Date constructor) for readability.
 */
function localDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** Convert a ReadonlySet to a sorted array for easier assertions. */
function toArray(set: ReadonlySet<number>): number[] {
  return [...set].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// parseCronExpression
// ---------------------------------------------------------------------------

describe('parseCronExpression', () => {
  describe('basic 5-field expressions', () => {
    it('should parse every-minute wildcard expression', () => {
      const schedule = parseCronExpression('* * * * *');
      expect(schedule.minutes.size).toBe(60);
      expect(schedule.hours.size).toBe(24);
      expect(schedule.daysOfMonth.size).toBe(31);
      expect(schedule.months.size).toBe(12);
      expect(schedule.daysOfWeek.size).toBe(7);
    });

    it('should parse a specific time expression', () => {
      const schedule = parseCronExpression('0 12 * * *');
      expect(toArray(schedule.minutes)).toEqual([0]);
      expect(toArray(schedule.hours)).toEqual([12]);
      expect(schedule.daysOfMonth.size).toBe(31);
      expect(schedule.months.size).toBe(12);
      expect(schedule.daysOfWeek.size).toBe(7);
    });

    it('should parse a fully specified expression', () => {
      const schedule = parseCronExpression('30 9 15 6 3');
      expect(toArray(schedule.minutes)).toEqual([30]);
      expect(toArray(schedule.hours)).toEqual([9]);
      expect(toArray(schedule.daysOfMonth)).toEqual([15]);
      expect(toArray(schedule.months)).toEqual([6]);
      expect(toArray(schedule.daysOfWeek)).toEqual([3]);
    });

    it('should preserve the original expression string', () => {
      const schedule = parseCronExpression('0 12 * * *');
      expect(schedule.expression).toBe('0 12 * * *');
    });

    it('should trim whitespace from the expression', () => {
      const schedule = parseCronExpression('  0  12  *  *  *  ');
      expect(toArray(schedule.minutes)).toEqual([0]);
      expect(toArray(schedule.hours)).toEqual([12]);
    });
  });

  describe('ranges', () => {
    it('should parse a minute range', () => {
      const schedule = parseCronExpression('1-5 * * * *');
      expect(toArray(schedule.minutes)).toEqual([1, 2, 3, 4, 5]);
    });

    it('should parse an hour range', () => {
      const schedule = parseCronExpression('0 9-17 * * *');
      expect(toArray(schedule.hours)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    });

    it('should parse a day-of-month range', () => {
      const schedule = parseCronExpression('0 0 1-7 * *');
      expect(toArray(schedule.daysOfMonth)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('should parse a single-value range where start equals end', () => {
      const schedule = parseCronExpression('5-5 * * * *');
      expect(toArray(schedule.minutes)).toEqual([5]);
    });
  });

  describe('lists', () => {
    it('should parse a comma-separated minute list', () => {
      const schedule = parseCronExpression('1,3,5 * * * *');
      expect(toArray(schedule.minutes)).toEqual([1, 3, 5]);
    });

    it('should parse a list in multiple fields', () => {
      const schedule = parseCronExpression('0,30 8,12,18 * * *');
      expect(toArray(schedule.minutes)).toEqual([0, 30]);
      expect(toArray(schedule.hours)).toEqual([8, 12, 18]);
    });

    it('should parse a list combined with a range', () => {
      const schedule = parseCronExpression('0,15,30-35 * * * *');
      expect(toArray(schedule.minutes)).toEqual([0, 15, 30, 31, 32, 33, 34, 35]);
    });

    it('should deduplicate overlapping list and range values', () => {
      const schedule = parseCronExpression('5,3,5,3 * * * *');
      expect(toArray(schedule.minutes)).toEqual([3, 5]);
    });
  });

  describe('steps', () => {
    it('should parse a wildcard step expression', () => {
      const schedule = parseCronExpression('*/5 * * * *');
      expect(toArray(schedule.minutes)).toEqual(
        [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55],
      );
    });

    it('should parse a step with an explicit start', () => {
      const schedule = parseCronExpression('3/10 * * * *');
      expect(toArray(schedule.minutes)).toEqual([3, 13, 23, 33, 43, 53]);
    });

    it('should parse a step over a range', () => {
      const schedule = parseCronExpression('10-30/5 * * * *');
      expect(toArray(schedule.minutes)).toEqual([10, 15, 20, 25, 30]);
    });

    it('should parse a step in the hour field', () => {
      const schedule = parseCronExpression('0 */6 * * *');
      expect(toArray(schedule.hours)).toEqual([0, 6, 12, 18]);
    });

    it('should parse a step in the month field', () => {
      const schedule = parseCronExpression('0 0 1 */3 *');
      expect(toArray(schedule.months)).toEqual([1, 4, 7, 10]);
    });

    it('should parse a step over a range in the hour field', () => {
      const schedule = parseCronExpression('0 8-20/4 * * *');
      expect(toArray(schedule.hours)).toEqual([8, 12, 16, 20]);
    });
  });

  describe('aliases', () => {
    it('should parse @hourly alias', () => {
      const schedule = parseCronExpression('@hourly');
      expect(toArray(schedule.minutes)).toEqual([0]);
      expect(schedule.hours.size).toBe(24);
      expect(schedule.daysOfMonth.size).toBe(31);
      expect(schedule.months.size).toBe(12);
      expect(schedule.daysOfWeek.size).toBe(7);
    });

    it('should parse @daily alias', () => {
      const schedule = parseCronExpression('@daily');
      expect(toArray(schedule.minutes)).toEqual([0]);
      expect(toArray(schedule.hours)).toEqual([0]);
      expect(schedule.daysOfMonth.size).toBe(31);
      expect(schedule.months.size).toBe(12);
      expect(schedule.daysOfWeek.size).toBe(7);
    });

    it('should parse @weekly alias', () => {
      const schedule = parseCronExpression('@weekly');
      expect(toArray(schedule.minutes)).toEqual([0]);
      expect(toArray(schedule.hours)).toEqual([0]);
      expect(schedule.daysOfMonth.size).toBe(31);
      expect(schedule.months.size).toBe(12);
      expect(toArray(schedule.daysOfWeek)).toEqual([0]);
    });

    it('should parse @monthly alias', () => {
      const schedule = parseCronExpression('@monthly');
      expect(toArray(schedule.minutes)).toEqual([0]);
      expect(toArray(schedule.hours)).toEqual([0]);
      expect(toArray(schedule.daysOfMonth)).toEqual([1]);
      expect(schedule.months.size).toBe(12);
      expect(schedule.daysOfWeek.size).toBe(7);
    });

    it('should parse @yearly alias', () => {
      const schedule = parseCronExpression('@yearly');
      expect(toArray(schedule.minutes)).toEqual([0]);
      expect(toArray(schedule.hours)).toEqual([0]);
      expect(toArray(schedule.daysOfMonth)).toEqual([1]);
      expect(toArray(schedule.months)).toEqual([1]);
      expect(schedule.daysOfWeek.size).toBe(7);
    });

    it('should parse @annually as equivalent to @yearly', () => {
      const yearly = parseCronExpression('@yearly');
      const annually = parseCronExpression('@annually');
      expect(toArray(annually.minutes)).toEqual(toArray(yearly.minutes));
      expect(toArray(annually.hours)).toEqual(toArray(yearly.hours));
      expect(toArray(annually.daysOfMonth)).toEqual(toArray(yearly.daysOfMonth));
      expect(toArray(annually.months)).toEqual(toArray(yearly.months));
      expect(toArray(annually.daysOfWeek)).toEqual(toArray(yearly.daysOfWeek));
    });

    it('should parse @midnight as equivalent to @daily', () => {
      const daily = parseCronExpression('@daily');
      const midnight = parseCronExpression('@midnight');
      expect(toArray(midnight.minutes)).toEqual(toArray(daily.minutes));
      expect(toArray(midnight.hours)).toEqual(toArray(daily.hours));
    });

    it('should handle aliases case-insensitively', () => {
      const schedule = parseCronExpression('@DAILY');
      expect(toArray(schedule.minutes)).toEqual([0]);
      expect(toArray(schedule.hours)).toEqual([0]);
    });
  });

  describe('named months', () => {
    it('should parse lowercase month names', () => {
      const schedule = parseCronExpression('0 0 1 jan *');
      expect(toArray(schedule.months)).toEqual([1]);
    });

    it('should parse uppercase month names', () => {
      const schedule = parseCronExpression('0 0 1 DEC *');
      expect(toArray(schedule.months)).toEqual([12]);
    });

    it('should parse all month names correctly', () => {
      const expr = '0 0 1 jan,feb,mar,apr,may,jun,jul,aug,sep,oct,nov,dec *';
      const schedule = parseCronExpression(expr);
      expect(toArray(schedule.months)).toEqual(
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      );
    });

    it('should parse a month range using names', () => {
      const schedule = parseCronExpression('0 0 1 mar-jun *');
      expect(toArray(schedule.months)).toEqual([3, 4, 5, 6]);
    });
  });

  describe('named days of week', () => {
    it('should parse lowercase day-of-week names', () => {
      const schedule = parseCronExpression('0 0 * * mon');
      expect(toArray(schedule.daysOfWeek)).toEqual([1]);
    });

    it('should parse uppercase day-of-week names', () => {
      const schedule = parseCronExpression('0 0 * * FRI');
      expect(toArray(schedule.daysOfWeek)).toEqual([5]);
    });

    it('should parse all day-of-week names correctly', () => {
      const schedule = parseCronExpression('0 0 * * sun,mon,tue,wed,thu,fri,sat');
      expect(toArray(schedule.daysOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('should parse a day-of-week range using names', () => {
      const schedule = parseCronExpression('0 9 * * mon-fri');
      expect(toArray(schedule.daysOfWeek)).toEqual([1, 2, 3, 4, 5]);
    });

    it('should parse sunday as 0', () => {
      const schedule = parseCronExpression('0 0 * * sun');
      expect(toArray(schedule.daysOfWeek)).toEqual([0]);
    });
  });

  describe('invalid expressions', () => {
    it('should throw for an expression with too few fields', () => {
      expect(() => parseCronExpression('* * *')).toThrow(
        /Expected 5 fields/,
      );
    });

    it('should throw for an expression with too many fields', () => {
      expect(() => parseCronExpression('* * * * * *')).toThrow(
        /Expected 5 fields/,
      );
    });

    it('should throw for an empty expression', () => {
      expect(() => parseCronExpression('')).toThrow();
    });

    it('should throw for a minute value out of range', () => {
      expect(() => parseCronExpression('60 * * * *')).toThrow(/out of range/);
    });

    it('should throw for a negative minute value', () => {
      expect(() => parseCronExpression('-1 * * * *')).toThrow();
    });

    it('should throw for an hour value out of range', () => {
      expect(() => parseCronExpression('0 24 * * *')).toThrow(/out of range/);
    });

    it('should throw for a day-of-month value of 0', () => {
      expect(() => parseCronExpression('0 0 0 * *')).toThrow(/out of range/);
    });

    it('should throw for a day-of-month value of 32', () => {
      expect(() => parseCronExpression('0 0 32 * *')).toThrow(/out of range/);
    });

    it('should throw for a month value of 0', () => {
      expect(() => parseCronExpression('0 0 1 0 *')).toThrow(/out of range/);
    });

    it('should throw for a month value of 13', () => {
      expect(() => parseCronExpression('0 0 1 13 *')).toThrow(/out of range/);
    });

    it('should throw for a day-of-week value of 7', () => {
      expect(() => parseCronExpression('0 0 * * 7')).toThrow(/out of range/);
    });

    it('should throw for non-numeric field values', () => {
      expect(() => parseCronExpression('abc * * * *')).toThrow();
    });

    it('should throw for an invalid step value of 0', () => {
      expect(() => parseCronExpression('*/0 * * * *')).toThrow(/Invalid step/);
    });

    it('should throw for a negative step value', () => {
      expect(() => parseCronExpression('*/-1 * * * *')).toThrow(/Invalid step/);
    });

    it('should throw for a non-numeric step value', () => {
      expect(() => parseCronExpression('*/abc * * * *')).toThrow(
        /Invalid step/,
      );
    });
  });

  describe('unknown aliases', () => {
    it('should throw for an unknown alias', () => {
      expect(() => parseCronExpression('@every5min')).toThrow(
        /Unknown cron alias/,
      );
    });

    it('should throw for @reboot alias (not supported)', () => {
      expect(() => parseCronExpression('@reboot')).toThrow(
        /Unknown cron alias/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// isValidCronExpression
// ---------------------------------------------------------------------------

describe('isValidCronExpression', () => {
  describe('valid expressions', () => {
    it('should return true for a wildcard expression', () => {
      expect(isValidCronExpression('* * * * *')).toBe(true);
    });

    it('should return true for a specific time expression', () => {
      expect(isValidCronExpression('0 12 * * *')).toBe(true);
    });

    it('should return true for a range expression', () => {
      expect(isValidCronExpression('1-5 * * * *')).toBe(true);
    });

    it('should return true for a step expression', () => {
      expect(isValidCronExpression('*/15 * * * *')).toBe(true);
    });

    it('should return true for a list expression', () => {
      expect(isValidCronExpression('0,15,30,45 * * * *')).toBe(true);
    });

    it('should return true for known aliases', () => {
      expect(isValidCronExpression('@hourly')).toBe(true);
      expect(isValidCronExpression('@daily')).toBe(true);
      expect(isValidCronExpression('@weekly')).toBe(true);
      expect(isValidCronExpression('@monthly')).toBe(true);
      expect(isValidCronExpression('@yearly')).toBe(true);
      expect(isValidCronExpression('@annually')).toBe(true);
    });

    it('should return true for named months and days', () => {
      expect(isValidCronExpression('0 0 * jan mon')).toBe(true);
    });
  });

  describe('invalid expressions', () => {
    it('should return false for an empty string', () => {
      expect(isValidCronExpression('')).toBe(false);
    });

    it('should return false for an expression with wrong field count', () => {
      expect(isValidCronExpression('* * *')).toBe(false);
    });

    it('should return false for out-of-range values', () => {
      expect(isValidCronExpression('60 * * * *')).toBe(false);
    });

    it('should return false for unknown aliases', () => {
      expect(isValidCronExpression('@every5min')).toBe(false);
    });

    it('should return false for non-numeric fields', () => {
      expect(isValidCronExpression('abc def * * *')).toBe(false);
    });

    it('should return false for an invalid step of 0', () => {
      expect(isValidCronExpression('*/0 * * * *')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// getNextRun
// ---------------------------------------------------------------------------

describe('getNextRun', () => {
  // Note: getNextRun uses local Date methods (getHours, getDay, etc.),
  // so all dates here are constructed in local time via localDate() or
  // the Date(year, month-1, ...) constructor for determinism.

  describe('simple next-minute cases', () => {
    it('should return the next minute for a wildcard schedule', () => {
      const schedule = parseCronExpression('* * * * *');
      const next = getNextRun(schedule, REF_DATE);
      // REF_DATE is local 10:30, next minute is 10:31
      expect(next).toEqual(localDate(2026, 2, 13, 10, 31));
    });

    it('should skip to the next matching minute', () => {
      const schedule = parseCronExpression('45 * * * *');
      const next = getNextRun(schedule, REF_DATE);
      // REF_DATE is :30, next :45 is in the same hour
      expect(next).toEqual(localDate(2026, 2, 13, 10, 45));
    });

    it('should roll over to the next hour if the minute has passed', () => {
      const schedule = parseCronExpression('15 * * * *');
      const next = getNextRun(schedule, REF_DATE);
      // REF_DATE is :30, so :15 this hour has passed; next is 11:15
      expect(next).toEqual(localDate(2026, 2, 13, 11, 15));
    });
  });

  describe('specific hour constraints', () => {
    it('should find the next occurrence at a specific hour', () => {
      const schedule = parseCronExpression('0 12 * * *');
      const next = getNextRun(schedule, REF_DATE);
      // REF_DATE is local 10:30, so next 12:00 is same day
      expect(next).toEqual(localDate(2026, 2, 13, 12, 0));
    });

    it('should skip to the next day if the hour has passed', () => {
      const schedule = parseCronExpression('0 8 * * *');
      const next = getNextRun(schedule, REF_DATE);
      // REF_DATE is local 10:30, so 08:00 has passed; next is tomorrow
      expect(next).toEqual(localDate(2026, 2, 14, 8, 0));
    });

    it('should handle midnight correctly', () => {
      const schedule = parseCronExpression('0 0 * * *');
      const next = getNextRun(schedule, REF_DATE);
      expect(next).toEqual(localDate(2026, 2, 14, 0, 0));
    });
  });

  describe('specific day constraints', () => {
    it('should skip to the specified day of month', () => {
      const schedule = parseCronExpression('0 0 20 * *');
      const next = getNextRun(schedule, REF_DATE);
      expect(next).toEqual(localDate(2026, 2, 20, 0, 0));
    });

    it('should skip to the next month if the day has passed', () => {
      const schedule = parseCronExpression('0 0 5 * *');
      const next = getNextRun(schedule, REF_DATE);
      // Feb 5 has passed (today is Feb 13), so next is Mar 5
      expect(next).toEqual(localDate(2026, 3, 5, 0, 0));
    });

    it('should handle the first of every month', () => {
      const schedule = parseCronExpression('0 0 1 * *');
      const next = getNextRun(schedule, REF_DATE);
      expect(next).toEqual(localDate(2026, 3, 1, 0, 0));
    });
  });

  describe('month boundaries', () => {
    it('should skip months that do not have 31 days', () => {
      const schedule = parseCronExpression('0 0 31 * *');
      const next = getNextRun(schedule, REF_DATE);
      // Feb has no 31st, March does
      expect(next).toEqual(localDate(2026, 3, 31, 0, 0));
    });

    it('should handle Feb 29 in non-leap years by finding the next leap year', () => {
      // 2026 is not a leap year
      const schedule = parseCronExpression('0 0 29 2 *');
      const next = getNextRun(schedule, REF_DATE);
      // Feb 29 does not exist in 2026 or 2027; next leap year is 2028
      expect(next).toEqual(localDate(2028, 2, 29, 0, 0));
    });

    it('should skip to the correct month for a specific month field', () => {
      const schedule = parseCronExpression('0 0 1 6 *');
      const next = getNextRun(schedule, REF_DATE);
      expect(next).toEqual(localDate(2026, 6, 1, 0, 0));
    });

    it('should wrap to the next year if the month has passed', () => {
      const schedule = parseCronExpression('0 0 1 1 *');
      const next = getNextRun(schedule, REF_DATE);
      // Jan has already passed in 2026
      expect(next).toEqual(localDate(2027, 1, 1, 0, 0));
    });
  });

  describe('day-of-week constraints', () => {
    it('should find the next Monday', () => {
      // REF_DATE is Friday Feb 13 2026, local time 10:30
      const schedule = parseCronExpression('0 9 * * 1');
      const next = getNextRun(schedule, REF_DATE);
      // Next Monday is Feb 16
      expect(next).toEqual(localDate(2026, 2, 16, 9, 0));
    });

    it('should find the next Sunday', () => {
      const schedule = parseCronExpression('0 0 * * 0');
      const next = getNextRun(schedule, REF_DATE);
      // Next Sunday is Feb 15
      expect(next).toEqual(localDate(2026, 2, 15, 0, 0));
    });

    it('should handle weekday range (Mon-Fri)', () => {
      const schedule = parseCronExpression('0 9 * * 1-5');
      const next = getNextRun(schedule, REF_DATE);
      // Today is Friday (dow=5), 09:00 local has passed (it is 10:30),
      // so next weekday 09:00 is Monday Feb 16
      expect(next).toEqual(localDate(2026, 2, 16, 9, 0));
    });

    it('should match today if the time has not passed yet', () => {
      // REF_DATE is Friday local 10:30, schedule is Friday at 12:00
      const schedule = parseCronExpression('0 12 * * 5');
      const next = getNextRun(schedule, REF_DATE);
      expect(next).toEqual(localDate(2026, 2, 13, 12, 0));
    });
  });

  describe('combined day-of-month and day-of-week (union behavior)', () => {
    it('should match if either day-of-month or day-of-week matches when both are restricted', () => {
      // Day 15 OR Monday: next match from Friday Feb 13 10:30 local
      // Feb 14 is Saturday (neither dom=15 nor dow=1)
      // Feb 15 is Sunday, matches dom=15 via union
      // Feb 16 is Monday, matches dow=1
      // So Feb 15 at 00:00 should be the first match
      const schedule = parseCronExpression('0 0 15 * 1');
      const next = getNextRun(schedule, REF_DATE);
      expect(next).toEqual(localDate(2026, 2, 15, 0, 0));
    });

    it('should match day-of-week via union when it comes before day-of-month', () => {
      // dom=20 or dow=1 (Monday)
      // Feb 16 is Monday (matches dow=1), Feb 20 is Friday
      // Feb 16 at 00:00 comes first
      const schedule = parseCronExpression('0 0 20 * 1');
      const next = getNextRun(schedule, REF_DATE);
      expect(next).toEqual(localDate(2026, 2, 16, 0, 0));
    });

    it('should require day-of-month match when only day-of-month is restricted', () => {
      const schedule = parseCronExpression('0 0 15 * *');
      const next = getNextRun(schedule, REF_DATE);
      expect(next).toEqual(localDate(2026, 2, 15, 0, 0));
    });

    it('should require day-of-week match when only day-of-week is restricted', () => {
      const schedule = parseCronExpression('0 0 * * 1');
      const next = getNextRun(schedule, REF_DATE);
      // Next Monday
      expect(next).toEqual(localDate(2026, 2, 16, 0, 0));
    });
  });

  describe('edge cases', () => {
    it('should return undefined for a schedule that cannot match within 4 years', () => {
      // Feb 30 never exists
      const schedule = parseCronExpression('0 0 30 2 *');
      const result = getNextRun(schedule, REF_DATE);
      expect(result).toBeUndefined();
    });

    it('should start searching from the next minute after the given date', () => {
      // If after is exactly on a matching minute, it should NOT return that minute
      const schedule = parseCronExpression('30 10 * * *');
      const exactMatch = localDate(2026, 2, 13, 10, 30);
      const next = getNextRun(schedule, exactMatch);
      // Should not return 10:30 today; should return 10:30 tomorrow
      expect(next).toEqual(localDate(2026, 2, 14, 10, 30));
    });

    it('should ignore seconds on the after date', () => {
      const schedule = parseCronExpression('31 10 * * *');
      const withSeconds = new Date(2026, 1, 13, 10, 30, 45, 0);
      const next = getNextRun(schedule, withSeconds);
      // Next whole minute after 10:30:45 is 10:31, which matches minute=31
      expect(next).toEqual(localDate(2026, 2, 13, 10, 31));
    });

    it('should handle a specific after date in the past', () => {
      const schedule = parseCronExpression('0 12 * * *');
      const pastDate = localDate(2020, 6, 15, 8, 0);
      const next = getNextRun(schedule, pastDate);
      expect(next).toEqual(localDate(2020, 6, 15, 12, 0));
    });

    it('should handle every-5-minutes schedule', () => {
      const schedule = parseCronExpression('*/5 * * * *');
      const next = getNextRun(schedule, REF_DATE);
      // REF_DATE is :30, next matching is :35 in the same hour
      expect(next).toEqual(localDate(2026, 2, 13, 10, 35));
    });

    it('should handle year rollover', () => {
      const schedule = parseCronExpression('0 0 1 1 *');
      const dec31 = localDate(2026, 12, 31, 23, 59);
      const next = getNextRun(schedule, dec31);
      expect(next).toEqual(localDate(2027, 1, 1, 0, 0));
    });

    it('should find the next occurrence of a complex schedule', () => {
      // Every 15 minutes during business hours on weekdays
      const schedule = parseCronExpression('0,15,30,45 9-17 * * 1-5');
      const next = getNextRun(schedule, REF_DATE);
      // REF_DATE is Friday local 10:30
      // Minutes: 0,15,30,45. Next after :30 is :45. Hour 10 is in 9-17. Friday is dow=5.
      expect(next).toEqual(localDate(2026, 2, 13, 10, 45));
    });

    it('should handle the @weekly alias from a mid-week starting point', () => {
      const schedule = parseCronExpression('@weekly');
      const next = getNextRun(schedule, REF_DATE);
      // @weekly is 0 0 * * 0 (Sunday midnight)
      // Next Sunday from Friday Feb 13 is Feb 15
      expect(next).toEqual(localDate(2026, 2, 15, 0, 0));
    });

    it('should handle @monthly alias from mid-month', () => {
      const schedule = parseCronExpression('@monthly');
      const next = getNextRun(schedule, REF_DATE);
      // @monthly is 0 0 1 * *, next 1st is March 1
      expect(next).toEqual(localDate(2026, 3, 1, 0, 0));
    });

    it('should handle @yearly alias finding the next January 1st', () => {
      const schedule = parseCronExpression('@yearly');
      const next = getNextRun(schedule, REF_DATE);
      // @yearly is 0 0 1 1 *, Jan has passed, so next is 2027-01-01
      expect(next).toEqual(localDate(2027, 1, 1, 0, 0));
    });

    it('should handle the default after parameter by using current time', () => {
      const schedule = parseCronExpression('* * * * *');
      const next = getNextRun(schedule);
      // Should return a date in the future (within the next minute)
      expect(next).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(next!.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
