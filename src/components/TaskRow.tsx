/**
 * The task row — the workhorse. PROJECT-SPEC.md §8.4, §6.4, §6.5, §8.5.
 *
 * Left to right: a checkbox inside a ≥44px target, the name, then a trailing
 * cluster of chips showing **only the fields that are set**, in the fixed order
 * due · duration · difficulty · priority · blocked · notes. A task with nothing
 * set shows nothing but its name — that is the common case and it has to read
 * as intentional, which is why there are no placeholder dashes and no empty
 * chip slots holding space.
 *
 * The whole row opens the composer; the checkbox is a separate target that does
 * not. They are siblings rather than nested (a button inside a button is
 * invalid and, in practice, unclickable) with the row's own button filling the
 * remaining width.
 *
 * **The completion transition** (§8.5) is here, minus the travel: the check
 * draws in rather than appearing, the strikethrough draws across the name, and
 * the text and chips crossfade to their completed contrast. The row's journey
 * into the Completed group is a layout change, and layout changes travel
 * through `lib/flip.ts` — this component does not know where it is going, only
 * how it looks when it gets there. All of it is driven by CSS transitions off
 * the `done` flag rather than by an imperative timeline, which is what makes
 * checking and un-checking the same task as fast as you like safe: a transition
 * retargets from its live value, so the reverse picks up exactly where the
 * forward direction had reached.
 */

import { Check, Clock, Note, Prohibit, Timer, Flag } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { formatDuration, formatDue } from '../lib/dates';
import type { Task } from '../../shared/types';
import { Chip } from './ui/Chip';
import { Pips } from './ui/Pips';

/** §8.5: the check draws in over ~180ms, the crossfades run over ~150ms. */
const CHECK_MS = 180;
const FADE_MS = 150;

/**
 * What each task looked like the last time it was rendered.
 *
 * Completing a task moves it between two lists, which means React unmounts one
 * element and mounts another — and a CSS transition on a brand-new element has
 * nothing to transition *from*, so the check, the strikethrough and the
 * crossfade would all be finished before the row had finished travelling. This
 * carries the previous appearance across the swap: the new element renders the
 * old look for one frame and then changes, which is what gives the transitions
 * their starting value. On a cold load there is no previous appearance and the
 * row renders settled, which is correct — nothing just happened.
 *
 * Module scope rather than component state, because the whole point is to
 * outlive the component. Bounded by the tasks touched in one session, and
 * dropped wholesale rather than grown without limit.
 */
const lastAppearance = new Map<string, { done: boolean; at: number }>();
const APPEARANCE_LIMIT = 500;
/**
 * How stale a remembered appearance may be and still be worth carrying. The
 * swap this exists for happens within a frame or two. Anything older is a
 * different visit — arriving at a board and watching a long-completed row check
 * itself would be a lie about what just happened.
 */
const APPEARANCE_TTL_MS = 250;

export interface TaskRowProps {
  task: Task;
  onOpen(task: Task): void;
  /**
   * `viaKeyboard` is passed through because §8.5 is absolute about it:
   * keyboard-initiated actions get no animation, ever. The row's travel belongs
   * to the caller, so the caller is what has to be told.
   */
  onToggle(task: Task, viaKeyboard: boolean): void;
  /** Set briefly when the row is the target of an Up Next tap (§6.7). */
  highlighted?: boolean;
}

export function TaskRow({ task, onOpen, onToggle, highlighted = false }: TaskRowProps) {
  const done = task.completedAt !== null;
  // The clock is read once per mount rather than per render: the due chip's
  // wording is relative ("Tomorrow"), and a value that changed mid-render would
  // make two rows of the same list disagree.
  const [now] = useState(() => Date.now());
  const due = formatDue(task, now);
  // Everything visual reads `shown`, not `done`: on the commit that completes a
  // task the row still looks incomplete, and changes on the next frame so the
  // transitions have somewhere to start from.
  const shown = useAppearance(task.id, done);
  const struck = useStrikeSettled(shown);

  const nameColor = shown
    ? 'var(--text-tertiary)'
    : task.blocked
      ? 'var(--text-secondary)'
      : 'var(--text)';

  return (
    <div
      className="hoverable relative flex items-stretch gap-1 rounded-control"
      style={{
        minHeight: 'var(--row-height)',
        backgroundColor: highlighted ? 'var(--accent-tint)' : 'transparent',
        transition: 'background-color 420ms var(--ease-out)',
      }}
    >
      <Checkbox
        checked={shown}
        name={task.name}
        onToggle={(viaKeyboard) => onToggle(task, viaKeyboard)}
      />

      <button
        type="button"
        onClick={() => onOpen(task)}
        className="pressable flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1
                   rounded-control py-3 pr-3 text-left"
      >
        <span
          className="relative flex-1 text-row"
          data-motion="essential"
          style={{
            // The name outranks the cluster for width: without a floor, six
            // chips squeeze a long name into a three-line column and the row
            // stops being scannable. Below this the cluster wraps to its own
            // line instead, which is what "grows with content" means here.
            minWidth: '9rem',
            color: nameColor,
            // Once the drawn line has finished, the real decoration takes over
            // — it is the only one of the two that strikes every line of a name
            // that wrapped. Both sit at the same height, so the handover is
            // invisible in the single-line case, which is nearly all of them.
            textDecoration: struck ? 'line-through' : undefined,
            transition: `color ${FADE_MS}ms var(--ease-out)`,
            wordBreak: 'break-word',
          }}
        >
          {task.name}
          {/* §8.5: the strikethrough draws across the name rather than
              appearing. Transform only, from the left, and it retracts the same
              way on un-check because a transition reverses from its live
              value. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 block"
            style={{
              top: 'calc(50% - 0.5px)',
              height: '1px',
              backgroundColor: 'currentColor',
              transformOrigin: 'left center',
              transform: shown ? 'scaleX(1)' : 'scaleX(0)',
              opacity: struck ? 0 : 1,
              transition: `transform ${FADE_MS}ms var(--ease-out)`,
            }}
          />
        </span>

        {/* The cluster shrinks and wraps within itself; the chips inside it do
            not, so a narrow viewport breaks the cluster onto its own line
            rather than clipping the last chip off the screen edge. */}
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {due && (
            <Chip icon={<Clock size={16} />} tone="secondary" muted={shown}>
              {due}
            </Chip>
          )}
          {task.duration && (
            <Chip icon={<Timer size={16} />} muted={shown}>
              {formatDuration(task.duration)}
            </Chip>
          )}
          {task.difficulty !== null && <Pips value={task.difficulty} muted={shown} />}
          {task.priority && (
            <Chip
              icon={<Flag size={16} weight="fill" />}
              tone="accent"
              muted={shown}
              aria-label="Priority"
            />
          )}
          {task.blocked && (
            <Chip icon={<Prohibit size={16} />} muted={shown} aria-label="Blocked" />
          )}
          {task.notes && <Chip icon={<Note size={16} />} muted={shown} aria-label="Has notes" />}
        </span>
      </button>
    </div>
  );
}

