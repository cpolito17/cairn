/**
 * The demo seed's invariants.
 *
 * Two things are being defended here. The first is *legality*: the seed writes
 * rows the Worker would have refused if they had arrived over the wire — an
 * unsnapped block, a duration off the 15-minute grid, a `dueTime` with no date,
 * a prerequisite on another board — and none of that is caught by the demo
 * backend, which trusts its own constant. So the constant gets checked.
 *
 * The second is that it stays *interesting on any day*. The whole point of
 * building the world from the clock is that a visitor a year from now sees the
 * same tour: something scheduled today, something overdue, a released gate and
 * a closed one. Those are asserted against a spread of days — a Sunday, a
 * midweek day, a Saturday, and both sides of a DST transition — because a seed
 * that only reads well on a Tuesday is a seed that is broken six days a week.
 */

import { describe, expect, it } from 'vitest';
import { blockedBy, canDependOn, lookupOf } from '../../../shared/dependencies';
import { eventOccurrences } from '../../../shared/events';
import {
  blockEnd,
  endOfLocalDay,
  isSnapped,
  startOfLocalDay,
} from '../../../shared/schedule';
import { isValidDurationMinutes, type AppState } from '../../../shared/types';
import { buildDemoState } from './seed';

/** A Sunday, a Wednesday, a Saturday, and the two US DST switch days. */
const DAYS = [
  new Date(2026, 1, 8, 9, 20).getTime(), // Sunday
  new Date(2026, 1, 11, 14, 5).getTime(), // Wednesday
  new Date(2026, 1, 14, 23, 45).getTime(), // Saturday, late
  new Date(2026, 2, 8, 12, 0).getTime(), // spring forward
  new Date(2026, 10, 1, 12, 0).getTime(), // fall back
];

function forEachDay(check: (state: AppState, now: number) => void): void {
  for (const now of DAYS) check(buildDemoState(now), now);
}

