/**
 * The Notifications section of the settings sheet.
 *
 * One surface, two kinds of state, and the distinction is the reason this file
 * is not three controls in `SettingsSheet.tsx`:
 *
 * - **Account state** — on or off, the two start-of-day times, the reminder
 *   lead, the time zone. Stored server-side in the settings document, shared by
 *   Personal and Work, and identical on every device.
 * - **Device state** — whether *this* browser holds a push subscription. Not in
 *   the settings document and not shareable: the phone and the laptop each
 *   answer for themselves.
 *
 * The master toggle drives both, because "turn on notifications" means both
 * things on the device you are holding. But a second device arriving later
 * finds the account already on and itself unsubscribed, which is a real state
 * and gets its own quiet row rather than a toggle that looks wrong.
 *
 * Every refusal names itself. A toggle that will not stay on is the same
 * symptom for an un-installed PWA, a denied permission, and a server with no
 * VAPID keys, and only the user can fix the first two — so the blocker is read
 * back as a sentence instead of being collapsed into a failure.
 */

import { BellRinging, BellSlash, DeviceMobile, PaperPlaneTilt } from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useState } from 'react';
import * as api from '../lib/api';
import {
  PushError,
  disablePush,
  enablePush,
  readPushState,
  type PushBlocker,
  type PushState,
} from '../lib/push';
import { updateSettingsSpec, useSettings, useStore } from '../lib/store';
import { toast } from '../lib/toasts';
import { nextDigestAt } from '../../shared/notifications';
import { formatDayMinute, zonedParts } from '../../shared/timezone';
import { REMINDER_LEADS, type Settings } from '../../shared/types';
import { Toggle } from './TaskComposer';

export function NotificationSettings() {
  const settings = useSettings();
  const ready = useStore((state) => state.status === 'ready');
  const mutate = useStore((state) => state.mutate);

  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void readPushState().then(setPush);
  }, []);

  // Read on mount rather than held in the store: permission and subscription
  // live in the browser, can be changed from outside the app entirely (iOS
  // Settings, clearing site data), and are therefore only ever true as of the
  // moment they were asked for.
  useEffect(refresh, [refresh]);

  function save(patch: Partial<Settings>) {
    void mutate(updateSettingsSpec(settings, patch));
  }

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      if (settings.notificationsEnabled) {
        // The account switch goes off first. It is the one that actually stops
        // the cron, so if the browser's unsubscribe fails, notifications have
        // still stopped — which is the direction the user asked for.
        save({ notificationsEnabled: false });
        await disablePush();
      } else {
        // ...and last, on the way on: nothing should say notifications are on
        // until a device is genuinely subscribed to receive them.
        await enablePush();
        save({ notificationsEnabled: true, ...adoptDeviceZone(settings) });
      }
      refresh();
    } catch (error) {
      toast.error(explain(error));
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function subscribeThisDevice() {
    if (busy) return;
    setBusy(true);
    try {
      await enablePush();
      refresh();
    } catch (error) {
      toast.error(explain(error));
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await api.sendTestPush();
      if (outcome.sent > 0) {
        toast.success(
          outcome.sent === 1 ? 'Test sent to your device.' : `Test sent to ${outcome.sent} devices.`,
        );
      } else {
        // Accepted by nothing. Saying "sent" here would be the app telling the
        // user their phone is about to buzz when it is not.
        toast.error("The test couldn't be delivered to any device.");
      }
      refresh();
    } catch (error) {
      toast.error(explain(error));
    } finally {
      setBusy(false);
    }
  }

  const blocker = push?.blocker ?? null;
  const on = settings.notificationsEnabled;

  return (
    <div className="mt-6">
      <p className="mb-2 text-text-secondary" style={{ fontSize: '13px', fontWeight: 500 }}>
        Notifications
      </p>

      <Toggle
        icon={on ? <BellRinging size={20} /> : <BellSlash size={20} />}
        label="Push notifications"
        on={on}
        onToggle={() => void toggle()}
      />

      {blocker !== null && <Note>{blockerNote(blocker)}</Note>}

      {/* Subscribed elsewhere, not here. A device that hears nothing while the
          setting reads "on" is the confusing state this row exists to name. */}
      {on && blocker === null && push !== null && !push.subscribed && (
        <button
          type="button"
          onClick={() => void subscribeThisDevice()}
          disabled={busy}
          className="pressable hoverable mt-2 flex w-full items-center gap-3 rounded-control px-4
                     text-left disabled:opacity-60"
          style={{ minHeight: 'var(--tap-target)', backgroundColor: 'var(--surface-2)' }}
        >
          <DeviceMobile size={20} className="text-text-secondary" />
          <span className="text-row text-text">Turn on for this device</span>
        </button>
      )}

      {on && blocker === null && (
        <>
          <StartOfDay settings={settings} ready={ready} onSave={save} />
          <ReminderLead settings={settings} ready={ready} onSave={save} />
          <TimeZone settings={settings} ready={ready} onSave={save} />

          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={busy || !push?.subscribed}
            className="pressable hoverable mt-3 flex w-full items-center gap-3 rounded-control px-4
                       text-left disabled:opacity-60"
            style={{ minHeight: 'var(--tap-target)', backgroundColor: 'var(--surface-2)' }}
          >
            <PaperPlaneTilt size={20} className="text-text-secondary" />
            <span className="text-row text-text">Send a test notification</span>
          </button>

          <Note>{scheduleSummary(settings, push?.devices ?? 0)}</Note>
        </>
      )}
    </div>
  );
}

