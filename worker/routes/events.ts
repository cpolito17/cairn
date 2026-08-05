import type { ColumnPatch, Env } from '../db';
import { deleteEvent, insertEvent, selectEvent, updateEvent } from '../db';
import { apiError, json, noContent } from '../http';
import { absent, BadRequest, jsonBody, requiredContext, requiredName } from '../validate';
import { isValidDurationMinutes, SCHEDULE_STEP_MINUTES } from '../../shared/types';

function weekdays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new BadRequest('weekdays must contain at least one day');
  const days = [...new Set(value)];
  if (days.some((day) => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6)) {
    throw new BadRequest('weekdays must contain numbers from 0 to 6');
  }
  return (days as number[]).sort((a, b) => a - b);
}

function frequency(value: unknown): 1 | 2 | 4 {
  if (value !== 1 && value !== 2 && value !== 4) throw new BadRequest('frequencyWeeks must be 1, 2, or 4');
  return value;
}

function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequest('startsOn must be YYYY-MM-DD');
  return value;
}

function start(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= 1440 || (value as number) % SCHEDULE_STEP_MINUTES !== 0) {
    throw new BadRequest('startMinutes must be a 15-minute step within the day');
  }
  return value as number;
}

function duration(value: unknown): number {
  if (!isValidDurationMinutes(value)) throw new BadRequest('durationMinutes must be a valid 15-minute duration');
  return value;
}

async function create(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);
  return json(await insertEvent(env.DB, {
    context: requiredContext(body.context), name: requiredName(body.name, 120, 'name'),
    weekdays: weekdays(body.weekdays), frequencyWeeks: frequency(body.frequencyWeeks),
    startsOn: date(body.startsOn), startMinutes: start(body.startMinutes), durationMinutes: duration(body.durationMinutes),
  }), { status: 201 });
}

async function patch(request: Request, env: Env, id: string): Promise<Response> {
  const body = await jsonBody(request);
  const columns: ColumnPatch = {};
  if (!absent(body, 'name')) columns.name = requiredName(body.name, 120, 'name');
  if (!absent(body, 'weekdays')) columns.weekdays = JSON.stringify(weekdays(body.weekdays));
  if (!absent(body, 'frequencyWeeks')) columns.frequency_weeks = frequency(body.frequencyWeeks);
  if (!absent(body, 'startsOn')) columns.starts_on = date(body.startsOn);
  if (!absent(body, 'startMinutes')) columns.start_minutes = start(body.startMinutes);
  if (!absent(body, 'durationMinutes')) columns.duration_minutes = duration(body.durationMinutes);
  if (Object.keys(columns).length === 0) {
    const existing = await selectEvent(env.DB, id);
    return existing ? json(existing) : apiError('event not found', 404);
  }
  const event = await updateEvent(env.DB, id, columns);
  return event ? json(event) : apiError('event not found', 404);
}

/**
 * The route is `/api/planner-events`, not the shorter `/api/events` this
 * started as. A bare `/events` (or `/api/events`) is exactly the shape a lot
 * of ad blockers and privacy extensions heuristically treat as an analytics
 * beacon (Segment, Amplitude, GA, and friends all use one), so it was getting
 * silently dropped client-side in normal browsing — never reaching the Worker
 * at all, which is why nothing showed up server-side to debug. The compound,
 * app-specific path is not a generic-enough shape for a blocklist to guess.
 */
export function handleEvents(request: Request, env: Env, pathname: string): Promise<Response> | null {
  if (pathname === '/api/planner-events') {
    return request.method === 'POST' ? create(request, env) : Promise.resolve(apiError('Method not allowed', 405));
  }
  const match = /^\/api\/planner-events\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  if (request.method === 'PATCH') return patch(request, env, id);
  if (request.method === 'DELETE') return deleteEvent(env.DB, id).then((ok) => ok ? noContent() : apiError('event not found', 404));
  return Promise.resolve(apiError('Method not allowed', 405));
}