describe('the demo world', () => {
  it('has six live boards across both contexts, and an archived one in each', () => {
    forEachDay((state) => {
      const active = state.boards.filter((board) => board.archivedAt === null);
      expect(active.length).toBe(6);
      expect(active.some((board) => board.context === 'personal')).toBe(true);
      expect(active.some((board) => board.context === 'work')).toBe(true);
      // One archived board per context, so the archived screen is never empty
      // whichever side of the app the visitor is standing on.
      const archived = state.boards.filter((board) => board.archivedAt !== null);
      expect(archived.length).toBe(2);
      expect(new Set(archived.map((board) => board.context)).size).toBe(2);
    });
  });

  it('gives every board a distinct id and position', () => {
    forEachDay((state) => {
      expect(new Set(state.boards.map((board) => board.id)).size).toBe(state.boards.length);
      const byContext = new Map<string, string[]>();
      for (const board of state.boards) {
        byContext.set(board.context, [...(byContext.get(board.context) ?? []), board.position]);
      }
      for (const positions of byContext.values()) {
        expect(new Set(positions).size).toBe(positions.length);
      }
    });
  });

  it('writes only rows the Worker would accept', () => {
    forEachDay((state) => {
      const boards = new Set(state.boards.map((board) => board.id));
      const lookup = lookupOf(state.tasks);

      for (const task of state.tasks) {
        expect(boards.has(task.boardId)).toBe(true);
        expect(task.name.length).toBeGreaterThan(0);

        if (task.dueDate !== null) expect(task.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // A time with no date is a moment nothing can order.
        if (task.dueTime !== null) expect(task.dueDate).not.toBeNull();

        if (task.durationMinutes !== null) {
          expect(isValidDurationMinutes(task.durationMinutes)).toBe(true);
        }

        if (task.scheduledAt !== null) {
          expect(isSnapped(task.scheduledAt)).toBe(true);
          // A block may not cross local midnight (V2 §3.1).
          expect(blockEnd(task)).toBeLessThanOrEqual(endOfLocalDay(task.scheduledAt));
        }

        // Every link, checked the way the Worker checks a set: one at a time
        // against the links accepted before it, so a seed whose prerequisites
        // are individually fine but collectively a cycle would fail here.
        const others = state.tasks.filter((other) => other.id !== task.id);
        let working = { ...task, dependsOn: [] as string[] };
        for (const id of task.dependsOn) {
          const prerequisite = lookup.get(id);
          expect(prerequisite).toBeDefined();
          expect(prerequisite?.boardId).toBe(task.boardId);
          expect(canDependOn(working, prerequisite!, lookupOf([...others, working]))).toBe(true);
          working = { ...working, dependsOn: [...working.dependsOn, id] };
        }
      }
    });
  });

  it('shows every task state the app can render, whatever day it is opened', () => {
    forEachDay((state, now) => {
      const today = startOfLocalDay(now);
      const tomorrow = endOfLocalDay(now);
      const lookup = lookupOf(state.tasks);
      const live = state.tasks.filter((task) => {
        const board = state.boards.find((candidate) => candidate.id === task.boardId);
        return board?.archivedAt === null;
      });

      // Something on the grid today, so the now line has company.
      expect(
        live.some(
          (task) =>
            task.scheduledAt !== null && task.scheduledAt >= today && task.scheduledAt < tomorrow,
        ),
      ).toBe(true);

      // Overdue, for Up Next's first tier and the negative due chip.
      expect(live.some((task) => task.completedAt === null && task.dueDate !== null && task.dueDate < isoDay(today))).toBe(true);

      // Completed work — the record the released gates hang off.
      expect(live.some((task) => task.completedAt !== null)).toBe(true);

      // A gate that is closed, and one that has been opened by a completion.
      const gated = live.filter((task) => blockedBy(task, lookup).length > 0);
      const released = live.filter(
        (task) =>
          task.completedAt === null &&
          task.dependsOn.length > 0 &&
          task.dependsOn.every((id) => lookup.get(id)?.completedAt != null),
      );
      expect(gated.length).toBeGreaterThan(3);
      expect(released.length).toBeGreaterThan(1);

      // A prerequisite with more than one dependent — the fan-*out* the
      // Blockers graph exists to draw.
      const dependents = new Map<string, number>();
      for (const task of live) {
        for (const id of task.dependsOn) {
          dependents.set(id, (dependents.get(id) ?? 0) + 1);
        }
      }
      expect([...dependents.values()].some((count) => count > 1)).toBe(true);

      // ...and a task waiting on more than one thing — the fan-*in*, which is
      // what the §14 addendum added and what the demo has to show off.
      expect(live.some((task) => task.dependsOn.length > 1)).toBe(true);

      // The hand-asserted blocked flag, a scheduled block with no committed
      // duration (the dotted outline), and a completed block still on the grid.
      expect(live.some((task) => task.blocked)).toBe(true);
      expect(
        live.some((task) => task.scheduledAt !== null && task.durationMinutes === null),
      ).toBe(true);
      expect(
        live.some((task) => task.scheduledAt !== null && task.completedAt !== null),
      ).toBe(true);

      // A duration off the preset list, so the composer's Custom chip is lit.
      expect(
        live.some(
          (task) =>
            task.durationMinutes !== null && ![15, 30, 60, 120, 240].includes(task.durationMinutes),
        ),
      ).toBe(true);
    });
  });

  it('puts every recurring series on the visible week, fortnightly included', () => {
    forEachDay((state, now) => {
      const today = startOfLocalDay(now);
      const week = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(today);
        date.setDate(date.getDate() - date.getDay() + index);
        date.setHours(0, 0, 0, 0);
        return date.getTime();
      });

      const occurrences = eventOccurrences(state.events, week);
      for (const event of state.events) {
        expect(occurrences.some((occurrence) => occurrence.event.id === event.id)).toBe(true);
      }
      // Every occurrence lands inside its own day.
      for (const { event, startMs } of occurrences) {
        expect(startMs + event.durationMinutes * 60_000).toBeLessThanOrEqual(endOfLocalDay(startMs));
      }
    });
  });
});

/** `YYYY-MM-DD` for a local day start — the format `dueDate` is compared in. */
function isoDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
