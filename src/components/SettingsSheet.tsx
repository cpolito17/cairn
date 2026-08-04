/**
 * The settings sheet. PROJECT-SPEC-V2.md §4.3, §5.1; PROJECT-SPEC.md §8.4.
 *
 * A bottom sheet on narrow viewports and a centred modal on wide, through the
 * `Dialog` primitive the composer already uses so the app does not have two
 * personalities at 767px and 769px. It replaces the gear's dropdown menu
 * outright: `Menu`/`MenuItem` stay in the tree for the board header, and this
 * surface stops using them.
 *
 * Sections in the order V2 §4.3 sets: Context · Theme · Working hours ·
 * Archived boards · Log out. The first three are settings, the last two are
 * actions, and the hairline before Archived is where that changes.
 *
 * **Switching context closes the sheet.** The whole app changes underneath it —
 * a different set of boards, possibly a different palette — and a sheet still
 * sitting over that is a sheet the user has to dismiss before they can see what
 * they just did.
 */

import { Archive, SignOut } from '@phosphor-icons/react';
import { useId, type ReactNode } from 'react';
import * as api from '../lib/api';
import { navigate } from '../lib/router';
import { updateSettingsSpec, useSettings, useStore } from '../lib/store';
import { CONTEXTS, type Context } from '../../shared/types';
import { MINUTES_PER_DAY } from '../../shared/settings';
import { Dialog, DialogHeader } from './ui/Dialog';
import { Segmented } from './ui/Segmented';
import { ThemeSelect } from './ThemeSelect';
import type { Theme } from '../lib/theme';

const CONTEXT_OPTIONS = CONTEXTS.map((value) => ({
  value,
  label: value === 'personal' ? 'Personal' : 'Work',
}));

export interface SettingsSheetProps {
  open: boolean;
  onClose(): void;
  onSignedOut(): void;
}

export function SettingsSheet({ open, onClose, onSignedOut }: SettingsSheetProps) {
  const context = useStore((state) => state.context);
  const setContext = useStore((state) => state.setContext);
  const theme = useStore((state) => state.theme);
  const setTheme = useStore((state) => state.setTheme);

  async function logOut() {
    onClose();
    try {
      await api.logout();
    } catch {
      // Logout is idempotent server-side and the cookie clears either way, so a
      // failed request still ends with the user signed out locally.
    }
    window.history.replaceState(null, '', '/');
    onSignedOut();
  }

  return (
    <Dialog open={open} onClose={onClose} title="Settings">
      <DialogHeader title="Settings" onClose={onClose} />

      <Field label="Context">
        <Segmented
          id="context"
          label="Context"
          options={CONTEXT_OPTIONS}
          value={context}
          onChange={(value: Context) => {
            setContext(value);
            onClose();
          }}
        />
      </Field>

      <Field label="Theme">
        <ThemeSelect value={theme} onChange={(next: Theme) => setTheme(next)} />
      </Field>

      <WorkingHours />

      <div
        className="mt-6 pt-2"
        style={{ borderTop: 'var(--hairline-width) solid var(--hairline)' }}
      >
        <ActionRow
          icon={<Archive size={20} />}
          onClick={() => {
            onClose();
            navigate('/archived');
          }}
        >
          Archived boards
        </ActionRow>

        <ActionRow icon={<SignOut size={20} />} onClick={logOut}>
          Log out
        </ActionRow>
      </div>
    </Dialog>
  );
}

/**
 * Working hours (V2 §3.2, §4.3). Two 30-minute selects, written straight
 * through the store's settings mutation — so the write is optimistic, rolls
 * back with a retryable toast, and needs nothing of its own.
 *
 * **The end refuses rather than warns.** Every time at or before the start is
 * `disabled` in the end list, and every time at or after the end is disabled in
 * the start list, so an invalid workday cannot be committed and then explained.
 * Disabled rather than absent on purpose: the times stay visible in the list at
 * the position the user expects them, greyed, which shows *why* they cannot be
 * picked. An option that silently vanishes reads as a bug in the app.
 *
 * The controls are inert until the bootstrap read lands. Before that
 * `settings` is the defaults constant, and a write from that state would be the
 * app overwriting the user's real working hours with 9-to-5 for no better
 * reason than that the sheet was opened early.
 */
