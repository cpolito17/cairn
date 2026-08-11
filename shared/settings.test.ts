import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, coerceSettings, parseStoredSettings } from './settings';

describe('parseStoredSettings', () => {
  it('is the defaults when there is no row', () => {
    expect(parseStoredSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('is the defaults when the stored document is not JSON', () => {
    expect(parseStoredSettings('{ not json')).toEqual(DEFAULT_SETTINGS);
    expect(parseStoredSettings('')).toEqual(DEFAULT_SETTINGS);
  });

  it('is the defaults when the stored document is JSON but not an object', () => {
    expect(parseStoredSettings('null')).toEqual(DEFAULT_SETTINGS);
    expect(parseStoredSettings('[1,2,3]')).toEqual(DEFAULT_SETTINGS);
    expect(parseStoredSettings('"week"')).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a valid document', () => {
    const settings = {
      workdayStartMinutes: 420,
      workdayEndMinutes: 1140,
      plannerView: 'month' as const,
      plannerGroupByBoard: true,
      plannerSort: 'difficulty' as const,
      notificationsEnabled: true,
      timeZone: 'America/Detroit',
      weekdayStartMinutes: 450,
      weekendStartMinutes: 630,
      dueReminderLeadMinutes: 15,
    };
    expect(parseStoredSettings(JSON.stringify(settings))).toEqual(settings);
  });
});

describe('coerceSettings', () => {
  it('defaults only the fields that do not fit', () => {
    expect(
      coerceSettings({
        workdayStartMinutes: 480,
        workdayEndMinutes: 960,
        plannerView: 'fortnight',
        plannerGroupByBoard: 'yes',
        plannerSort: 'duration',
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      workdayStartMinutes: 480,
      workdayEndMinutes: 960,
      plannerSort: 'duration',
    });
  });

  it('fills in a field an older document never had', () => {
    expect(coerceSettings({ workdayStartMinutes: 480, workdayEndMinutes: 960 })).toEqual({
      ...DEFAULT_SETTINGS,
      workdayStartMinutes: 480,
      workdayEndMinutes: 960,
    });
  });

  it('falls back on both workday bounds together when they disagree', () => {
    // A stored start with a defaulted end could otherwise produce a workday
    // that ends before it begins — the one state the write path refuses.
    expect(coerceSettings({ workdayStartMinutes: 1080 })).toMatchObject({
      workdayStartMinutes: DEFAULT_SETTINGS.workdayStartMinutes,
      workdayEndMinutes: DEFAULT_SETTINGS.workdayEndMinutes,
    });
    expect(coerceSettings({ workdayStartMinutes: 600, workdayEndMinutes: 600 })).toMatchObject({
      workdayStartMinutes: DEFAULT_SETTINGS.workdayStartMinutes,
      workdayEndMinutes: DEFAULT_SETTINGS.workdayEndMinutes,
    });
  });

  it('refuses a non-integer or out-of-range minute offset', () => {
    expect(coerceSettings({ workdayStartMinutes: 9.5, workdayEndMinutes: 1020 })).toMatchObject({
      workdayStartMinutes: DEFAULT_SETTINGS.workdayStartMinutes,
    });
    expect(coerceSettings({ workdayStartMinutes: -60, workdayEndMinutes: 1020 })).toMatchObject({
      workdayStartMinutes: DEFAULT_SETTINGS.workdayStartMinutes,
    });
    expect(coerceSettings({ workdayStartMinutes: 540, workdayEndMinutes: 2000 })).toMatchObject({
      workdayEndMinutes: DEFAULT_SETTINGS.workdayEndMinutes,
    });
  });

  it('ignores fields it does not know about', () => {
    expect(coerceSettings({ ...DEFAULT_SETTINGS, theme: 'dusk' })).toEqual(DEFAULT_SETTINGS);
  });

  it('leaves notifications off when the flag is unreadable', () => {
    // Not merely "falls back to the default" — the default happens to be false,
    // and this is asserting the stronger rule: nothing but a literal `true`
    // turns notifications on, so a corrupt document can never start pushing.
    expect(coerceSettings({ notificationsEnabled: 'yes' }).notificationsEnabled).toBe(false);
    expect(coerceSettings({ notificationsEnabled: 1 }).notificationsEnabled).toBe(false);
    expect(coerceSettings({ notificationsEnabled: true }).notificationsEnabled).toBe(true);
  });

  it('refuses a time zone the runtime does not know', () => {
    expect(coerceSettings({ timeZone: 'Mars/Olympus_Mons' }).timeZone).toBe(
      DEFAULT_SETTINGS.timeZone,
    );
    expect(coerceSettings({ timeZone: 'America/Detroit' }).timeZone).toBe('America/Detroit');
  });

  it('refuses a start-of-day at 1440, which no clock ever reads', () => {
    expect(coerceSettings({ weekdayStartMinutes: 1440 }).weekdayStartMinutes).toBe(
      DEFAULT_SETTINGS.weekdayStartMinutes,
    );
    expect(coerceSettings({ weekendStartMinutes: 1439 }).weekendStartMinutes).toBe(1439);
  });

  it('keeps null as a reminder lead, which means no per-task reminders', () => {
    expect(coerceSettings({ dueReminderLeadMinutes: null }).dueReminderLeadMinutes).toBeNull();
    expect(coerceSettings({ dueReminderLeadMinutes: 7 }).dueReminderLeadMinutes).toBe(
      DEFAULT_SETTINGS.dueReminderLeadMinutes,
    );
  });
});
