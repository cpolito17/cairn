import { describe, expect, it } from 'vitest';
import {
  DIGEST_CATCH_UP_MINUTES,
  DIGEST_MAX_LINES,
  REMINDER_CATCH_UP_MINUTES,
  nextDigestAt,
  planDigest,
  planDueReminders,
  planNotifications,
} from './notifications';
import { DEFAULT_SETTINGS } from './settings';
import { zonedTimeToEpoch } from './timezone';
import type { Board, Settings, Task } from './types';

const TZ = 'America/Detroit';

/** The instant a Detroit clock reads `2026-08-11 08:00`. */
function at(date: string, time: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return zonedTimeToEpoch(TZ, y, m, d, hh, mm);
}

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  notificationsEnabled: true,
  timeZone: TZ,
  weekdayStartMinutes: 480, // 8:00 AM
  weekendStartMinutes: 600, // 10:00 AM
  dueReminderLeadMinutes: 5,
  ...overrides,
});

let seq = 0;

function board(overrides: Partial<Board> = {}): Board {
  seq += 1;
  return {
    id: `b${seq}`,
    context: 'personal',
    name: `Board ${seq}`,
    description: null,
    accent: null,
    position: `a${seq}`,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    boardId: 'b1',
    name: `Task ${seq}`,
    notes: null,
    dueDate: null,
    dueTime: null,
    durationMinutes: null,
    scheduledAt: null,
    difficulty: null,
    priority: false,
    blocked: false,
    dependsOn: [],
    position: `a${seq}`,
    createdAt: 0,
    completedAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

/** 2026-08-11 is a Tuesday; 2026-08-15 is a Saturday. */
const TUESDAY = '2026-08-11';
const SATURDAY = '2026-08-15';

function input(overrides: Partial<Parameters<typeof planNotifications>[0]> = {}) {
  return {
    now: at(TUESDAY, '08:00'),
    settings: settings(),
    boards: [board({ id: 'b1', name: 'Roof' })],
    tasks: [] as Task[],
    sentKeys: new Set<string>(),
    ...overrides,
  };
}

describe('planNotifications', () => {
  it('sends nothing at all while the master switch is off', () => {
    const plan = planNotifications(
      input({
        settings: settings({ notificationsEnabled: false }),
        tasks: [task({ dueDate: TUESDAY, dueTime: '08:05' })],
      }),
    );
    expect(plan).toEqual([]);
  });

  it('can produce a digest and a due reminder on the same tick', () => {
    const plan = planNotifications(
      input({
        // 8:00 AM is the digest time, and a task due 8:05 is five minutes out.
        tasks: [task({ id: 't1', dueDate: TUESDAY, dueTime: '08:05' })],
      }),
    );
    expect(plan.map((message) => message.kind)).toEqual(['digest', 'due']);
  });
});

describe('planDigest', () => {
  it('fires at the weekday time on a weekday', () => {
    const tasks = [task({ dueDate: TUESDAY })];
    expect(planDigest(input({ now: at(TUESDAY, '07:59'), tasks }))).toBeNull();
    expect(planDigest(input({ now: at(TUESDAY, '08:00'), tasks }))).not.toBeNull();
  });

  it('fires at the weekend time on a Saturday', () => {
    const tasks = [task({ dueDate: SATURDAY })];
    // The weekday time has no effect on a Saturday, and vice versa.
    expect(planDigest(input({ now: at(SATURDAY, '08:00'), tasks }))).toBeNull();
    expect(planDigest(input({ now: at(SATURDAY, '10:00'), tasks }))).not.toBeNull();
  });

  it('still sends after a missed tick, but not hours later', () => {
    const tasks = [task({ dueDate: TUESDAY })];
    const late = (minutes: number) =>
      planDigest(input({ now: at(TUESDAY, '08:00') + minutes * 60_000, tasks }));
    expect(late(DIGEST_CATCH_UP_MINUTES)).not.toBeNull();
    // Turning notifications on in the afternoon must not fire the morning's
    // digest at the user retroactively.
    expect(late(DIGEST_CATCH_UP_MINUTES + 1)).toBeNull();
  });

  it('sends once a day, however many ticks fall in the window', () => {
    const tasks = [task({ dueDate: TUESDAY })];
    const first = planDigest(input({ now: at(TUESDAY, '08:00'), tasks }))!;
    expect(first.key).toBe(`digest:${TUESDAY}`);
    const second = planDigest(
      input({ now: at(TUESDAY, '08:01'), tasks, sentKeys: new Set([first.key]) }),
    );
    expect(second).toBeNull();
  });

  it('says nothing when there is nothing to say', () => {
    // No due-today, no overdue: not an empty digest, no digest.
    expect(planDigest(input({ tasks: [task({ dueDate: '2026-08-12' })] }))).toBeNull();
    expect(planDigest(input({ tasks: [task()] }))).toBeNull();
  });

  it('counts due-today and overdue separately in the title', () => {
    const digest = planDigest(
      input({
        tasks: [
          task({ dueDate: TUESDAY }),
          task({ dueDate: TUESDAY }),
          task({ dueDate: '2026-08-09' }),
        ],
      }),
    )!;
    expect(digest.title).toBe('2 due today · 1 overdue');
  });

  it('leads with the most overdue task, then today by due time', () => {
    const digest = planDigest(
      input({
        tasks: [
          task({ name: 'Untimed', dueDate: TUESDAY }),
          task({ name: 'Noon', dueDate: TUESDAY, dueTime: '12:00' }),
          task({ name: 'Yesterday', dueDate: '2026-08-10' }),
          task({ name: 'Last week', dueDate: '2026-08-04' }),
        ],
      }),
    )!;
    expect(digest.body.split('\n').map((line) => line.split(' — ')[0])).toEqual([
      'Last week',
      'Yesterday',
      'Noon',
      'Untimed',
    ]);
  });

  it('names the board and how overdue each line is', () => {
    const digest = planDigest(
      input({
        boards: [board({ id: 'b1', name: 'Roof' })],
        tasks: [
          task({ name: 'Call the roofer', dueDate: '2026-08-09' }),
          task({ name: 'Pay deposit', dueDate: TUESDAY, dueTime: '13:30' }),
        ],
      }),
    )!;
    expect(digest.body).toBe(
      'Call the roofer — Roof · 2 days overdue\nPay deposit — Roof · 1:30 PM',
    );
  });

  it('collapses a long day into a +N more line', () => {
    const tasks = Array.from({ length: DIGEST_MAX_LINES + 3 }, (_, index) =>
      task({ id: `t${index}`, name: `Task ${index}`, dueDate: TUESDAY }),
    );
    const lines = planDigest(input({ tasks }))!.body.split('\n');
    expect(lines).toHaveLength(DIGEST_MAX_LINES + 1);
    expect(lines.at(-1)).toBe('+3 more');
  });

  it('carries notes only when the whole day is one task', () => {
    const one = planDigest(
      input({ tasks: [task({ dueDate: TUESDAY, notes: 'Bring the survey' })] }),
    )!;
    expect(one.body).toContain('Bring the survey');

    const two = planDigest(
      input({
        tasks: [task({ dueDate: TUESDAY, notes: 'Bring the survey' }), task({ dueDate: TUESDAY })],
      }),
    )!;
    expect(two.body).not.toContain('Bring the survey');
  });

  it('ignores completed tasks and archived boards', () => {
    expect(
      planDigest(
        input({
          boards: [board({ id: 'b1' }), board({ id: 'b2', archivedAt: 1 })],
          tasks: [
            task({ boardId: 'b1', dueDate: TUESDAY, completedAt: 5 }),
            task({ boardId: 'b2', dueDate: TUESDAY }),
            task({ boardId: 'b3', dueDate: TUESDAY }), // board deleted
          ],
        }),
      ),
    ).toBeNull();
  });

  it('spans both contexts', () => {
    const digest = planDigest(
      input({
        boards: [
          board({ id: 'b1', context: 'personal', name: 'Dentist' }),
          board({ id: 'b2', context: 'work', name: 'Q3 review' }),
        ],
        tasks: [
          task({ boardId: 'b1', dueDate: TUESDAY }),
          task({ boardId: 'b2', dueDate: TUESDAY }),
        ],
      }),
    )!;
    expect(digest.body).toContain('Dentist');
    expect(digest.body).toContain('Q3 review');
  });

  it('opens the app root when tapped', () => {
    expect(planDigest(input({ tasks: [task({ dueDate: TUESDAY })] }))!.url).toBe('/');
  });
});

describe('planDueReminders', () => {
  const soon = () => task({ id: 't1', name: 'Call Sam', dueDate: TUESDAY, dueTime: '13:30' });

  it('fires the configured lead ahead of the due time', () => {
    const tasks = [soon()];
    expect(planDueReminders(input({ now: at(TUESDAY, '13:24'), tasks }))).toEqual([]);
    expect(planDueReminders(input({ now: at(TUESDAY, '13:25'), tasks }))).toHaveLength(1);
  });

  it('honours a lead of zero as "at the due time"', () => {
    const tasks = [soon()];
    const zero = { settings: settings({ dueReminderLeadMinutes: 0 }), tasks };
    expect(planDueReminders(input({ now: at(TUESDAY, '13:25'), ...zero }))).toEqual([]);
    expect(planDueReminders(input({ now: at(TUESDAY, '13:30'), ...zero }))).toHaveLength(1);
  });

  it('is off entirely when the lead is null', () => {
    expect(
      planDueReminders(
        input({
          now: at(TUESDAY, '13:25'),
          settings: settings({ dueReminderLeadMinutes: null }),
          tasks: [soon()],
        }),
      ),
    ).toEqual([]);
  });

  it('gives up rather than arriving long after the fact', () => {
    const tasks = [soon()];
    const late = (minutes: number) =>
      planDueReminders(input({ now: at(TUESDAY, '13:25') + minutes * 60_000, tasks }));
    expect(late(REMINDER_CATCH_UP_MINUTES)).toHaveLength(1);
    expect(late(REMINDER_CATCH_UP_MINUTES + 1)).toEqual([]);
  });

  it('skips a task with a date but no time', () => {
    expect(
      planDueReminders(input({ now: at(TUESDAY, '23:54'), tasks: [task({ dueDate: TUESDAY })] })),
    ).toEqual([]);
  });

  it('sends once per due moment, whatever the lead becomes afterwards', () => {
    const tasks = [soon()];
    const first = planDueReminders(input({ now: at(TUESDAY, '13:25'), tasks }))[0];
    expect(first.key).toBe(`due:t1:${TUESDAY}T13:30`);

    // Same reminder, a longer lead, already delivered: it must not fire again.
    expect(
      planDueReminders(
        input({
          now: at(TUESDAY, '13:25'),
          settings: settings({ dueReminderLeadMinutes: 10 }),
          tasks,
          sentKeys: new Set([first.key]),
        }),
      ),
    ).toEqual([]);
  });

  it('carries the task, board, due time and notes', () => {
    const [message] = planDueReminders(
      input({
        now: at(TUESDAY, '13:25'),
        boards: [board({ id: 'b1', name: 'Roof' })],
        tasks: [task({ ...soon(), notes: 'Ask about the flashing detail' })],
      }),
    );
    expect(message.title).toBe('Call Sam');
    expect(message.body).toBe('Roof · Due 1:30 PM\nAsk about the flashing detail');
    expect(message.url).toBe('/board/b1?task=t1');
  });

  it('flattens and truncates long notes', () => {
    const [message] = planDueReminders(
      input({
        now: at(TUESDAY, '13:25'),
        tasks: [task({ ...soon(), notes: `line one\nline two ${'x'.repeat(200)}` })],
      }),
    );
    const notes = message.body.split('\n')[1];
    expect(notes).not.toContain('\n');
    expect(notes.length).toBeLessThanOrEqual(140);
    expect(notes.endsWith('…')).toBe(true);
  });

  it('ignores completed tasks and archived boards', () => {
    expect(
      planDueReminders(
        input({
          now: at(TUESDAY, '13:25'),
          boards: [board({ id: 'b2', archivedAt: 1 })],
          tasks: [
            task({ ...soon(), completedAt: 5 }),
            task({ ...soon(), id: 't2', boardId: 'b2' }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('gives each task its own replace-tag so two never collapse into one', () => {
    const messages = planDueReminders(
      input({
        now: at(TUESDAY, '13:25'),
        tasks: [soon(), task({ ...soon(), id: 't2', name: 'Call Alex' })],
      }),
    );
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((message) => message.tag)).size).toBe(2);
  });
});

describe('nextDigestAt', () => {
  it('is later today when the start-of-day has not passed', () => {
    expect(nextDigestAt(at(TUESDAY, '06:00'), settings())).toBe(at(TUESDAY, '08:00'));
  });

  it('is tomorrow once today has passed', () => {
    expect(nextDigestAt(at(TUESDAY, '09:00'), settings())).toBe(at('2026-08-12', '08:00'));
  });

  it('uses the weekend time when tomorrow is a weekend', () => {
    // Friday evening → Saturday at the weekend time, not the weekday one.
    expect(nextDigestAt(at('2026-08-14', '20:00'), settings())).toBe(at(SATURDAY, '10:00'));
  });
});
