/**
 * The composer opened by drag-to-create on the Planner grid — the one place a
 * blank drop has to decide between two different kinds of thing to make.
 *
 * A pill selector at the header's right edge, defaulting to **Task**, picks
 * between it and **Event**. Switching swaps the fields below it in place —
 * the Dialog itself never closes and reopens, so there is no sheet animation
 * to sit through on a choice that is also visible in `Schedule.tsx`'s box.
 *
 * The two kinds share only the drawn box and the name field. Everything else
 * about "what a task is" versus "what an event is" is different enough
 * (`TaskComposer.tsx`, `EventEditor.tsx`) that this reads their exported
 * building blocks — `Field`, `FieldLabel`, `DurationChips`, `Toggle`,
 * `DependsOn` — rather than reinventing a third copy of any of them.
 *
 * The event's defaults are read from the drawn box **once, when the dialog
 * opens** — `scheduledAt`/`durationMinutes` do not change after that (the box
 * is fixed the moment the drag ends), so seeding on open already satisfies
 * "switching to Event reflects the box": the numbers are correct before the
 * pill is ever pressed, and pressing it just reveals them.
 */

import { Flag, Prohibit } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { addTask } from '../../lib/actions';
import { hasFinePointer } from '../../lib/motion';
import { createEventSpec, selectBoardsFor, useStore } from '../../lib/store';
import { localDateKey } from '../../../shared/events';
import { startOfLocalDay } from '../../../shared/schedule';
import type { Context, Difficulty } from '../../../shared/types';
import {
  DependsOn,
  DurationChips,
  Field,
  FieldLabel,
  Toggle,
} from '../TaskComposer';
import { Button } from '../ui/Button';
import { Dialog, DialogHeader } from '../ui/Dialog';
import { Input, Textarea } from '../ui/Input';
import { PipsInput } from '../ui/Pips';
import { Segmented, type SegmentedOption } from '../ui/Segmented';

export type CreateSlotKind = 'task' | 'event';

const KIND_OPTIONS: readonly SegmentedOption<CreateSlotKind>[] = [
  { value: 'task', label: 'Task' },
  { value: 'event', label: 'Event' },
];

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const EVENT_DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

interface TaskFields {
  notes: string;
  dueDate: string;
  dueTime: string;
  durationMinutes: number | null;
  difficulty: Difficulty | null;
  priority: boolean;
  blocked: boolean;
  dependsOn: string[];
}

interface EventFields {
  weekdays: number[];
  frequencyWeeks: 1 | 2 | 4;
  startsOn: string;
  startMinutes: number;
  durationMinutes: number;
}

export interface CreateSlotComposerProps {
  open: boolean;
  onClose(): void;
  context: Context;
  /** The box's start and length — always set the moment this can open. */
  scheduledAt: number;
  durationMinutes: number;
  /** So the box on the grid can read "New Task"/"New Event" back (§ the drag). */
  onKindChange(kind: CreateSlotKind): void;
}

