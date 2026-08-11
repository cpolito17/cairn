/**
 * The demo world, built fresh from the clock.
 *
 * Every date in here is *relative*: due dates are offsets from today, blocks
 * are offsets from the Sunday of the current week, and completions are so many
 * days ago. Someone opening the demo a year from now gets the same week —
 * scheduled today, overdue since Tuesday, the now line running through a block
 * that is already underway — without a single stored timestamp going stale.
 *
 * The content is Odysseus's, and it is deliberately a *complete* tour: every
 * task field the app has, dependency chains several links deep with fan-out,
 * tasks already completed so the released-gate treatment has something to show,
 * blocks on the grid (including a completed one, a duration-less one, and one
 * on a gated task), recurring events in both contexts, and an archived board.
 *
 * Nothing here is validated at runtime, because nothing here is untrusted — it
 * is a constant this module writes and the demo backend reads. The shapes still
 * have to be *legal*, though: times land on the 15-minute grid, blocks stay
 * inside their local day, `dueTime` never appears without a `dueDate`, and a
 * prerequisite is always another task on the same board.
 */

import { midpoint } from '../../../shared/order';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import { startOfLocalDay } from '../../../shared/schedule';
import type {
  AppState,
  Board,
  BoardAccent,
  Context,
  Difficulty,
  PlannerEvent,
  Task,
} from '../../../shared/types';

/* --- the clock ------------------------------------------------------------- */

