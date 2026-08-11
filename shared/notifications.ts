/**
 * What to notify, and when. Pure, injectable, and the only place either
 * question is answered.
 *
 * The scheduled job in `worker/notify.ts` is a thin shell around this module:
 * it reads the database, calls `planNotifications` with the current instant,
 * and pushes whatever comes back. Nothing about *whether* a notification is due
 * lives in the Worker, because a rule that only runs on a cron is a rule nobody
 * can test — and this one has to be right at 8:00 AM on the Sunday the clocks
 * change, which is not a thing to find out in production.
 *
 * **Two kinds of notification, and they answer different questions.**
 *
 * - The **digest** answers "what does today look like": one push at the
 *   start-of-day time, listing what is due today and what is already overdue.
 *   Weekdays and weekends have their own times, because a Saturday that starts
 *   at 8:00 AM is a Saturday nobody asked for.
 * - A **due reminder** answers "this is about to happen": one push per task
 *   that has a due *time*, fired a configurable lead ahead of it. A task due
 *   "sometime Tuesday" has no moment to count back from and is the digest's
 *   business, not this one's.
 *
 * **Both kinds span contexts.** Personal and Work stay separate everywhere they
 * are looked at (§6.2), but the phone in your pocket is not a context — a
 * morning where the digest hid the dentist because you were "in Work" would be
 * a morning the feature actively lied about.
 *
 * **Idempotency is by key, not by timing.** Every message carries a `key` that
 * names the thing it is about — `digest:2026-08-11`, `due:<id>:2026-08-11T13:30`
 * — and the caller passes in the keys it has already sent. A cron that fires
 * twice, a Worker that is redeployed mid-minute, or a catch-up after an outage
 * therefore cannot produce a second copy. Windows exist to stop *stale*
 * notifications, not duplicate ones; the key does duplicates.
 */

import {
  dueAtInZone,
  daysBetweenKeys,
  formatWireTime,
  isWeekday,
  zonedDayKey,
  zonedMinutes,
  zonedTimeToEpoch,
} from './timezone';
import type { Board, Settings, Task } from './types';

const MINUTE_MS = 60_000;

/**
 * How late a digest may still be sent, in minutes past its start-of-day time.
 *
 * A cron can miss a tick — a deploy, a cold start, a Cloudflare hiccup — and a
 * digest that vanished because the 8:00 tick was skipped is worse than one that
 * arrives at 8:04. An hour is generous enough to survive that and short enough
 * that turning notifications on at 3:00 PM does not immediately fire a morning
 * digest about a morning that is over.
 */
export const DIGEST_CATCH_UP_MINUTES = 60;

/**
 * The same idea for a due reminder, and deliberately tighter. "This is about to
 * happen" stops being true fairly quickly, and a reminder for a 1:30 meeting
 * that lands at 2:15 is not a reminder, it is an accusation.
 */
export const REMINDER_CATCH_UP_MINUTES = 15;

/** Tasks listed in the digest body before it collapses into "+N more". */
export const DIGEST_MAX_LINES = 6;

/** Longest run of notes carried into a notification body. */
export const MAX_NOTES_CHARS = 140;

/** One push, ready to encrypt and send. */
export interface PushMessage {
  kind: 'digest' | 'due';
  /** Stable identity for "this exact notification", for the sent-key ledger. */
  key: string;
  title: string;
  body: string;
  /** Where a tap goes, as an app-relative path. */
  url: string;
  /**
   * The notification's replace-group. Two pushes with the same tag collapse
   * into one on the device rather than stacking — which is what keeps a
   * re-sent digest from sitting twice in the shade.
   */
  tag: string;
}

export interface PlanInput {
  /** The instant the tick is running at. */
  now: number;
  settings: Settings;
  boards: readonly Board[];
  tasks: readonly Task[];
  /** Keys already sent, so nothing is sent twice. */
  sentKeys: ReadonlySet<string>;
}

/**
 * Everything due to be pushed at `now`. Empty is the overwhelmingly common
 * answer and is not a failure.
 */
export function planNotifications(input: PlanInput): PushMessage[] {
  // The master switch is checked once, here, rather than at each call site.
  // Off means off — including for a device whose subscription is still live.
  if (!input.settings.notificationsEnabled) return [];

  const digest = planDigest(input);
  return [...(digest ? [digest] : []), ...planDueReminders(input)];
}