function WorkingHours() {
  const settings = useSettings();
  const ready = useStore((state) => state.status === 'ready');
  const mutate = useStore((state) => state.mutate);
  const startId = useId();
  const endId = useId();

  function save(patch: { workdayStartMinutes?: number; workdayEndMinutes?: number }) {
    void mutate(updateSettingsSpec(settings, patch));
  }

  return (
    <Field label="Working hours">
      <div className="grid grid-cols-2 gap-3">
        <TimeSelect
          id={startId}
          label="Start"
          value={settings.workdayStartMinutes}
          // A start at the last slot of the day could have no valid end.
          options={SLOTS.filter((minutes) => minutes < MINUTES_PER_DAY)}
          isDisabled={(minutes) => minutes >= settings.workdayEndMinutes}
          disabled={!ready}
          onChange={(workdayStartMinutes) => save({ workdayStartMinutes })}
        />
        <TimeSelect
          id={endId}
          label="End"
          value={settings.workdayEndMinutes}
          options={SLOTS.filter((minutes) => minutes > 0)}
          isDisabled={(minutes) => minutes <= settings.workdayStartMinutes}
          disabled={!ready}
          onChange={(workdayEndMinutes) => save({ workdayEndMinutes })}
        />
      </div>
    </Field>
  );
}

/** Every half hour of the day, including 1440 — midnight as an *end*. */
const SLOTS: number[] = Array.from(
  { length: MINUTES_PER_DAY / 30 + 1 },
  (_, index) => index * 30,
);

/**
 * A minute offset as "9:00 AM". 1440 is the end of the day rather than the
 * start of the next one, so it is named for what it is.
 */
function formatDayMinute(minutes: number): string {
  if (minutes === MINUTES_PER_DAY) return 'Midnight';
  const hour = Math.floor(minutes / 60);
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minutes % 60).padStart(2, '0')} ${suffix}`;
}

function TimeSelect({
  id,
  label,
  value,
  options,
  isDisabled,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  options: number[];
  /** True where picking this time would end the workday at or before it began. */
  isDisabled(minutes: number): boolean;
  disabled: boolean;
  onChange(minutes: number): void;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-2 block text-text-secondary"
        style={{ fontSize: '13px', fontWeight: 500 }}
      >
        {label}
      </label>
      {/* A native select: it is operable from the keyboard, from a screen
          reader and from a mobile picker without this file re-implementing any
          of the three, and `disabled` on an option is a refusal the platform
          already renders. The well is §8.4's — surface-2, 12px, no border at
          rest, 2px accent ring on focus.

          That ring comes from the global `:focus-visible` rule and nothing
          here, deliberately. Tailwind's `outline-none` sets `outline-style:
          none`, and a later `focus-visible:outline-2` only sets a *width* — so
          the recipe that looks like "no ring at rest, accent ring on focus"
          measures as `outline-style: none, outline-width: 0px` while focused,
          which is no ring at all. The only override is the offset, so the ring
          hugs the well instead of standing 2px off it. */}
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full rounded-control border-0 bg-surface-2 px-4 text-text disabled:opacity-60"
        style={{ height: 'var(--button-height)', outlineOffset: '0px' }}
      >
        {options.map((minutes) => (
          <option key={minutes} value={minutes} disabled={isDisabled(minutes)}>
            {formatDayMinute(minutes)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A labelled settings section. The label is the app's 13px/500 field label. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-6">
      <p className="mb-2 text-text-secondary" style={{ fontSize: '13px', fontWeight: 500 }}>
        {label}
      </p>
      {children}
    </div>
  );
}

/** A full-width action row. The sheet's replacement for `MenuItem`. */
function ActionRow({
  icon,
  onClick,
  children,
}: {
  icon: ReactNode;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // `hoverable` rather than a bare `hover:` utility: §8.5 gates every hover
      // effect behind `(hover: hover) and (pointer: fine)`, and an ungated one
      // sticks on after a tap on a touch device.
      className="pressable hoverable -mx-2 flex items-center gap-3 rounded-control px-2 text-left
                 text-row text-text"
      style={{ minHeight: 'var(--tap-target)', width: 'calc(100% + var(--space-4))' }}
    >
      <span className="text-text-secondary">{icon}</span>
      <span className="flex-1">{children}</span>
    </button>
  );
}
