/**
 * The Closed log. PROJECT-SPEC.md §9.4 (screens own their own states), §8.3,
 * §8.4, §8.5.
 *
 * The fourth view. Boards, Blockers and Planner all answer "what is left"; this
 * one answers "what got done" — every completed task in the active context, in
 * one table, most recently closed first.
 *
 * A table rather than the card lists everywhere else in the app, because the
 * question here is comparative: this is the one screen where the user reads
 * *down* a column ("which of these took three weeks?") rather than across a
 * row. Below 720px the columns that only make sense in a comparison — the board
 * and the punctuality chip — fold into the task cell, so the same markup stays
 * a table instead of becoming a second component that can drift.
 *
 * The screen holds three pieces of state and none of them touch the store: a
 * search string, a sort, and a range. Every one is a question about the same
 * list, so the list is built once by `selectClosed` and narrowed here.
 */

import { ArrowCounterClockwise, ArrowUp, Check, MagnifyingGlass, SortAscending } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { Button } from '../components/ui/Button';
import { Menu, MenuItem } from '../components/ui/Menu';
import { EmptyLine, ErrorLine, loadErrorMessage } from '../components/ui/Section';
import { Segmented } from '../components/ui/Segmented';
import { Skeleton } from '../components/ui/Skeleton';
import { boardAccentColor } from '../lib/boardAccent';
import { formatDate, formatTime, isoDate } from '../lib/dates';
import { boardPath, navigate } from '../lib/router';
import { completeTaskSpec, endOfBoard, useClosed, useStore } from '../lib/store';
import { toast } from '../lib/toasts';
import {
  boardFacets,
  closedSummary,
  filterClosed,
  sortClosed,
  type BoardFacet,
  type ClosedRow,
  type ClosedSort,
  type SortDirection,
} from '../../shared/closed';

const DAY_MS = 86_400_000;

/** How many rows are drawn before "Show more". */
const PAGE = 50;

type Range = '7' | '30' | 'all';

const RANGE_OPTIONS: { value: Range; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: 'all', label: 'All time' },
];