/* --- the morning digest ---------------------------------------------------- */

/** The start-of-day time that applies to the day `now` falls in. */
export function startOfDayMinutes(now: number, settings: Settings): number {
  return isWeekday(now, settings.timeZone)
    ? settings.weekdayStartMinutes
    : settings.weekendStartMinutes;
}

export function planDigest(input: PlanInput): PushMessage | null {
  const { now, settings, sentKeys } = input;
  const { timeZone } = settings;

  const target = startOfDayMinutes(now, settings);
  const elapsed = zonedMinutes(now, timeZone) - target;
  if (elapsed < 0 || elapsed > DIGEST_CATCH_UP_MINUTES) return null;

  const today = zonedDayKey(now, timeZone);
  const key = `digest:${today}`;
  if (sentKeys.has(key)) return null;

  const { dueToday, overdue } = digestTasks(input);
  // A digest with nothing in it is not sent at all. §6.7's empty state is a
  // quiet line on a screen the user chose to open; a push notification is an
  // interruption, and "nothing today" does not earn one.
  if (dueToday.length === 0 && overdue.length === 0) return null;

  return {
    kind: 'digest',
    key,
    title: digestTitle(dueToday.length, overdue.length),
    body: digestBody(dueToday, overdue, input.boards, today),
    url: '/',
    // One tag for all digests: yesterday's, if it somehow survived unread, is
    // replaced by today's rather than sitting above it.
    tag: 'cairn-digest',
  };
}

/** The two groups the digest is about, each in the order it will be listed. */
export function digestTasks(input: Pick<PlanInput, 'now' | 'settings' | 'boards' | 'tasks'>): {
  dueToday: Task[];
  overdue: Task[];
} {
  const today = zonedDayKey(input.now, input.settings.timeZone);
  const live = liveTasks(input.boards, input.tasks);

  const dueToday: Task[] = [];
  const overdue: Task[] = [];
  for (const task of live) {
    if (task.dueDate === null) continue;
    if (task.dueDate === today) dueToday.push(task);
    else if (task.dueDate < today) overdue.push(task);
  }

  // Most overdue first — the thing that has been waiting longest is the thing
  // the morning should lead with. Ties break by id so the order is total and
  // two runs of the same data produce the same notification.
  overdue.sort((a, b) => compareKeys(a.dueDate!, b.dueDate!) || compareIds(a, b));
  // Due today sorts by the hour it is due at, untimed last: a 9:00 AM call
  // outranks something merely due "today", which is the same convention Up Next
  // already uses (§7.2).
  dueToday.sort((a, b) => compareTimes(a.dueTime, b.dueTime) || compareIds(a, b));

  return { dueToday, overdue };
}

function digestTitle(dueCount: number, overdueCount: number): string {
  const parts: string[] = [];
  if (dueCount > 0) parts.push(`${dueCount} due today`);
  if (overdueCount > 0) parts.push(`${overdueCount} overdue`);
  return parts.join(' · ');
}

function digestBody(
  dueToday: readonly Task[],
  overdue: readonly Task[],
  boards: readonly Board[],
  today: string,
): string {
  const names = boardNames(boards);
  // Overdue leads. It outranks everything in Up Next (V2 §8) for the same
  // reason it does here: it is the only category that is already a problem.
  const ordered = [...overdue, ...dueToday];
  const shown = ordered.slice(0, DIGEST_MAX_LINES);

  const lines = shown.map((task) => {
    const board = names.get(task.boardId);
    const when =
      task.dueDate === today
        ? task.dueTime === null
          ? 'today'
          : formatWireTime(task.dueTime)
        : overdueBy(task.dueDate!, today);
    return `${task.name} — ${board ?? 'Board'} · ${when}`;
  });

  const hidden = ordered.length - shown.length;
  if (hidden > 0) lines.push(`+${hidden} more`);

  // Notes only when the digest is about a single task. Six tasks' worth of
  // notes is not a notification, it is a document, and iOS truncates it into
  // uselessness anyway. The per-task reminder is where notes really belong.
  if (ordered.length === 1 && ordered[0].notes) {
    lines.push(truncate(ordered[0].notes, MAX_NOTES_CHARS));
  }

  return lines.join('\n');
}