/* --- the individual controls ------------------------------------------------ */

/**
 * Two start-of-day times: Mon–Fri and Sat–Sun.
 *
 * Two rather than seven, deliberately. A per-day grid is seven controls to
 * express what is nearly always two facts, and the two-way split is the shape
 * the week actually has for the person using this.
 */
function StartOfDay({
  settings,
  ready,
  onSave,
}: {
  settings: Settings;
  ready: boolean;
  onSave(patch: Partial<Settings>): void;
}) {
  const weekdayId = useId();
  const weekendId = useId();

  return (
    <SubField label="Start of day">
      <div className="grid grid-cols-2 gap-3">
        <Select
          id={weekdayId}
          label="Mon–Fri"
          value={String(settings.weekdayStartMinutes)}
          disabled={!ready}
          onChange={(value) => onSave({ weekdayStartMinutes: Number(value) })}
          options={QUARTER_HOURS.map((minutes) => ({
            value: String(minutes),
            label: formatDayMinute(minutes),
          }))}
        />
        <Select
          id={weekendId}
          label="Sat–Sun"
          value={String(settings.weekendStartMinutes)}
          disabled={!ready}
          onChange={(value) => onSave({ weekendStartMinutes: Number(value) })}
          options={QUARTER_HOURS.map((minutes) => ({
            value: String(minutes),
            label: formatDayMinute(minutes),
          }))}
        />
      </div>
    </SubField>
  );
}

function ReminderLead({
  settings,
  ready,
  onSave,
}: {
  settings: Settings;
  ready: boolean;
  onSave(patch: Partial<Settings>): void;
}) {
  const id = useId();
  return (
    <SubField label="Remind me about timed tasks">
      <Select
        id={id}
        value={String(settings.dueReminderLeadMinutes)}
        disabled={!ready}
        onChange={(value) =>
          onSave({ dueReminderLeadMinutes: value === 'null' ? null : Number(value) })
        }
        options={REMINDER_LEADS.map((lead) => ({
          value: String(lead),
          label: leadLabel(lead),
        }))}
      />
    </SubField>
  );
}

/**
 * The time zone the schedule is read in.
 *
 * Picked, never detected. A zone that followed the device would move the
 * morning digest every time the app was opened somewhere else, which is a
 * setting changing itself. The device's own zone is offered as a one-tap
 * suggestion when it differs — a shortcut, not a behaviour.
 */
function TimeZone({
  settings,
  ready,
  onSave,
}: {
  settings: Settings;
  ready: boolean;
  onSave(patch: Partial<Settings>): void;
}) {
  const id = useId();
  const device = deviceTimeZone();
  const options = timeZoneOptions(settings.timeZone, device);

  return (
    <SubField label="Time zone">
      <Select
        id={id}
        value={settings.timeZone}
        disabled={!ready}
        onChange={(timeZone) => onSave({ timeZone })}
        options={options.map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }))}
      />
      {device !== null && device !== settings.timeZone && (
        <button
          type="button"
          onClick={() => onSave({ timeZone: device })}
          disabled={!ready}
          className="pressable mt-2 text-left text-accent disabled:opacity-60"
          style={{ fontSize: '13px', fontWeight: 500, minHeight: '32px' }}
        >
          Use this device’s zone ({device.replace(/_/g, ' ')})
        </button>
      )}
    </SubField>
  );
}

/* --- copy ------------------------------------------------------------------- */

function blockerNote(blocker: PushBlocker): string {
  switch (blocker) {
    case 'needs-install':
      return 'Add Cairn to your home screen to receive notifications on iOS — open the share sheet and choose Add to Home Screen, then turn this on from there.';
    case 'unsupported':
      return 'This browser cannot receive push notifications.';
    case 'denied':
      return 'Notifications are blocked for this site. Allow them in your browser or system settings, then turn this on again.';
    case 'unconfigured':
      return 'This deployment has no notification keys configured yet. See docs/NOTIFICATIONS.md.';
    case 'demo':
      return 'Notifications are not part of the demo.';
  }
}

