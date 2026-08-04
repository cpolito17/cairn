/**
 * The task composer. PROJECT-SPEC.md §9.5, §8.4, §6.4.
 *
 * A bottom sheet on narrow viewports and a centered modal on wide, with the
 * fields in the order the spec fixes: name, notes, due date, due time, duration
 * chips, difficulty pips, priority, blocked. Due time is not offerable at all
 * until a date is set — a time with no date means nothing, so it is absent
 * rather than present-and-disabled.
 *
 * Dismissal has four doors — the primary action, the explicit close top-left,
 * the scrim, and dragging the sheet down — and they all land in `requestClose`,
 * which is where the one rule about discarding lives: create mode discards
 * silently, edit mode confirms **if fields actually changed**. Comparing the
 * draft to the snapshot it started from is what makes "if changed" true rather
 * than "if touched".
 *
 * The name is required and validates on blur; every other field can be empty
 * and the primary stays enabled regardless, because a disabled primary on a
 * sheet is a dead end the user has to reverse-engineer.
 */

import { Flag, Prohibit } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { addTask } from '../lib/actions';
import {
  deleteTaskSpec,
  endOfBoard,
  selectBoardsFor,
  updateTaskSpec,
  useStore,
} from '../lib/store';
import type { TaskPatch } from '../lib/api';
import { dependencyOptions, lookupOf } from '../../shared/dependencies';
import { formatDuration } from '../lib/dates';
import { DURATIONS, type Context, type Difficulty, type Task } from '../../shared/types';
import { Button } from './ui/Button';
import { SelectableChip } from './ui/Chip';
import { DeleteConfirm } from './DeleteConfirm';
import { Dialog, DialogHeader } from './ui/Dialog';
import { Input, Textarea } from './ui/Input';
import { Modal } from './ui/Modal';
import { PipsInput } from './ui/Pips';

/** Five-minute granularity in the native time picker (§6.4). */
const TIME_STEP_SECONDS = 300;

/** The editable shape, so "changed?" is one comparison instead of eight. */
interface Draft {
  name: string;
  notes: string;
  dueDate: string;
  dueTime: string;
  duration: Task['duration'];
  difficulty: Difficulty | null;
  priority: boolean;
  blocked: boolean;
  /** '' means "not waiting on anything" — a select cannot hold null. */
  dependsOn: string;
}

function draftOf(task: Task | undefined, prefill: string): Draft {
  return {
    name: task?.name ?? prefill,
    notes: task?.notes ?? '',
    dueDate: task?.dueDate ?? '',
    dueTime: task?.dueTime ?? '',
    duration: task?.duration ?? null,
    difficulty: task?.difficulty ?? null,
    priority: task?.priority ?? false,
    blocked: task?.blocked ?? false,
    dependsOn: task?.dependsOn ?? '',
  };
}

function same(a: Draft, b: Draft): boolean {
  return (
    a.name === b.name &&
    a.notes === b.notes &&
    a.dueDate === b.dueDate &&
    a.dueTime === b.dueTime &&
    a.duration === b.duration &&
    a.difficulty === b.difficulty &&
    a.priority === b.priority &&
    a.blocked === b.blocked &&
    a.dependsOn === b.dependsOn
  );
}

export interface TaskComposerProps {
  open: boolean;
  onClose(): void;
  /** Edit mode when present, create mode when not. */
  task?: Task | undefined;
  /** Create mode: the board the task lands on. */
  boardId: string;
  context: Context;
  /** Create mode: whatever quick add had typed when it was expanded. */
  prefillName?: string;
}