/** `2 days overdue`, for a due date already in the past. */
function overdueBy(dueDate: string, today: string): string {
  const days = daysBetweenKeys(dueDate, today);
  if (days <= 0) return 'overdue';
  return days === 1 ? '1 day overdue' : `${days} days overdue`;
}

/* --- per-task due reminders ------------------------------------------------ */

export function planDueReminders(input: PlanInput): PushMessage[] {
  const { now, settings, boards, tasks, sentKeys } = input;
  const lead = settings.dueReminderLeadMinutes;
  if (lead === null) return [];

  const names = boardNames(boards);
  const messages: PushMessage[] = [];

  for (const task of liveTasks(boards, tasks)) {
    // Both halves are required. A date without a time is a day, not a moment,
    // and counting a lead back from a day is a made-up answer.
    if (task.dueDate === null || task.dueTime === null) continue;

    const dueAt = dueAtInZone(task.dueDate, task.dueTime, settings.timeZone);
    const fireAt = dueAt - lead * MINUTE_MS;
    const late = now - fireAt;
    if (late < 0 || late > REMINDER_CATCH_UP_MINUTES * MINUTE_MS) continue;

    // The key names the due moment, not the lead: changing the lead from 5 to
    // 10 must not re-fire a reminder that has already been delivered.
    const key = `due:${task.id}:${task.dueDate}T${task.dueTime}`;
    if (sentKeys.has(key)) continue;

    messages.push({
      kind: 'due',
      key,
      title: task.name,
      body: reminderBody(task, names.get(task.boardId)),
      // The board, with the task named so it can be highlighted on arrival —
      // the same landing Up Next gives a tapped entry (§6.7).
      url: `/board/${encodeURIComponent(task.boardId)}?task=${encodeURIComponent(task.id)}`,
      // Per task: two different reminders must never collapse into each other,
      // and a re-sent one must never stack on itself.
      tag: `cairn-task-${task.id}`,
    });
  }

  // Stable across runs, so a tick that sends four reminders sends them in the
  // same order every time.
  messages.sort((a, b) => compareKeys(a.key, b.key));
  return messages;
}

function reminderBody(task: Task, boardName: string | undefined): string {
  const lines = [`${boardName ?? 'Board'} · Due ${formatWireTime(task.dueTime!)}`];
  if (task.notes) lines.push(truncate(task.notes, MAX_NOTES_CHARS));
  return lines.join('\n');
}

/* --- shared helpers -------------------------------------------------------- */

/**
 * Incomplete tasks on boards that still exist and are not archived.
 *
 * Archived is the interesting exclusion: archiving a board is how the user says
 * "not now" about a whole project (§6.3), and a notification about a task on
 * one would be the app arguing with that. Hand-blocked and dependency-gated
 * tasks are *not* excluded, unlike Up Next — Up Next answers "what can I do
 * next", where a task you cannot start is noise, while an overdue deadline is
 * still overdue whether or not something is in its way.
 */
function liveTasks(boards: readonly Board[], tasks: readonly Task[]): Task[] {
  const active = new Set(
    boards.filter((board) => board.archivedAt === null).map((board) => board.id),
  );
  return tasks.filter((task) => task.completedAt === null && active.has(task.boardId));
}

function boardNames(boards: readonly Board[]): Map<string, string> {
  return new Map(boards.map((board) => [board.id, board.name]));
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIds(a: Task, b: Task): number {
  return compareKeys(a.id, b.id);
}

/** Untimed sorts last within a day — "sometime today" is after every hour. */
function compareTimes(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareKeys(a, b);
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The instant a digest will next be sent, for the settings sheet to show back.
 *
 * Reads the same two fields the plan does, so the sheet cannot drift from the
 * behaviour: if this says tomorrow at 8:00, the cron agrees.
 */
export function nextDigestAt(now: number, settings: Settings): number {
  const { timeZone } = settings;
  for (let offset = 0; offset <= 7; offset += 1) {
    const probe = now + offset * 1440 * MINUTE_MS;
    const day = zonedDayKey(probe, timeZone);
    const [year, month, date] = day.split('-').map(Number);
    const target = startOfDayMinutes(probe, settings);
    const at = zonedTimeToEpoch(
      timeZone,
      year,
      month,
      date,
      Math.floor(target / 60),
      target % 60,
    );
    if (at > now) return at;
  }
  // Unreachable: some day in the next week has a start-of-day after now.
  return now;
}