export function CreateSlotComposer({
  open,
  onClose,
  context,
  scheduledAt,
  durationMinutes,
  onKindChange,
}: CreateSlotComposerProps) {
  const boards = useStore((state) => selectBoardsFor(state, context));

  const [kind, setKind] = useState<CreateSlotKind>('task');
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [targetBoardId, setTargetBoardId] = useState('');
  const [task, setTask] = useState<TaskFields>(emptyTaskFields());
  const [event, setEvent] = useState<EventFields>(() => eventFieldsFromBox(scheduledAt, durationMinutes));
  const nameRef = useRef<HTMLInputElement>(null);

  // Reseeded every opening, from the box that is about to be drawn under it —
  // never mid-session, or a kind switch after the fields have been touched
  // would stomp on what was typed.
  useEffect(() => {
    if (!open) return;
    setKind('task');
    setName('');
    setNameError(null);
    setTargetBoardId(boards[0]?.id ?? '');
    // The task's duration chip starts at the box's own length, exactly as it
    // did before this composer split off from `TaskComposer` — only the event
    // side is new territory.
    setTask({ ...emptyTaskFields(), durationMinutes });
    setEvent(eventFieldsFromBox(scheduledAt, durationMinutes));

    // This is a typing surface first — land the caret in Name rather than
    // leaving it on the close button, which is where the overlay's own focus
    // trap puts it (`useOverlay`, on `Modal`/`Sheet`). Deferred a tick so it
    // runs after that trap and after the sheet's opening frame commits —
    // calling it synchronously raced the sheet's enter transform and dragged
    // the page's scroll to wherever the field's still-animating position
    // happened to be. Skipped on touch entirely, same as `TaskComposer`: this
    // whole composer is reachable only from the grid's drag-to-create gesture,
    // which is a fine-pointer-only affordance now (see Schedule.tsx), so this
    // mainly guards the fine-pointer-but-no-hover edge case rather than a real
    // touch path — but it costs nothing to keep the two composers consistent.
    if (!hasFinePointer()) return;
    const handle = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function selectKind(next: CreateSlotKind) {
    setKind(next);
    setNameError(null);
    onKindChange(next);
  }

  function set<K extends keyof TaskFields>(key: K, value: TaskFields[K]) {
    setTask((was) => ({ ...was, [key]: value }));
  }

  function setEventField<K extends keyof EventFields>(key: K, value: EventFields[K]) {
    setEvent((was) => ({ ...was, [key]: value }));
  }

  function submit() {
    const trimmed = name.trim();

    if (kind === 'task') {
      if (trimmed === '') {
        setNameError('A task needs a name.');
        return;
      }
      if (!targetBoardId) {
        setNameError('Create a board before adding a task.');
        return;
      }
      addTask({
        boardId: targetBoardId,
        name: trimmed,
        notes: task.notes.trim() || null,
        dueDate: task.dueDate || null,
        dueTime: task.dueTime || null,
        durationMinutes: task.durationMinutes,
        scheduledAt,
        difficulty: task.difficulty,
        priority: task.priority,
        blocked: task.blocked,
        dependsOn: task.dependsOn,
      });
    } else {
      if (trimmed === '') {
        setNameError('An event needs a name.');
        return;
      }
      if (event.weekdays.length === 0) {
        setNameError('Choose at least one day.');
        return;
      }
      void useStore.getState().mutate(
        createEventSpec({
          context,
          name: trimmed,
          weekdays: event.weekdays,
          frequencyWeeks: event.frequencyWeeks,
          startsOn: event.startsOn,
          startMinutes: event.startMinutes,
          durationMinutes: event.durationMinutes,
        }),
      );
    }
    onClose();
  }

  const title = kind === 'task' ? 'New task' : 'New event';
  const clock = `${String(Math.floor(event.startMinutes / 60)).padStart(2, '0')}:${String(event.startMinutes % 60).padStart(2, '0')}`;

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <DialogHeader
        title={title}
        onClose={onClose}
        right={
          <Segmented
            id="create-slot-kind"
            label="Create as"
            options={KIND_OPTIONS}
            value={kind}
            onChange={selectKind}
            // `shrink-0` alone is not enough: each option inside `Segmented`
            // is itself `min-w-0 flex-1`, so with no floor of its own this
            // control collapses to whatever the header's `h2` (also flexible)
            // leaves behind, and "Event" truncates first since it is the
            // longer label. `min-w` is the same fix `Planner.tsx`'s own
            // Week/Month/Year selector already uses for the same reason.
            className="w-auto min-w-[9.5rem] shrink-0"
          />
        }
      />

      <form
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          submit();
        }}
      >
        <Input
          ref={nameRef}
          label="Name"
          value={name}
          maxLength={120}
          error={nameError}
          onChange={(changeEvent) => {
            setName(changeEvent.target.value);
            if (nameError) setNameError(null);
          }}
        />

        {kind === 'task' ? (
          <>
            <Field>
              <label className="mb-1 block text-text-secondary" style={{ fontSize: '13px', fontWeight: 500 }}>
                Board
                <select
                  value={targetBoardId}
                  onChange={(changeEvent) => setTargetBoardId(changeEvent.target.value)}
                  className="mt-1 block w-full rounded-control border-0 bg-surface-2 px-3 text-text"
                  style={{ height: 'var(--tap-target)' }}
                >
                  {boards.map((board) => (
                    <option key={board.id} value={board.id}>
                      {board.name}
                    </option>
                  ))}
                </select>
              </label>
            </Field>

            <Field>
              <Textarea
                label="Notes"
                rows={3}
                value={task.notes}
                placeholder="Optional"
                onChange={(changeEvent) => set('notes', changeEvent.target.value)}
              />
            </Field>

            <Field>
              <Input
                label="Due date"
                type="date"
                value={task.dueDate}
                onChange={(changeEvent) => {
                  const value = changeEvent.target.value;
                  set('dueDate', value);
                  if (value === '') set('dueTime', '');
                }}
              />
            </Field>

            {task.dueDate !== '' && (
              <Field>
                <Input
                  label="Due time"
                  type="time"
                  step={300}
                  value={task.dueTime}
                  onChange={(changeEvent) => set('dueTime', changeEvent.target.value)}
                />
              </Field>
            )}

            <Field>
              <FieldLabel>Duration</FieldLabel>
              <DurationChips value={task.durationMinutes} onChange={(minutes) => set('durationMinutes', minutes)} />
            </Field>

            <Field>
              <FieldLabel>Difficulty</FieldLabel>
              <PipsInput label="Difficulty" value={task.difficulty} onChange={(value) => set('difficulty', value)} />
            </Field>

            <Field>
              <Toggle
                icon={<Flag size={20} weight={task.priority ? 'fill' : 'regular'} />}
                label="Priority"
                on={task.priority}
                onToggle={() => set('priority', !task.priority)}
              />
            </Field>

            <Field>
              <Toggle
                icon={<Prohibit size={20} />}
                label="Blocked"
                on={task.blocked}
                onToggle={() => set('blocked', !task.blocked)}
              />
            </Field>

            <Field>
              <DependsOn task={undefined} boardId={targetBoardId} value={task.dependsOn} onChange={(value) => set('dependsOn', value)} />
            </Field>
          </>
        ) : (
          <>
            <div className="mt-4">
              <span className="mb-2 block text-text-secondary" style={{ fontSize: 13, fontWeight: 500 }}>
                Occurs on
              </span>
              <div className="grid grid-cols-7 gap-2">
                {WEEKDAY_LETTERS.map((label, day) => {
                  const selected = event.weekdays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-label={WEEKDAY_NAMES[day]}
                      aria-pressed={selected}
                      onClick={() =>
                        setEventField(
                          'weekdays',
                          selected ? event.weekdays.filter((value) => value !== day) : [...event.weekdays, day].sort(),
                        )
                      }
                      className={`pressable aspect-square rounded-pill text-meta ${
                        selected ? 'bg-accent text-on-accent' : 'bg-surface-2 text-text-secondary'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="mt-4 block text-text-secondary" style={{ fontSize: 13, fontWeight: 500 }}>
              Repeats
              <select
                value={event.frequencyWeeks}
                onChange={(changeEvent) => setEventField('frequencyWeeks', Number(changeEvent.target.value) as 1 | 2 | 4)}
                className="mt-1 block w-full rounded-control border-0 bg-surface-2 px-3 text-text"
                style={{ height: 'var(--tap-target)' }}
              >
                <option value={1}>Every week</option>
                <option value={2}>Every 2 weeks</option>
                <option value={4}>Every 4 weeks</option>
              </select>
            </label>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <Input
                label="Starting"
                type="date"
                value={event.startsOn}
                onChange={(changeEvent) => setEventField('startsOn', changeEvent.target.value)}
              />
              <Input
                label="Time"
                type="time"
                step={900}
                value={clock}
                onChange={(changeEvent) => {
                  const [h, m] = changeEvent.target.value.split(':').map(Number);
                  setEventField('startMinutes', h * 60 + m);
                }}
              />
            </div>

            <label className="mt-4 block text-text-secondary" style={{ fontSize: 13, fontWeight: 500 }}>
              Duration
              <select
                value={event.durationMinutes}
                onChange={(changeEvent) => setEventField('durationMinutes', Number(changeEvent.target.value))}
                className="mt-1 block w-full rounded-control border-0 bg-surface-2 px-3 text-text"
                style={{ height: 'var(--tap-target)' }}
              >
                {EVENT_DURATIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes < 60 ? `${minutes} min` : `${minutes / 60} hr${minutes === 60 ? '' : 's'}`}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        <div className="mt-6">
          <Button type="submit" fullWidth>
            {kind === 'task' ? 'Add' : 'Add event'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function emptyTaskFields(): TaskFields {
  return {
    notes: '',
    dueDate: '',
    dueTime: '',
    durationMinutes: null,
    difficulty: null,
    priority: false,
    blocked: false,
    dependsOn: [],
  };
}

/** An event's defaults, read off the box the drag just drew. */
function eventFieldsFromBox(scheduledAt: number, durationMinutes: number): EventFields {
  return {
    weekdays: [new Date(scheduledAt).getDay()],
    frequencyWeeks: 1,
    startsOn: localDateKey(scheduledAt),
    startMinutes: (scheduledAt - startOfLocalDay(scheduledAt)) / 60_000,
    durationMinutes,
  };
}