export function Closed() {
  const status = useStore((state) => state.status);
  const context = useStore((state) => state.context);
  const rows = useClosed(context);

  const [query, setQuery] = useState('');
  const [range, setRange] = useState<Range>('all');
  /** The board chip in effect, or null for "All boards". */
  const [boardId, setBoardId] = useState<string | null>(null);
  const [sort, setSort] = useState<ClosedSort>('closed');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [shown, setShown] = useState(PAGE);

  // The clock is read once per render rather than per row: "3 days ago" and the
  // 7-day cutoff must agree with each other, and a row that formats against its
  // own `Date.now()` is a row that can disagree with the one above it.
  const now = Date.now();

  const facets = useMemo(() => boardFacets(rows), [rows]);

  /**
   * The rows the summary describes: the chosen board, and nothing else.
   *
   * Deliberately not the table's full filter. "Last 7 days" inside a 7-day
   * range would be a figure that always equals the count above it, and a
   * summary that moves on every keystroke is a summary nobody can read — but a
   * board filter is a change of *subject*, and the figures have to follow it or
   * they are describing a table the user is no longer looking at.
   */
  const scope = useMemo(
    () => (boardId === null ? rows : filterClosed(rows, '', null, boardId)),
    [rows, boardId],
  );

  const visible = useMemo(() => {
    const since = range === 'all' ? null : now - Number(range) * DAY_MS;
    return sortClosed(filterClosed(rows, query, since, boardId), sort, direction);
    // `now` is deliberately not a dependency: it changes every render, and the
    // cutoff it feeds is a day-scale boundary that re-deriving on each keystroke
    // would not move. The list is rebuilt whenever anything the user changed
    // changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, query, range, boardId, sort, direction]);

  const summary = useMemo(() => closedSummary(scope, now - 7 * DAY_MS), [scope, now]);

  /** A press on a column header: same column flips it, a new column starts at
   *  the order that column is most useful in. */
  function onSort(next: ClosedSort) {
    if (next === sort) {
      setDirection((was) => (was === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSort(next);
    // Recent first, longest first, but A–Z for the two text columns — the
    // useful end of each column, rather than one direction for all four.
    setDirection(next === 'closed' || next === 'elapsed' ? 'desc' : 'asc');
  }

  function reset(nextQuery: string, nextRange: Range, nextBoard: string | null = boardId) {
    setQuery(nextQuery);
    setRange(nextRange);
    setBoardId(nextBoard);
    // A narrowed list starts at the top of its own first page; carrying a
    // "show more" from the previous filter shows a page count that no longer
    // describes anything the user asked for.
    setShown(PAGE);
  }

  if (status === 'loading') return <ClosedSkeleton />;
  if (status === 'error') return <ClosedError />;

  return (
    <>
      <ClosedHeading />

      {rows.length === 0 ? (
        <EmptyLine>
          Nothing is closed in this context yet. Completed tasks land here.
        </EmptyLine>
      ) : (
        <>
          <Summary
            count={summary.count}
            medianDays={summary.medianDays}
            recent={summary.recent}
            onTime={summary.onTime}
            dated={summary.dated}
          />

          <div className="closed-toolbar mt-section">
            <label className="closed-search">
              <MagnifyingGlass
                size={18}
                aria-hidden="true"
                className="closed-search-icon text-text-tertiary"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => reset(event.target.value, range)}
                placeholder="Search closed tasks"
                aria-label="Search closed tasks"
                className="closed-search-input text-body text-text"
              />
            </label>
            <div className="closed-toolbar-controls">
              <Segmented
                id="closed-range"
                label="Range"
                options={RANGE_OPTIONS}
                value={range}
                onChange={(next: Range) => reset(query, next)}
              />
              {/* Below the table's wide breakpoint the column headers are gone,
                  and with them the only way to re-sort. This menu is that way,
                  and it exists only there. */}
              <SortMenu sort={sort} direction={direction} onPick={(nextSort, nextDirection) => {
                setSort(nextSort);
                setDirection(nextDirection);
              }} />
            </div>
          </div>

          {/* One chip per board with closed work, plus "All". It is a filter,
              so it only offers boards that would return something. */}
          {facets.length > 1 && (
            <BoardFilter
              facets={facets}
              total={rows.length}
              selected={boardId}
              onSelect={(next) => reset(query, range, next)}
            />
          )}

          {visible.length === 0 ? (
            <EmptyLine>No closed task matches that.</EmptyLine>
          ) : (
            <>
              <div className="closed-table-wrap mt-4">
                <table className="closed-table">
                  <caption className="sr-only">
                    Closed tasks, {describeSort(sort, direction)}
                  </caption>
                  <thead>
                    <tr>
                      <ColumnHeader
                        column="name"
                        sort={sort}
                        direction={direction}
                        onSort={onSort}
                      >
                        Task
                      </ColumnHeader>
                      <ColumnHeader
                        column="board"
                        sort={sort}
                        direction={direction}
                        onSort={onSort}
                        className="closed-col-board"
                      >
                        Board
                      </ColumnHeader>
                      <ColumnHeader
                        column="closed"
                        sort={sort}
                        direction={direction}
                        onSort={onSort}
                        align="right"
                        className="closed-col-when"
                      >
                        Closed
                      </ColumnHeader>
                      <ColumnHeader
                        column="elapsed"
                        sort={sort}
                        direction={direction}
                        onSort={onSort}
                        align="right"
                        className="closed-col-took"
                      >
                        Took
                      </ColumnHeader>
                      <th scope="col" className="closed-col-action">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.slice(0, shown).map((row) => (
                      <Row key={row.task.id} row={row} now={now} />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 flex items-center justify-between gap-3">
                <p className="text-meta text-text-tertiary">
                  {visible.length <= shown
                    ? `${visible.length} ${visible.length === 1 ? 'task' : 'tasks'}`
                    : `Showing ${shown} of ${visible.length}`}
                </p>
                {visible.length > shown && (
                  <Button variant="tertiary" onClick={() => setShown((was) => was + PAGE)}>
                    Show more
                  </Button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

function ClosedHeading() {
  return <h1 className="mb-3 text-board-title text-text">Closed</h1>;
}

function Summary({
  count,
  medianDays,
  recent,
  onTime,
  dated,
}: {
  count: number;
  medianDays: number | null;
  recent: number;
  onTime: number;
  dated: number;
}) {
  return (
    <dl className="closed-summary">
      <Figure label="Closed" value={String(count)} />
      <Figure label="Last 7 days" value={String(recent)} />
      <Figure
        label="Typical time"
        value={medianDays === null ? '—' : formatElapsed(medianDays)}
      />
      {/* Punctuality is only meaningful over the tasks that carried a due date,
          so the figure names its own denominator rather than quietly counting
          every undated task as a win. */}
      <Figure
        label="On time"
        value={dated === 0 ? '—' : `${Math.round((onTime / dated) * 100)}%`}
        hint={dated === 0 ? 'no due dates' : `of ${dated} dated`}
      />
    </dl>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      className="closed-figure"
      style={{
        backgroundColor: 'var(--surface)',
        border: 'var(--hairline-width) solid var(--hairline)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      <dt className="text-meta text-text-secondary">{label}</dt>
      <dd className="mt-1 text-row text-text" style={{ fontWeight: 700 }}>
        {value}
        {hint && (
          <span className="ml-2 text-meta text-text-tertiary" style={{ fontWeight: 500 }}>
            {hint}
          </span>
        )}
      </dd>
    </div>
  );
}

function ColumnHeader({
  column,
  sort,
  direction,
  onSort,
  align = 'left',
  className = '',
  children,
}: {
  column: ClosedSort;
  sort: ClosedSort;
  direction: SortDirection;
  onSort(column: ClosedSort): void;
  align?: 'left' | 'right';
  className?: string;
  children: string;
}) {
  const active = column === sort;
  // One arrow, rotated — the same element in both directions, so the flip is a
  // 180° turn rather than one glyph swapped for another.
  const arrow = (
    <ArrowUp
      size={12}
      aria-hidden="true"
      className="closed-sort-arrow"
      style={{
        opacity: active ? 1 : 0,
        transform: `rotate(${active && direction === 'desc' ? 180 : 0}deg)`,
      }}
    />
  );

  return (
    <th
      scope="col"
      className={className}
      // The live sort is announced through the header itself rather than a
      // toast: this is what `aria-sort` is for, and a screen reader arriving at
      // the column mid-table gets the answer without having heard the change.
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="pressable closed-sort text-section text-text-secondary"
        style={{ justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}
      >
        {/* The arrow leads on a right-aligned column and trails on a
            left-aligned one, so the *label* is what sits flush with the
            column's own edge. Trailing it on the right would hold 16px of
            space open on the side the figures align to — visible or not, since
            an inactive arrow is transparent rather than absent — and the header
            would read as offset from the column beneath it. */}
        {align === 'right' && arrow}
        <span style={{ textTransform: 'uppercase' }}>{children}</span>
        {align === 'left' && arrow}
      </button>
    </th>
  );
}

function BoardFilter({
  facets,
  total,
  selected,
  onSelect,
}: {
  facets: BoardFacet[];
  total: number;
  selected: string | null;
  onSelect(boardId: string | null): void;
}) {
  return (
    <div
      className="closed-boards mt-3"
      role="group"
      aria-label="Filter closed tasks by board"
    >
      <FilterChip
        selected={selected === null}
        count={total}
        onClick={() => onSelect(null)}
        label="All boards"
      />
      {facets.map((facet) => (
        <FilterChip
          key={facet.board.id}
          selected={selected === facet.board.id}
          count={facet.count}
          accent={boardAccentColor(facet.board.accent)}
          onClick={() => onSelect(selected === facet.board.id ? null : facet.board.id)}
          label={facet.board.name}
        />
      ))}
    </div>
  );
}

function FilterChip({
  selected,
  count,
  accent,
  label,
  onClick,
}: {
  selected: boolean;
  count: number;
  accent?: string;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      // A filter is a state the control is *in*, not a thing it navigates to,
      // which is what `aria-pressed` says and a plain button does not.
      aria-pressed={selected}
      onClick={onClick}
      className={[
        'pressable closed-chip rounded-pill text-meta',
        selected ? 'bg-accent-tint text-accent' : 'bg-surface-2 text-text-secondary',
      ].join(' ')}
    >
      {accent && (
        <span
          aria-hidden="true"
          className="block shrink-0 rounded-pill"
          style={{ width: '8px', height: '8px', backgroundColor: accent }}
        />
      )}
      <span className="truncate">{label}</span>
      {/* The count is what makes the row a summary as well as a filter: it says
          which boards the work actually came from before anything is pressed. */}
      <span className={selected ? '' : 'text-text-tertiary'}>{count}</span>
    </button>
  );
}

/** The sort options the narrow-viewport menu offers, in the order it lists them. */
const SORT_OPTIONS: { sort: ClosedSort; direction: SortDirection; label: string }[] = [
  { sort: 'closed', direction: 'desc', label: 'Recently closed' },
  { sort: 'closed', direction: 'asc', label: 'Oldest closed' },
  { sort: 'elapsed', direction: 'desc', label: 'Took longest' },
  { sort: 'elapsed', direction: 'asc', label: 'Took least' },
  { sort: 'name', direction: 'asc', label: 'Task name' },
  { sort: 'board', direction: 'asc', label: 'Board' },
];

function SortMenu({
  sort,
  direction,
  onPick,
}: {
  sort: ClosedSort;
  direction: SortDirection;
  onPick(sort: ClosedSort, direction: SortDirection): void;
}) {
  return (
    // The display rule lives in `index.css` and nowhere else: a Tailwind
    // `flex` utility here would sit in a later cascade layer and win against
    // the media query that hides this above 720px.
    <div className="closed-sort-menu">
      <SortAscending size={18} aria-hidden="true" className="text-text-tertiary" />
      <Menu label="Sort closed tasks">
        {(close) => (
          <>
            {SORT_OPTIONS.map((option) => {
              const active = option.sort === sort && option.direction === direction;
              return (
                <MenuItem
                  key={`${option.sort}-${option.direction}`}
                  icon={active ? <Check size={18} /> : <span style={{ width: 18 }} />}
                  onClick={() => {
                    onPick(option.sort, option.direction);
                    close();
                  }}
                >
                  {option.label}
                </MenuItem>
              );
            })}
          </>
        )}
      </Menu>
    </div>
  );
}

function Row({ row, now }: { row: ClosedRow; now: number }) {
  const { task, board } = row;
  const archived = board.archivedAt !== null;

  return (
    <tr
      className="closed-row"
      tabIndex={0}
      role="link"
      aria-label={`${task.name}, on ${board.name}, closed ${formatClosed(row.closedAt, now)}`}
      onClick={() => open(task.id, board.id)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open(task.id, board.id);
      }}
    >
      <td className="closed-cell-task">
        <span className="closed-name text-row text-text">{task.name}</span>
        {/* Below the table's wide breakpoint every other column folds into
            this line rather than pushing the table into a sideways scroll on a
            phone, where the figure you came for would be the one off-screen. */}
        <span className="closed-subline text-meta text-text-tertiary">
          {/* Spacing separates these, not "·" characters: the line wraps on a
              narrow phone, and a separator that lands at the end of a wrapped
              line dangles with nothing after it. */}
          <BoardTag board={board} archived={archived} />
          <span className="whitespace-nowrap">{formatClosed(row.closedAt, now)}</span>
          <span className="whitespace-nowrap">{formatElapsed(row.elapsedDays)}</span>
          <Punctuality row={row} />
        </span>
      </td>

      <td className="closed-col-board">
        <BoardTag board={board} archived={archived} />
        <Punctuality row={row} standalone />
      </td>

      <td className="closed-num closed-col-when text-meta text-text-secondary">
        <span title={new Date(row.closedAt).toLocaleString()}>
          {formatClosed(row.closedAt, now)}
        </span>
      </td>

      <td
        className="closed-num closed-col-took text-meta text-text-secondary"
        title={`${row.elapsedDays.toFixed(1)} days from created to closed`}
      >
        {formatElapsed(row.elapsedDays)}
      </td>

      <td className="closed-col-action">
        <button
          type="button"
          aria-label={`Reopen ${task.name}`}
          title="Reopen"
          onClick={(event) => {
            // The row is a link; the button inside it is not part of that link.
            event.stopPropagation();
            reopen(row);
          }}
          className="pressable closed-reopen rounded-chip text-text-tertiary"
        >
          <ArrowCounterClockwise size={18} />
        </button>
      </td>
    </tr>
  );
}

function BoardTag({ board, archived }: { board: ClosedRow['board']; archived: boolean }) {
  return (
    <span className="closed-board">
      <span
        aria-hidden="true"
        className="block shrink-0 rounded-pill"
        style={{ width: '8px', height: '8px', backgroundColor: boardAccentColor(board.accent) }}
      />
      <span className="truncate text-meta text-text-secondary">{board.name}</span>
      {/* An archived board's history stays in the log — see `shared/closed.ts` —
          so the row says where it went rather than disappearing. */}
      {archived && <span className="text-meta text-text-tertiary">· archived</span>}
    </span>
  );
}

/**
 * On time / late, for a task that had a due date. Nothing at all for one that
 * did not: an undated task cannot be late, and a grey "—" in every second row
 * is noise standing in for an answer.
 */
function Punctuality({ row, standalone = false }: { row: ClosedRow; standalone?: boolean }) {
  if (row.onTime === null) return null;
  return (
    <span
      className={`closed-punctual text-meta ${standalone ? 'closed-punctual-standalone' : ''}`}
      style={{ color: row.onTime ? 'var(--text-tertiary)' : 'var(--negative)' }}
    >
      {row.onTime ? 'On time' : 'Late'}
    </span>
  );
}

/** Open the board this task lives on, with the row highlighted (§6.7). */
function open(taskId: string, boardId: string): void {
  navigate(boardPath(boardId), { state: { highlightTaskId: taskId } });
}

/**
 * Put a task back on its board's active list.
 *
 * The same rule the row's checkbox follows (§6.5, §7.3): an un-completed task
 * goes to the *end* of the active list rather than back where it was, and it
 * goes through `completeTaskSpec` so the log and the board cannot disagree
 * about what un-completing means.
 */
function reopen(row: ClosedRow): void {
  const store = useStore.getState();
  const live = store.tasks[row.task.id];
  if (!live || live.completedAt === null) return;
  void store
    .mutate(completeTaskSpec(live, false, endOfBoard(store, live.boardId)))
    .then((committed) => {
      if (committed) toast.info(`Reopened "${live.name}" on ${row.board.name}`);
    });
}

/** "Today · 3:04 PM", "Yesterday · 9:12 AM", "Aug 12 · 9:12 AM". */
function formatClosed(at: number, now: number): string {
  const date = new Date(at);
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${formatDate(isoDate(at), now)} · ${formatTime(hhmm)}`;
}

/**
 * How long it took, as a column reads it: hours under a day, then whole days,
 * then months once the figure stops being countable in days.
 *
 * "0 days" is the string this exists to avoid — a task jotted down and ticked
 * off the same afternoon took two hours, and saying zero reads as missing data.
 */
export function formatElapsed(days: number): string {
  if (days < 1) {
    const hours = Math.floor(days * 24);
    return hours < 1 ? '<1h' : `${hours}h`;
  }
  const whole = Math.round(days);
  if (whole < 60) return `${whole}d`;
  return `${Math.round(days / 30.44)}mo`;
}

function describeSort(sort: ClosedSort, direction: SortDirection): string {
  const column = { closed: 'close time', elapsed: 'time taken', board: 'board', name: 'name' }[
    sort
  ];
  return `sorted by ${column}, ${direction === 'asc' ? 'ascending' : 'descending'}`;
}

function ClosedSkeleton() {
  return (
    <>
      <ClosedHeading />
      <div className="closed-summary">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="closed-figure"
            style={{
              backgroundColor: 'var(--surface)',
              border: 'var(--hairline-width) solid var(--hairline)',
              borderRadius: 'var(--radius-card)',
            }}
          >
            <Skeleton width="50%" height="0.75rem" />
            <div className="mt-2">
              <Skeleton width="35%" height="1rem" />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-section grid gap-2">
        {[0, 1, 2, 3, 4].map((index) => (
          <Skeleton key={index} width="100%" height="var(--row-height)" radius="var(--radius-control)" />
        ))}
      </div>
    </>
  );
}

function ClosedError() {
  const load = useStore((state) => state.load);
  const failure = useStore((state) => state.failure);
  return (
    <>
      <ClosedHeading />
      <ErrorLine
        action={
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        }
      >
        {loadErrorMessage('your closed tasks', failure)}
      </ErrorLine>
    </>
  );
}