export function TaskComposer({
  open,
  onClose,
  task,
  boardId,
  context,
  prefillName = '',
}: TaskComposerProps) {
  const editing = task !== undefined;
  const initial = useMemo(() => draftOf(task, prefillName), [task, prefillName]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [nameError, setNameError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // The dialog stays mounted between openings, so the draft is re-seeded on
  // each one — otherwise a cancelled edit is still in the fields next time.
  useEffect(() => {
    if (!open) return;
    setDraft(initial);
    setNameError(null);
    setConfirmDiscard(false);
    setConfirmDelete(false);
  }, [open, initial]);

  const dirty = !same(draft, initial);
  const nested = confirmDiscard || confirmDelete;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((was) => ({ ...was, [key]: value }));
  }

  /** Every dismissal path lands here (§9.5). */
  function requestClose() {
    // A nested confirmation is on top; Escape and the scrim belong to it.
    if (nested) return;
    if (editing && dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  /** The fields that actually changed, so an untouched field is not written. */
  function patch(): TaskPatch {
    const next: TaskPatch = {};
    if (draft.name.trim() !== initial.name) next.name = draft.name.trim();
    if (draft.notes !== initial.notes) next.notes = draft.notes.trim() || null;
    if (draft.dueDate !== initial.dueDate) next.dueDate = draft.dueDate || null;
    if (draft.dueTime !== initial.dueTime) next.dueTime = draft.dueTime || null;
    if (draft.duration !== initial.duration) next.duration = draft.duration;
    if (draft.difficulty !== initial.difficulty) next.difficulty = draft.difficulty;
    if (draft.priority !== initial.priority) next.priority = draft.priority;
    if (draft.blocked !== initial.blocked) next.blocked = draft.blocked;
    if (draft.dependsOn !== initial.dependsOn) next.dependsOn = draft.dependsOn || null;
    return next;
  }

  function submit(extra?: TaskPatch) {
    const name = draft.name.trim();
    if (name === '') {
      setNameError('A task needs a name.');
      nameRef.current?.focus();
      return;
    }

    if (editing) {
      const body = { ...patch(), ...extra };
      if (Object.keys(body).length > 0) {
        void useStore.getState().mutate(updateTaskSpec(task, body));
      }
    } else {
      addTask({
        boardId,
        name,
        notes: draft.notes.trim() || null,
        dueDate: draft.dueDate || null,
        dueTime: draft.dueTime || null,
        duration: draft.duration,
        difficulty: draft.difficulty,
        priority: draft.priority,
        blocked: draft.blocked,
        dependsOn: draft.dependsOn || null,
      });
    }
    onClose();
  }

  /** §6.4: the task is appended to the end of the destination's active list. */
  function moveTo(destination: string) {
    if (!editing || destination === task.boardId) return;
    const store = useStore.getState();
    submit({ boardId: destination, position: endOfBoard(store, destination) });
  }

  const title = editing ? task.name : 'New task';

  return (
    <>
      <Dialog open={open} onClose={requestClose} title={title}>
        <DialogHeader title={title} onClose={requestClose} />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            ref={nameRef}
            label="Name"
            value={draft.name}
            maxLength={120}
            error={nameError}
            onChange={(event) => {
              set('name', event.target.value);
              if (nameError) setNameError(null);
            }}
            onBlur={() => setNameError(draft.name.trim() === '' ? 'A task needs a name.' : null)}
          />

          <Field>
            <Textarea
              label="Notes"
              rows={3}
              value={draft.notes}
              placeholder="Optional"
              onChange={(event) => set('notes', event.target.value)}
            />
          </Field>

          <Field>
            <Input
              label="Due date"
              type="date"
              value={draft.dueDate}
              onChange={(event) => {
                const value = event.target.value;
                set('dueDate', value);
                // A time with no date is meaningless (§6.4), so clearing the
                // date takes the time with it.
                if (value === '') set('dueTime', '');
              }}
            />
          </Field>

          {/* Offerable only once a date is set (§6.4) — absent, not disabled. */}
          {draft.dueDate !== '' && (
            <Field>
              <Input
                label="Due time"
                type="time"
                // Five-minute granularity. `step` is what drives the native
                // picker's minute list, so 300 turns 60 rows into 12 — the
                // difference between scrolling for 3:35 and glancing at it.
                // Times already stored off the grid still display and still
                // save; the step governs what the picker *offers*.
                step={TIME_STEP_SECONDS}
                value={draft.dueTime}
                onChange={(event) => set('dueTime', event.target.value)}
              />
            </Field>
          )}

          <Field>
            <FieldLabel>Duration</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {DURATIONS.map((duration) => (
                <SelectableChip
                  key={duration}
                  selected={draft.duration === duration}
                  onClick={() =>
                    set('duration', draft.duration === duration ? null : duration)
                  }
                >
                  {formatDuration(duration)}
                </SelectableChip>
              ))}
            </div>
          </Field>

          <Field>
            <FieldLabel>Difficulty</FieldLabel>
            <PipsInput
              label="Difficulty"
              value={draft.difficulty}
              onChange={(value) => set('difficulty', value)}
            />
          </Field>

          <Field>
            <Toggle
              icon={<Flag size={20} weight={draft.priority ? 'fill' : 'regular'} />}
              label="Priority"
              on={draft.priority}
              onToggle={() => set('priority', !draft.priority)}
            />
          </Field>

          <Field>
            <Toggle
              icon={<Prohibit size={20} />}
              label="Blocked"
              on={draft.blocked}
              onToggle={() => set('blocked', !draft.blocked)}
            />
          </Field>

          <Field>
            <DependsOn
              task={task}
              boardId={boardId}
              value={draft.dependsOn}
              onChange={(value) => set('dependsOn', value)}
            />
          </Field>

          <div className="mt-6">
            <Button type="submit" fullWidth>
              {editing ? 'Save' : 'Add'}
            </Button>
          </div>
        </form>

        {editing && (
          // Isolated at the bottom, behind a hairline: the two actions that
          // are not "edit this task" (§8.4).
          <div
            className="mt-6 pt-4"
            style={{ borderTop: 'var(--hairline-width) solid var(--hairline)' }}
          >
            <MoveToBoard task={task} context={context} onMove={moveTo} />
            <div className="mt-2">
              <Button
                variant="destructive"
                onClick={() => setConfirmDelete(true)}
                style={{ paddingLeft: 0, paddingRight: 0 }}
              >
                Delete task
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Modal
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Discard changes"
        showTitle={false}
      >
        <h2 className="text-board-title text-text">Discard changes?</h2>
        <p className="mt-3 text-body text-text-secondary">
          Your edits to &ldquo;{task?.name}&rdquo; have not been saved.
        </p>
        <div className="mt-6 flex items-center justify-end gap-2">
          <Button
            variant="tertiary"
            onClick={() => setConfirmDiscard(false)}
            style={{ color: 'var(--text-secondary)' }}
          >
            Keep editing
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setConfirmDiscard(false);
              onClose();
            }}
            style={{ backgroundColor: 'color-mix(in srgb, var(--negative) 14%, transparent)' }}
          >
            Discard
          </Button>
        </div>
      </Modal>

      {task && (
        <DeleteConfirm
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            void useStore.getState().mutate(deleteTaskSpec(task));
            onClose();
          }}
          kind="task"
          name={task.name}
        />
      )}
    </>
  );
}

function Field({ children }: { children: React.ReactNode }) {
  return <div className="mt-4">{children}</div>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="mb-2 block text-text-secondary"
      style={{ fontSize: '13px', fontWeight: 500 }}
    >
      {children}
    </span>
  );
}

