import { useEffect, useState } from 'react';
import type { Context, PlannerEvent } from '../../../shared/types';
import { localDateKey } from '../../../shared/events';
import { createEventSpec, deleteEventSpec, updateEventSpec, useStore } from '../../lib/store';
import { Button } from '../ui/Button';
import { Dialog, DialogHeader } from '../ui/Dialog';
import { Input } from '../ui/Input';

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function EventEditor({ open, onClose, context, event }: {
  open: boolean; onClose(): void; context: Context; event?: PlannerEvent | undefined;
}) {
  const today = new Date();
  const [name, setName] = useState('');
  const [weekdays, setWeekdays] = useState<number[]>([today.getDay()]);
  const [frequencyWeeks, setFrequency] = useState<1 | 2 | 4>(1);
  const [startsOn, setStartsOn] = useState(localDateKey(Date.now()));
  const [startMinutes, setStartMinutes] = useState(12 * 60);
  const [durationMinutes, setDuration] = useState(60);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(event?.name ?? '');
    setWeekdays(event?.weekdays ?? [new Date().getDay()]);
    setFrequency(event?.frequencyWeeks ?? 1);
    setStartsOn(event?.startsOn ?? localDateKey(Date.now()));
    setStartMinutes(event?.startMinutes ?? 12 * 60);
    setDuration(event?.durationMinutes ?? 60);
    setError(null);
  }, [open, event]);

  function save() {
    const trimmed = name.trim();
    if (!trimmed) return setError('An event needs a name.');
    if (weekdays.length === 0) return setError('Choose at least one day.');
    const draft = { context, name: trimmed, weekdays, frequencyWeeks, startsOn, startMinutes, durationMinutes };
    const store = useStore.getState();
    void store.mutate(event ? updateEventSpec(event, draft) : createEventSpec(draft));
    onClose();
  }

  const clock = `${String(Math.floor(startMinutes / 60)).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;

  return (
    <Dialog open={open} onClose={onClose} title={event ? event.name : 'New Event'}>
      <DialogHeader title={event ? event.name : 'New Event'} onClose={onClose} />
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Input label="Name" value={name} maxLength={120} error={error} onChange={(e) => { setName(e.target.value); setError(null); }} />
        <div className="mt-4">
          <span className="mb-2 block text-text-secondary" style={{ fontSize: 13, fontWeight: 500 }}>Occurs on</span>
          <div className="grid grid-cols-7 gap-2">
            {DAYS.map((label, day) => {
              const selected = weekdays.includes(day);
              return <button key={day} type="button" aria-label={['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day]} aria-pressed={selected}
                onClick={() => setWeekdays((was) => selected ? was.filter((value) => value !== day) : [...was, day].sort())}
                className={`pressable aspect-square rounded-pill text-meta ${selected ? 'bg-accent text-on-accent' : 'bg-surface-2 text-text-secondary'}`}>{label}</button>;
            })}
          </div>
        </div>
        <label className="mt-4 block text-text-secondary" style={{ fontSize: 13, fontWeight: 500 }}>
          Repeats
          <select value={frequencyWeeks} onChange={(e) => setFrequency(Number(e.target.value) as 1 | 2 | 4)}
            className="mt-1 block w-full rounded-control border-0 bg-surface-2 px-3 text-text" style={{ height: 'var(--tap-target)' }}>
            <option value={1}>Every week</option><option value={2}>Every 2 weeks</option><option value={4}>Every 4 weeks</option>
          </select>
        </label>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Input label="Starting" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          <Input label="Time" type="time" step={900} value={clock} onChange={(e) => { const [h,m] = e.target.value.split(':').map(Number); setStartMinutes(h * 60 + m); }} />
        </div>
        <label className="mt-4 block text-text-secondary" style={{ fontSize: 13, fontWeight: 500 }}>
          Duration
          <select value={durationMinutes} onChange={(e) => setDuration(Number(e.target.value))}
            className="mt-1 block w-full rounded-control border-0 bg-surface-2 px-3 text-text" style={{ height: 'var(--tap-target)' }}>
            {[15,30,45,60,90,120,180,240].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} min` : `${minutes / 60} hr${minutes === 60 ? '' : 's'}`}</option>)}
          </select>
        </label>
        <div className="mt-6"><Button type="submit" fullWidth>{event ? 'Save' : 'Add event'}</Button></div>
      </form>
      {event && <div className="mt-5 pt-3" style={{ borderTop: 'var(--hairline-width) solid var(--hairline)' }}>
        <Button variant="destructive" onClick={() => { void useStore.getState().mutate(deleteEventSpec(event)); onClose(); }}>Delete event</Button>
      </div>}
    </Dialog>
  );
}