/**
 * The checkbox. 24px of box inside a 44px target, per §8.4 — the box is what
 * the eye measures and the target is what the thumb hits.
 *
 * `data-no-drag` keeps it out of the drag gesture: a long press on a 44px
 * target is a press, not a grab. The press feedback itself is the shared
 * `.pressable` rule, which fires on pointer-down (§8.5).
 */
function Checkbox({
  checked,
  name,
  onToggle,
}: {
  checked: boolean;
  name: string;
  onToggle(viaKeyboard: boolean): void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? `Mark "${name}" incomplete` : `Complete "${name}"`}
      data-no-drag=""
      // `detail === 0` is a click the keyboard synthesised. It is the only
      // reliable way to tell Space and Enter from a thumb, and §8.5 wants them
      // told apart.
      onClick={(event) => onToggle(event.detail === 0)}
      className="pressable flex shrink-0 items-center justify-center rounded-control"
      style={{ width: 'var(--tap-target)', minHeight: 'var(--tap-target)' }}
    >
      <span
        aria-hidden="true"
        className="flex items-center justify-center rounded-chip"
        data-motion="essential"
        style={{
          width: '24px',
          height: '24px',
          backgroundColor: checked ? 'var(--accent)' : 'transparent',
          border: checked
            ? '1px solid var(--accent)'
            : '1px solid color-mix(in srgb, var(--text-tertiary) 60%, transparent)',
          color: 'var(--on-accent)',
          transition: `background-color ${CHECK_MS}ms var(--ease-out), border-color ${CHECK_MS}ms var(--ease-out)`,
        }}
      >
        {/* §8.5: the mark draws in, it does not appear. A clip-path reveal
            rather than a scale, because a check that grows from nothing is the
            `scale(0)` entrance the spec forbids outright. */}
        <span
          className="flex"
          style={{
            clipPath: checked ? 'inset(0 0 0 0)' : 'inset(0 100% 0 0)',
            transition: `clip-path ${CHECK_MS}ms var(--ease-out)`,
          }}
        >
          <Check size={16} weight="bold" />
        </span>
      </span>
    </button>
  );
}

/**
 * Record a task as already looking the way it is about to be, so the row that
 * mounts next renders settled instead of transitioning into it.
 *
 * §8.5 gives keyboard-initiated actions no animation, ever, and the caller is
 * the only place that knows a keyboard was involved.
 */
export function settleAppearance(id: string, done: boolean): void {
  lastAppearance.set(id, { done, at: Date.now() });
}

/**
 * The appearance the row should render *now*, which lags its real state by one
 * frame on the render that changes it. See `lastAppearance`.
 */
function useAppearance(id: string, done: boolean): boolean {
  const [shown, setShown] = useState(() => {
    const last = lastAppearance.get(id);
    return last && Date.now() - last.at < APPEARANCE_TTL_MS ? last.done : done;
  });
  if (lastAppearance.size > APPEARANCE_LIMIT) lastAppearance.clear();
  lastAppearance.set(id, { done, at: Date.now() });

  useEffect(() => {
    if (shown === done) return;
    const frame = requestAnimationFrame(() => setShown(done));
    return () => cancelAnimationFrame(frame);
  }, [shown, done]);

  return shown;
}

/**
 * True once the drawn strikethrough has finished, so the real
 * `text-decoration` can take over. Flipped back synchronously during render on
 * un-check, because the line has to still be at full width when its transition
 * to zero starts or there is nothing left to retract.
 */
function useStrikeSettled(done: boolean): boolean {
  const [settled, setSettled] = useState(done);
  if (!done && settled) setSettled(false);

  useEffect(() => {
    if (!done || settled) return;
    const handle = window.setTimeout(() => setSettled(true), FADE_MS + 30);
    return () => window.clearTimeout(handle);
  }, [done, settled]);

  return settled;
}

/**
 * Hold a row's highlight for a beat after an Up Next tap, then release it.
 * Returns the id that should currently read as highlighted.
 */
export function useHighlight(targetId: string | null, ms = 1600): string | null {
  const [id, setId] = useState<string | null>(targetId);

  useEffect(() => {
    setId(targetId);
    if (targetId === null) return;
    const handle = window.setTimeout(() => setId(null), ms);
    return () => window.clearTimeout(handle);
  }, [targetId, ms]);

  return id;
}