/** A binary flag, as a row-height target rather than a 20px switch. */
function Toggle({
  icon,
  label,
  on,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  on: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className="pressable flex w-full items-center gap-3 rounded-control px-4 text-left"
      style={{
        minHeight: 'var(--tap-target)',
        backgroundColor: on ? 'var(--accent-tint)' : 'var(--surface-2)',
        color: on ? 'var(--accent)' : 'var(--text-secondary)',
        transition: 'background-color 160ms var(--ease-out), color 160ms var(--ease-out)',
      }}
    >
      {icon}
      <span className="text-row">{label}</span>
    </button>
  );
}

/**
 * "Waiting on" — the one dependency a task may hold (§6.4).
 *
 * The options are every other task on the same board that `canDependOn`
 * allows, which is the same function the Worker validates with: the list
 * cannot offer something the server would refuse. In create mode the task does
 * not exist yet, so a stand-in carrying the destination board is what the rule
 * is applied to — nothing can point at an id that has not been minted, so no
 * cycle is reachable and the filter reduces to "on this board".
 *
 * Completed tasks stay in the list. Depending on something already done is
 * legal and simply gates nothing, and dropping them would make the options
 * shift under the user the moment they finished something.
 */
function DependsOn({
  task,
  boardId,
  value,
  onChange,
}: {
  task: Task | undefined;
  boardId: string;
  value: string;
  onChange(value: string): void;
}) {
  const tasks = useStore((state) => state.tasks);

  const options = useMemo(() => {
    const subject: Task = task ?? ({ id: '', boardId } as Task);
    const candidates = Object.values(tasks)
      .filter((candidate) => candidate.boardId === boardId)
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    return dependencyOptions(subject, candidates, lookupOf(tasks));
  }, [task, boardId, tasks]);

  if (options.length === 0) return null;

  return (
    <label className="block">
      <FieldLabel>Waiting on</FieldLabel>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-control border-0 bg-surface-2 px-4 text-row text-text
                   outline-none focus-visible:outline-2 focus-visible:outline-accent"
        style={{ height: 'var(--tap-target)' }}
      >
        <option value="">Nothing</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.completedAt !== null ? `${option.name} (done)` : option.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * "Move to board" — the destination list is the current context's boards only
 * (§6.4), and the board the task is already on is not among them.
 */
function MoveToBoard({
  task,
  context,
  onMove,
}: {
  task: Task;
  context: Context;
  onMove(boardId: string): void;
}) {
  const boards = useStore((state) => selectBoardsFor(state, context));
  const destinations = boards.filter((board) => board.id !== task.boardId);
  if (destinations.length === 0) return null;

  return (
    <label className="block">
      <span
        className="mb-2 block text-text-secondary"
        style={{ fontSize: '13px', fontWeight: 500 }}
      >
        Move to board
      </span>
      <select
        value=""
        onChange={(event) => onMove(event.target.value)}
        className="w-full rounded-control border-0 bg-surface-2 px-4 text-row text-text
                   outline-none focus-visible:outline-2 focus-visible:outline-accent"
        style={{ height: 'var(--tap-target)' }}
      >
        <option value="" disabled>
          Choose a board
        </option>
        {destinations.map((board) => (
          <option key={board.id} value={board.id}>
            {board.name}
          </option>
        ))}
      </select>
    </label>
  );
}