/** "Next digest tomorrow at 8:00 AM · 2 devices". */
function scheduleSummary(settings: Settings, devices: number): string {
  const now = Date.now();
  const at = nextDigestAt(now, settings);
  const parts = zonedParts(at, settings.timeZone);
  const today = zonedParts(now, settings.timeZone);
  const sameDay =
    parts.year === today.year && parts.month === today.month && parts.day === today.day;

  const when = `${sameDay ? 'today' : DAY_NAMES[parts.weekday]} at ${formatDayMinute(
    parts.hour * 60 + parts.minute,
  )}`;
  const where = devices === 1 ? '1 device' : `${devices} devices`;
  return `Next summary ${when} · ${where}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function leadLabel(lead: number | null): string {
  if (lead === null) return 'Never';
  if (lead === 0) return 'At the due time';
  if (lead === 60) return '1 hour before';
  return `${lead} minutes before`;
}

function explain(error: unknown): string {
  if (error instanceof PushError) {
    return error.blocker === 'failed' ? error.message : blockerNote(error.blocker);
  }
  if (error instanceof api.ApiError) return error.message;
  return "Notifications couldn't be turned on.";
}

/* --- time zones -------------------------------------------------------------- */

function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Every zone the runtime knows, with the stored and device zones guaranteed
 * present.
 *
 * `Intl.supportedValuesOf` is the right source — it is the runtime's own tzdata
 * rather than a list in this repo that would go stale — but it is not in every
 * browser, and a select that silently dropped the stored zone would show the
 * wrong one as selected. Hence the union and the fallback.
 */
function timeZoneOptions(current: string, device: string | null): string[] {
  let supported: string[] = [];
  try {
    const values = (
      Intl as typeof Intl & { supportedValuesOf?(key: string): string[] }
    ).supportedValuesOf?.('timeZone');
    if (Array.isArray(values)) supported = values;
  } catch {
    supported = [];
  }
  if (supported.length === 0) supported = [...FALLBACK_ZONES];

  const all = new Set(supported);
  all.add(current);
  if (device) all.add(device);
  all.add('UTC');
  return [...all].sort();
}

/** Enough to be usable where `supportedValuesOf` is missing. */
const FALLBACK_ZONES = [
  'UTC',
  'America/Anchorage',
  'America/Chicago',
  'America/Denver',
  'America/Detroit',
  'America/Halifax',
  'America/Los_Angeles',
  'America/New_York',
  'America/Phoenix',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Berlin',
  'Europe/Dublin',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Paris',
  'Pacific/Auckland',
  'Pacific/Honolulu',
] as const;

/** Every quarter hour of the day. A start-of-day never lands on 1440. */
const QUARTER_HOURS: number[] = Array.from({ length: (24 * 60) / 15 }, (_, index) => index * 15);

/**
 * Adopt the device's zone the first time notifications are switched on, and
 * only while the stored zone is still the untouched default.
 *
 * The zone is a picked setting (see `TimeZone`), so this is not detection — it
 * is a better starting value than UTC at the one moment the user has said they
 * want notifications and has not yet been asked where they are. Any later
 * change is theirs.
 */
function adoptDeviceZone(settings: Settings): Partial<Settings> {
  if (settings.timeZone !== 'UTC') return {};
  const device = deviceTimeZone();
  return device && device !== 'UTC' ? { timeZone: device } : {};
}

/* --- small shared pieces ----------------------------------------------------- */

function SubField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="mb-2 text-text-secondary" style={{ fontSize: '13px', fontWeight: 500 }}>
        {label}
      </p>
      {children}
    </div>
  );
}

/** A quiet explanatory line. Never an alarm colour — none of this is an error. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 text-text-tertiary" style={{ fontSize: '12px', lineHeight: 1.4 }}>
      {children}
    </p>
  );
}

/**
 * A native select in the app's well. The same control `SettingsSheet`'s working
 * hours use, and for the same reasons: keyboard, screen reader and the mobile
 * picker all work without this file reimplementing any of them.
 */
function Select({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label?: string;
  value: string;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange(value: string): void;
}) {
  return (
    <div>
      {label !== undefined && (
        <label
          htmlFor={id}
          className="mb-2 block text-text-secondary"
          style={{ fontSize: '13px', fontWeight: 500 }}
        >
          {label}
        </label>
      )}
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-control border-0 bg-surface-2 px-4 text-text disabled:opacity-60"
        style={{ height: 'var(--button-height)', outlineOffset: '0px' }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
