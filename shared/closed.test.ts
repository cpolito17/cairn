import { describe, expect, it } from 'vitest';
import { boardFacets, closedRows, closedSummary, filterClosed, sortClosed } from './closed';
import type { Board, Task } from './types';

const DAY = 86_400_000;
/** A fixed "now" so an elapsed figure reads the same in a test as at midnight. */
const NOW = new Date(2026, 7, 10, 12, 0, 0, 0).getTime();

function board(overrides: Partial<Board> = {}): Board {
  return {
    id: 'b1',
    context: 'personal',
    name: 'Board one',
    description: null,
    accent: null,
    position: 'a0',
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

let seq = 0;

function task(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    boardId: 'b1',
    name: `task ${seq}`,
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
    createdAt: NOW - 10 * DAY,
    completedAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

const names = (rows: { task: Task }[]) => rows.map((row) => row.task.name);

describe('closedRows', () => {
  it('keeps only completed tasks, most recently closed first', () => {
    const boards = [board()];
    const tasks = [
      task({ id: 'old', name: 'old', completedAt: NOW - 3 * DAY }),
      task({ id: 'open', name: 'open' }),
      task({ id: 'new', name: 'new', completedAt: NOW - DAY }),
    ];

    expect(names(closedRows(boards, tasks, 'personal'))).toEqual(['new', 'old']);
  });

  it('reads the context from the board, not the task', () => {
    const boards = [board(), board({ id: 'b2', context: 'work', name: 'Work board' })];
    const tasks = [
      task({ name: 'personal one', completedAt: NOW }),
      task({ name: 'work one', boardId: 'b2', completedAt: NOW }),
    ];

    expect(names(closedRows(boards, tasks, 'personal'))).toEqual(['personal one']);
    expect(names(closedRows(boards, tasks, 'work'))).toEqual(['work one']);
  });

  it('keeps the history of an archived board', () => {
    // Archiving puts a board away; it does not un-finish what was done on it.
    const boards = [board({ archivedAt: NOW - DAY })];
    const rows = closedRows(boards, [task({ completedAt: NOW })], 'personal');

    expect(rows).toHaveLength(1);
    expect(rows[0].board.archivedAt).not.toBeNull();
  });

  it('drops a task whose board is gone rather than inventing one', () => {
    const tasks = [task({ boardId: 'missing', completedAt: NOW })];
    expect(closedRows([board()], tasks, 'personal')).toEqual([]);
  });

  it('measures elapsed time from creation to completion', () => {
    const rows = closedRows(
      [board()],
      [task({ createdAt: NOW - 5 * DAY, completedAt: NOW - DAY })],
      'personal',
    );
    expect(rows[0].elapsedDays).toBeCloseTo(4);
  });

  it('clamps a completion that precedes its own creation to zero', () => {
    const rows = closedRows(
      [board()],
      [task({ createdAt: NOW, completedAt: NOW - DAY })],
      'personal',
    );
    expect(rows[0].elapsedDays).toBe(0);
  });

  it('tells "no deadline" apart from "on time"', () => {
    const boards = [board()];
    const [undated] = closedRows(boards, [task({ completedAt: NOW })], 'personal');
    expect(undated.onTime).toBeNull();

    // An untimed due date is due at 23:59 that day, so a task finished at noon
    // on the date itself is on time.
    const [punctual] = closedRows(
      boards,
      [task({ dueDate: '2026-08-10', completedAt: NOW })],
      'personal',
    );
    expect(punctual.onTime).toBe(true);

    const [late] = closedRows(
      boards,
      [task({ dueDate: '2026-08-08', completedAt: NOW })],
      'personal',
    );
    expect(late.onTime).toBe(false);
  });
});

describe('sortClosed', () => {
  const boards = [board({ name: 'Zebra' }), board({ id: 'b2', name: 'apple' })];
  const rows = closedRows(
    boards,
    [
      task({ id: 'a', name: 'beta', createdAt: NOW - 2 * DAY, completedAt: NOW - DAY }),
      task({ id: 'b', name: 'Alpha', boardId: 'b2', createdAt: NOW - 9 * DAY, completedAt: NOW }),
    ],
    'personal',
  );

  it('sorts by close time in both directions', () => {
    expect(names(sortClosed(rows, 'closed', 'desc'))).toEqual(['Alpha', 'beta']);
    expect(names(sortClosed(rows, 'closed', 'asc'))).toEqual(['beta', 'Alpha']);
  });

  it('sorts by how long the task took', () => {
    expect(names(sortClosed(rows, 'elapsed', 'asc'))).toEqual(['beta', 'Alpha']);
  });

  it('sorts names and board names case-insensitively', () => {
    expect(names(sortClosed(rows, 'name', 'asc'))).toEqual(['Alpha', 'beta']);
    expect(names(sortClosed(rows, 'board', 'asc'))).toEqual(['Alpha', 'beta']);
  });

  it('breaks ties on the close time and then the id, in both directions', () => {
    const tied = closedRows(
      [board()],
      [
        task({ id: 'x', name: 'same', completedAt: NOW }),
        task({ id: 'y', name: 'same', completedAt: NOW }),
      ],
      'personal',
    );
    expect(sortClosed(tied, 'name', 'asc').map((row) => row.task.id)).toEqual(['x', 'y']);
    expect(sortClosed(tied, 'name', 'desc').map((row) => row.task.id)).toEqual(['x', 'y']);
  });

  it('does not mutate the array it was given', () => {
    const before = names(rows);
    sortClosed(rows, 'name', 'asc');
    expect(names(rows)).toEqual(before);
  });
});

describe('filterClosed', () => {
  const rows = closedRows(
    [board({ name: 'Roof' }), board({ id: 'b2', name: 'Taxes' })],
    [
      task({ name: 'Call the roofer', completedAt: NOW - DAY }),
      task({ name: 'File the return', boardId: 'b2', completedAt: NOW - 20 * DAY }),
    ],
    'personal',
  );

  it('matches the task name and the board name', () => {
    expect(names(filterClosed(rows, 'roof', null))).toEqual(['Call the roofer']);
    expect(names(filterClosed(rows, 'taxes', null))).toEqual(['File the return']);
  });

  it('ignores case and surrounding space, and an empty query keeps everything', () => {
    expect(filterClosed(rows, '  ROOFER ', null)).toHaveLength(1);
    expect(filterClosed(rows, '   ', null)).toHaveLength(2);
  });

  it('drops anything closed before the cutoff', () => {
    expect(names(filterClosed(rows, '', NOW - 7 * DAY))).toEqual(['Call the roofer']);
  });

  it('keeps one board when given one, and every board when given none', () => {
    expect(names(filterClosed(rows, '', null, 'b2'))).toEqual(['File the return']);
    expect(filterClosed(rows, '', null, null)).toHaveLength(2);
  });

  it('applies the board, the cutoff and the query together', () => {
    // The board matches and the query matches, but the row is outside the
    // window — every clause has to hold, not any of them.
    expect(filterClosed(rows, 'return', NOW - 7 * DAY, 'b2')).toEqual([]);
    expect(names(filterClosed(rows, 'roofer', NOW - 7 * DAY, 'b1'))).toEqual([
      'Call the roofer',
    ]);
  });
});

describe('boardFacets', () => {
  it('offers only boards with closed work, busiest first', () => {
    const rows = closedRows(
      [
        board({ id: 'quiet', name: 'Quiet' }),
        board({ id: 'busy', name: 'Busy' }),
        board({ id: 'empty', name: 'Empty' }),
      ],
      [
        task({ boardId: 'quiet', completedAt: NOW }),
        task({ boardId: 'busy', completedAt: NOW }),
        task({ boardId: 'busy', completedAt: NOW - DAY }),
        task({ boardId: 'empty' }),
      ],
      'personal',
    );

    expect(boardFacets(rows).map((facet) => [facet.board.id, facet.count])).toEqual([
      ['busy', 2],
      ['quiet', 1],
    ]);
  });

  it('breaks a tie on the board name rather than on insertion order', () => {
    const rows = closedRows(
      [board({ id: 'z', name: 'Zebra' }), board({ id: 'a', name: 'apple' })],
      [task({ boardId: 'z', completedAt: NOW }), task({ boardId: 'a', completedAt: NOW })],
      'personal',
    );
    expect(boardFacets(rows).map((facet) => facet.board.id)).toEqual(['a', 'z']);
  });

  it('has nothing to offer over an empty log', () => {
    expect(boardFacets([])).toEqual([]);
  });
});

describe('closedSummary', () => {
  it('reports nothing rather than zero on an empty log', () => {
    expect(closedSummary([], NOW - 7 * DAY)).toEqual({
      count: 0,
      medianDays: null,
      recent: 0,
      onTime: 0,
      dated: 0,
    });
  });

  it('uses the median, so one ancient task does not distort the typical one', () => {
    const rows = closedRows(
      [board()],
      [
        task({ createdAt: NOW - DAY, completedAt: NOW }),
        task({ createdAt: NOW - 2 * DAY, completedAt: NOW }),
        task({ createdAt: NOW - 300 * DAY, completedAt: NOW }),
      ],
      'personal',
    );
    expect(closedSummary(rows, NOW - 7 * DAY).medianDays).toBeCloseTo(2);
  });

  it('averages the middle two on an even count', () => {
    const rows = closedRows(
      [board()],
      [
        task({ createdAt: NOW - DAY, completedAt: NOW }),
        task({ createdAt: NOW - 4 * DAY, completedAt: NOW }),
      ],
      'personal',
    );
    expect(closedSummary(rows, NOW - 7 * DAY).medianDays).toBeCloseTo(2.5);
  });

  it('counts recent closes and punctuality over the dated rows only', () => {
    const rows = closedRows(
      [board()],
      [
        task({ dueDate: '2026-08-10', completedAt: NOW }),
        task({ dueDate: '2026-08-01', completedAt: NOW }),
        task({ completedAt: NOW - 30 * DAY }),
      ],
      'personal',
    );

    const summary = closedSummary(rows, NOW - 7 * DAY);
    expect(summary).toMatchObject({ count: 3, recent: 2, dated: 2, onTime: 1 });
  });
});