/** `n` local days from `from`, via the date accessors so DST cannot shift it. */
function addDays(from: number, n: number): number {
  const date = new Date(from);
  date.setDate(date.getDate() + n);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** `YYYY-MM-DD` for a local day start. */
function dayKey(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `HH:MM` (always a multiple of 15) as minutes from midnight. */
function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/* --- the seed DSL ---------------------------------------------------------- */

interface SeedTask {
  /** Unique within its board. Becomes the task id, and what `after` names. */
  key: string;
  name: string;
  notes?: string;
  /** Due date as an offset in days from today. */
  due?: number;
  /** `HH:MM`. Only legal alongside `due`. */
  dueTime?: string;
  /** Committed length in minutes: a multiple of 15 in [15, 720]. */
  minutes?: number;
  /**
   * A block, as `[day, 'HH:MM']`. The day is an offset from this week's Sunday,
   * or `null` for "today" — the one anchor that is not the week's Sunday, so a
   * demo opened on any weekday still has blocks running under the now line.
   */
  sched?: [number | null, string];
  difficulty?: Difficulty;
  priority?: true;
  /** The hand-asserted "I am stuck" flag — independent of `after`. */
  blocked?: true;
  /**
   * The prerequisite's key, or several, on this same board. A task waits for
   * *all* of them.
   */
  after?: string | string[];
  /** Completed this many days ago. */
  done?: number;
}

/** One prerequisite key or several, as a list. */
function toList(after: string | string[]): string[] {
  return Array.isArray(after) ? after : [after];
}

interface SeedBoard {
  key: string;
  context: Context;
  name: string;
  description?: string;
  accent?: BoardAccent;
  /** Archived this many days ago. */
  archived?: number;
  tasks: SeedTask[];
}

interface SeedEvent {
  key: string;
  context: Context;
  name: string;
  /** Sunday = 0. */
  weekdays: number[];
  frequencyWeeks: 1 | 2 | 4;
  /** `HH:MM`. */
  at: string;
  minutes: number;
}

/* --- the content ----------------------------------------------------------- */

const BOARDS: SeedBoard[] = [
  {
    key: 'voyage',
    context: 'work',
    name: 'The Long Way Home',
    description: 'Ten years. One boat. Zero shortcuts.',
    accent: 'blue',
    tasks: [
      {
        key: 'circe',
        name: "Spend one year on Circe's island (regrettably)",
        notes: 'The crew were pigs for part of it. This is not a metaphor.',
        difficulty: 2,
        minutes: 480,
        sched: [-30, '09:00'],
        done: 32,
      },
      {
        key: 'underworld',
        name: 'Visit the underworld to ask for directions',
        after: 'circe',
        difficulty: 5,
        priority: true,
        minutes: 360,
        sched: [-24, '10:00'],
        done: 26,
      },
      {
        key: 'cattle',
        name: 'Personally abstain from the cattle of Helios',
        after: 'underworld',
        difficulty: 4,
        minutes: 240,
        sched: [-18, '11:00'],
        done: 20,
      },
      {
        key: 'charybdis',
        name: 'Get past Charybdis on the second attempt',
        after: 'cattle',
        difficulty: 5,
        minutes: 120,
        sched: [-15, '13:00'],
        done: 17,
      },
      {
        key: 'raft',
        name: "Build a raft from Calypso's timber",
        notes: 'Seven years of hospitality. Four days of carpentry.',
        difficulty: 4,
        minutes: 240,
        sched: [-4, '09:00'],
        done: 11,
      },
      {
        key: 'storm',
        name: "Survive Poseidon's personal weather event",
        after: 'raft',
        difficulty: 5,
        priority: true,
        minutes: 180,
        sched: [-3, '10:00'],
        done: 10,
      },
      {
        key: 'scheria',
        name: 'Wash ashore at Scheria with minimal dignity intact',
        notes: 'Nausicaa did the laundry. Do not bring this up again.',
        after: 'storm',
        difficulty: 2,
        done: 8,
      },
      {
        key: 'charm',
        name: 'Charm the Phaeacians over dinner',
        after: 'scheria',
        difficulty: 3,
        minutes: 120,
        sched: [-2, '18:00'],
        done: 6,
      },
      {
        key: 'story',
        name: 'Tell the entire story at said dinner (unabridged)',
        notes: 'Four books. They asked.',
        after: 'charm',
        difficulty: 1,
        minutes: 720,
        sched: [-1, '09:00'],
        done: 5,
      },
      {
        key: 'ship',
        name: 'Accept the Phaeacian ship and try not to cry',
        after: 'story',
        difficulty: 2,
        priority: true,
        minutes: 90,
        due: 0,
        dueTime: '09:00',
        sched: [null, '09:00'],
      },
      {
        key: 'nap',
        name: 'Sleep through the entire voyage home',
        notes: 'Twenty years of insomnia, cashed in at once.',
        after: 'ship',
        difficulty: 1,
        minutes: 480,
        sched: [5, '09:00'],
      },
      {
        key: 'crate',
        name: 'Inventory the Phaeacian gifts before the crew sees them',
        after: 'ship',
        difficulty: 3,
        minutes: 45,
        due: 2,
      },
      {
        key: 'ithaca',
        name: 'Wake up on a beach and fail to recognise Ithaca',
        after: 'nap',
        sched: [6, '08:00'],
      },
      {
        key: 'athena',
        name: 'Get gently mocked by Athena',
        notes: '"Still lying, I see." Fair.',
        after: 'ithaca',
        difficulty: 2,
        due: 5,
      },
      {
        key: 'phaeacians',
        name: "Return the Phaeacians' calls",
        notes: 'Their ship has been turned into a rock. Awkward.',
        blocked: true,
        difficulty: 3,
      },
      { key: 'log', name: "Update the ship's log (years three through ten)" },
    ],
  },

  {
    key: 'crew',
    context: 'work',
    name: 'Crew Management',
    description: 'Headcount: 600. Retention: poor.',
    accent: 'coral',
    tasks: [
      { key: 'lotus', name: 'Extract three men from the lotus café', difficulty: 3, done: 9 },
      {
        key: 'brief',
        name: 'Brief the crew: do NOT eat the cattle of Helios',
        difficulty: 2,
        minutes: 30,
        done: 7,
      },
      {
        key: 'bag',
        name: 'Explain that the bag of winds is not a snack',
        notes: 'They opened it in sight of home. Twice, if you count the second attempt.',
        priority: true,
        difficulty: 2,
        done: 7,
      },
      { key: 'wax', name: 'Distribute earwax (industrial quantity)', minutes: 60, done: 6 },
      {
        key: 'eury',
        name: 'Performance review: Eurylochus',
        notes: 'Points of discussion: the mutiny, the cattle, the other mutiny.',
        after: 'brief',
        difficulty: 4,
        priority: true,
        minutes: 45,
        due: 0,
        dueTime: '15:00',
        sched: [null, '15:00'],
      },
      {
        key: 'helios',
        name: 'Investigate the missing cattle',
        after: 'eury',
        difficulty: 3,
        due: 2,
        minutes: 120,
      },
      {
        key: 'mast',
        name: 'Get tied to the mast — book the rigging team',
        after: 'wax',
        difficulty: 3,
        minutes: 90,
        sched: [3, '11:00'],
      },
      {
        key: 'sirens',
        name: 'Listen to the Sirens (research purposes)',
        notes: 'Purely professional interest in the singing.',
        after: 'mast',
        difficulty: 5,
        priority: true,
        minutes: 60,
      },
      {
        key: 'scylla',
        name: 'Choose: six men, or the whole ship',
        notes: 'There is no third option. Stop looking for one.',
        blocked: true,
        difficulty: 5,
      },
      { key: 'letters', name: 'Draft condolence letters (bulk)', minutes: 240, difficulty: 2, due: 9 },
      { key: 'recruit', name: 'Recruit replacement crew' },
    ],
  },

  {
    key: 'ithaca',
    context: 'work',
    name: 'Ithaca Governance (Deferred)',
    description: 'Twenty years of unopened correspondence.',
    accent: 'amber',
    tasks: [
      {
        key: 'treasury',
        name: 'Audit the treasury',
        notes: 'Estimate: 108 men, twenty years, unlimited wine.',
        priority: true,
        difficulty: 4,
        minutes: 120,
        due: -3,
      },
      { key: 'post', name: 'Answer twenty years of correspondence', minutes: 720, difficulty: 3, due: 14 },
      {
        key: 'swineherd',
        name: 'Reappoint the swineherd who never gave up on me',
        priority: true,
        difficulty: 1,
        done: 1,
      },
      {
        key: 'taphians',
        name: 'Renegotiate tribute with the Taphians',
        difficulty: 3,
        minutes: 60,
        due: 6,
        sched: [4, '13:30'],
      },
      {
        key: 'homer',
        name: 'Approve the official version of the war',
        notes: 'Homer is handling it. Mostly accurate.',
        difficulty: 1,
        due: 11,
      },
      { key: 'poseidon', name: 'Make peace with Poseidon', blocked: true, difficulty: 5 },
    ],
  },

  {
    key: 'homecoming',
    context: 'personal',
    name: 'Homecoming',
    description: 'Twenty years late. Bring a good excuse.',
    accent: 'emerald',
    tasks: [
      {
        key: 'disguise',
        name: "Accept Athena's beggar disguise",
        notes: 'She insists the rags are load-bearing to the plan.',
        difficulty: 2,
        minutes: 30,
        done: 0,
      },
      {
        key: 'eumaeus',
        name: "Crash at Eumaeus' hut and eat everything",
        after: 'disguise',
        difficulty: 1,
        minutes: 105,
        sched: [null, '12:15'],
      },
      {
        key: 'scout',
        name: 'Scout the palace from the servants entrance',
        after: 'disguise',
        difficulty: 3,
        minutes: 60,
        due: 1,
      },
      {
        key: 'telemachus',
        name: 'Reveal identity to Telemachus (dramatically)',
        notes: 'He was an infant. Lead with something warmer than the beard.',
        after: 'eumaeus',
        difficulty: 3,
        priority: true,
        minutes: 60,
        due: 0,
        dueTime: '19:00',
      },
      { key: 'plan', name: 'Plan the suitor situation with Telemachus', after: 'telemachus', difficulty: 4, minutes: 90 },
      {
        key: 'bed',
        name: 'Prove identity to Penelope via bed trivia',
        notes: 'The olive tree. Only two people alive know about the olive tree.',
        after: 'plan',
        difficulty: 5,
        priority: true,
        minutes: 30,
      },
      { key: 'laertes', name: 'Tell Dad I am alive', after: 'bed', difficulty: 2, due: 3 },
      {
        key: 'dog',
        name: 'Be recognised by the dog',
        notes: 'Argos. Twenty years. He waited.',
        difficulty: 1,
        due: 0,
      },
      {
        key: 'fisherman',
        name: 'Bribe a fisherman for a lift to shore',
        difficulty: 2,
        minutes: 45,
        sched: [null, '07:00'],
        done: 0,
      },
      { key: 'fog', name: 'Ask Athena for the concealing fog', difficulty: 3, minutes: 30, done: 2 },
      { key: 'funeral', name: 'Cancel my own funeral' },
    ],
  },

  {
    key: 'suitors',
    context: 'personal',
    name: 'The Suitor Problem',
    description: '108 house guests. None invited.',
    accent: 'rose',
    tasks: [
      {
        key: 'watch',
        name: 'Watch the house from the treeline',
        difficulty: 2,
        minutes: 120,
        sched: [-12, '19:00'],
        done: 14,
      },
      { key: 'count', name: 'Count the suitors (again)', minutes: 30, difficulty: 1, done: 2 },
      {
        key: 'hide',
        name: 'Hide every weapon in the hall',
        notes: 'Tell them it is the smoke. They will believe it is the smoke.',
        after: 'count',
        priority: true,
        difficulty: 4,
        minutes: 120,
        due: -1,
        sched: [5, '09:00'],
      },
      {
        key: 'bow',
        name: 'Win the bow-stringing contest',
        after: 'hide',
        difficulty: 5,
        priority: true,
        minutes: 15,
      },
      { key: 'doors', name: 'Lock the doors', after: 'hide', difficulty: 1, minutes: 15 },
      {
        key: 'deal',
        name: 'Deal with the suitors',
        notes: 'Budget the whole afternoon.',
        // Two prerequisites, and the reason the demo has a fan-in to draw:
        // the contest has to be won *and* the doors shut before this starts.
        after: ['bow', 'doors'],
        difficulty: 5,
        minutes: 240,
        sched: [6, '14:00'],
      },
      { key: 'clean', name: 'Clean the hall. Thoroughly.', after: 'deal', difficulty: 3, minutes: 180 },
      {
        key: 'families',
        name: "Negotiate with the suitors' families",
        notes: 'Athena has offered to mediate, which is generous of her.',
        after: 'clean',
        blocked: true,
        difficulty: 5,
      },
      {
        key: 'case',
        name: 'Case the great hall during dinner',
        notes: 'They do not look up. Not once, in an entire evening.',
        difficulty: 3,
        minutes: 60,
        done: 3,
      },
      { key: 'names', name: 'Bribe the herald for a list of names', difficulty: 2, minutes: 30, done: 4 },
      { key: 'wine', name: 'Water down the wine (quietly)', difficulty: 4, minutes: 45, done: 1 },
      { key: 'shroud', name: "Return Penelope's shroud thread" },
      { key: 'housekeeper', name: 'Apologise to the housekeeper', difficulty: 2, due: 4 },
    ],
  },

  {
    key: 'maintenance',
    context: 'personal',
    name: 'Personal Maintenance',
    description: 'Twenty years at sea leaves marks.',
    accent: 'violet',
    tasks: [
      {
        key: 'crewletters',
        name: 'Write to the families of the crew',
        notes: 'Six hundred names. Start with the ones you remember.',
        difficulty: 5,
        minutes: 360,
        sched: [-26, '09:00'],
        done: 28,
      },
      {
        key: 'salt',
        name: 'Rinse twenty years of salt out of everything',
        difficulty: 1,
        minutes: 240,
        sched: [-20, '10:00'],
        done: 22,
      },
      { key: 'beard', name: 'Haircut and beard triage', minutes: 60, difficulty: 2, done: 4 },
      {
        key: 'basket',
        name: "Return Nausicaa's laundry basket",
        priority: true,
        minutes: 30,
        due: 1,
      },
      {
        key: 'therapy',
        name: 'Therapy: the Cyclops incident',
        notes: 'Stop introducing yourself as "Nobody". It is a whole thing.',
        difficulty: 4,
        minutes: 60,
        due: 0,
        dueTime: '17:00',
        sched: [null, '17:00'],
      },
      { key: 'sleep', name: 'Sleep for twelve consecutive hours', minutes: 720, difficulty: 1, sched: [6, '09:00'] },
      {
        key: 'shorter',
        name: 'Draft a shorter version of the raft story',
        notes: 'Everyone has heard it. Twice.',
        sched: [2, '16:00'],
      },
      { key: 'parties', name: 'Stop telling the raft story at parties', difficulty: 5 },
      { key: 'sandals', name: 'Acquire sandals that are not made of raft', difficulty: 1, minutes: 30, done: 3 },
      {
        key: 'bed',
        name: 'Sleep in a bed that is not moving',
        difficulty: 2,
        minutes: 480,
        sched: [1, '13:00'],
        done: 5,
      },
      { key: 'sail', name: 'Learn to sail somewhere in under ten years', blocked: true, difficulty: 4 },
    ],
  },

  {
    key: 'ogygia',
    context: 'personal',
    name: 'Ogygia (Years One to Seven)',
    description: 'Seven years. Excellent weather. Held against my will.',
    accent: 'cyan',
    archived: 12,
    tasks: [
      { key: 'decline', name: 'Decline immortality', difficulty: 5, done: 60 },
      { key: 'again', name: 'Decline immortality again', after: 'decline', difficulty: 5, done: 52 },
      {
        key: 'shore',
        name: 'Weep at the shoreline (daily, standing item)',
        notes: 'Hermes says this was noted in the minutes.',
        difficulty: 1,
        done: 44,
      },
      { key: 'timber', name: 'Negotiate for timber and an axe', after: 'again', difficulty: 3, done: 38 },
      { key: 'farewell', name: 'Say a civil goodbye', after: 'timber', difficulty: 4, done: 35 },
    ],
  },

  {
    key: 'troy',
    context: 'work',
    name: 'Troy (Years One to Ten)',
    description: 'Closed out. Filed under "worked, eventually".',
    accent: 'teal',
    archived: 26,
    tasks: [
      { key: 'siege', name: 'Besiege a city for nine years', difficulty: 5, done: 40 },
      { key: 'horse', name: 'Pitch the horse idea to a skeptical room', difficulty: 4, priority: true, done: 36 },
      { key: 'build', name: 'Build the horse', after: 'horse', difficulty: 3, minutes: 720, done: 34 },
      { key: 'inside', name: 'Sit inside the horse, quietly', after: 'build', difficulty: 2, done: 33 },
      { key: 'sack', name: 'Sack the city', after: 'inside', difficulty: 5, done: 32 },
      { key: 'leave', name: 'Leave promptly and thank the gods', after: 'sack', difficulty: 1, priority: true },
    ],
  },
];

const EVENTS: SeedEvent[] = [
  {
    key: 'council',
    context: 'work',
    name: 'Council of the Gods (observer)',
    weekdays: [1],
    frequencyWeeks: 1,
    at: '10:00',
    minutes: 60,
  },
  {
    key: 'sacrifice',
    context: 'work',
    name: 'Sacrifice to Poseidon',
    weekdays: [3],
    frequencyWeeks: 2,
    at: '07:00',
    minutes: 30,
  },
  {
    key: 'loom',
    context: 'personal',
    name: 'Unravel the shroud',
    weekdays: [1, 2, 3, 4, 5],
    frequencyWeeks: 1,
    at: '21:00',
    minutes: 60,
  },
  {
    key: 'supper',
    context: 'personal',
    name: 'Supper with the swineherd',
    weekdays: [0],
    frequencyWeeks: 1,
    at: '18:00',
    minutes: 90,
  },
];

/* --- assembly -------------------------------------------------------------- */

/**
 * Build the whole demo world against the current clock.
 *
 * Called once when the demo starts, and again by "Reset demo" — so every field
 * that depends on today is computed here rather than captured at module load,
 * where a tab left open overnight would leave it a day stale.
 */
export function buildDemoState(now = Date.now()): AppState {
  const today = startOfLocalDay(now);
  // The Sunday that starts the visible week — the anchor every block hangs off,
  // so the grid is populated whichever day of the week the demo is opened.
  const weekStart = addDays(today, -new Date(today).getDay());

  const boards: Board[] = [];
  const tasks: Task[] = [];

  let boardPosition: string | null = null;

  for (const seed of BOARDS) {
    boardPosition = midpoint(boardPosition, null);
    boards.push({
      id: `demo-board-${seed.key}`,
      context: seed.context,
      name: seed.name,
      description: seed.description ?? null,
      accent: seed.accent ?? null,
      position: boardPosition,
      archivedAt: seed.archived === undefined ? null : addDays(today, -seed.archived) + 36e5 * 10,
      createdAt: addDays(today, -120),
      updatedAt: addDays(today, -1),
    });

    let taskPosition: string | null = null;

    for (const task of seed.tasks) {
      taskPosition = midpoint(taskPosition, null);

      const scheduledAt =
        task.sched === undefined
          ? null
          : (task.sched[0] === null ? today : addDays(weekStart, task.sched[0])) +
            minutesOf(task.sched[1]) * 60_000;

      tasks.push({
        id: `demo-task-${seed.key}-${task.key}`,
        boardId: `demo-board-${seed.key}`,
        name: task.name,
        notes: task.notes ?? null,
        dueDate: task.due === undefined ? null : dayKey(addDays(today, task.due)),
        dueTime: task.dueTime ?? null,
        durationMinutes: task.minutes ?? null,
        scheduledAt,
        difficulty: task.difficulty ?? null,
        priority: task.priority ?? false,
        blocked: task.blocked ?? false,
        dependsOn:
          task.after === undefined
            ? []
            : toList(task.after).map((after) => `demo-task-${seed.key}-${after}`),
        position: taskPosition,
        createdAt: addDays(today, -90),
        // Completions land mid-morning of their day rather than at midnight, so
        // the Completed group's "most recently completed first" order is the
        // order the story happened in.
        completedAt: task.done === undefined ? null : addDays(today, -task.done) + 36e5 * 11,
        updatedAt: addDays(today, -1),
      });
    }
  }

  const events: PlannerEvent[] = EVENTS.map((event) => ({
    id: `demo-event-${event.key}`,
    context: event.context,
    name: event.name,
    weekdays: event.weekdays,
    frequencyWeeks: event.frequencyWeeks,
    // Four whole weeks back, on a Sunday: divisible by every frequency the
    // model allows, so a fortnightly series always lands on the visible week.
    startsOn: dayKey(addDays(weekStart, -28)),
    startMinutes: minutesOf(event.at),
    durationMinutes: event.minutes,
    createdAt: addDays(today, -60),
    updatedAt: addDays(today, -60),
  }));

  return {
    boards,
    tasks,
    events,
    settings: { ...DEFAULT_SETTINGS, workdayStartMinutes: 480, workdayEndMinutes: 1080 },
  };
}
