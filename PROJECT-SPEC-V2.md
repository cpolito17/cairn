# CAIRN — Project Spec, V2

## How to use this document

This is the complete specification for V2. It **supplements** `PROJECT-SPEC.md`
rather than replacing it: everything in v1 still holds except where a section
below says otherwise. Where the two disagree, this document wins.

Read it fully before planning anything. It describes **what** to build and
**why**. File structure, module boundaries, and internal architecture are yours
to decide except where an issue fixes them.

Build only what is specified here. Anything in §11 is designed-for and
explicitly not built now. Verify against the acceptance criteria in each issue,
not against your own explanation of the work.

**Sections of `PROJECT-SPEC.md` this document supersedes:** §6.2 (contexts move
out of the header), §6.4 (duration becomes minutes; `scheduledAt` is added),
§6.7 (Up Next becomes schedule-aware), §7.2 (the Up Next ranking is replaced),
§9.2 (the app shell gains a view selector and a settings sheet), and §10 (the
four-theme cap and the "no calendar" posture). Everything else — the quality
bar in §2, the constraints in §5, the design system in §8, the motion doctrine
in §8.5 — applies unchanged and is binding on all V2 work.

---

## 1. What V2 is

V1 made Cairn a very good list. It tells you what exists and how far along a
project is. It does not tell you **when you are going to do any of it.**

V2 adds the missing half:

- **The Planner** — a schedule view of the week that tasks are dragged into.
  This is the feature the release exists for. It turns a list of intentions
  into a plan with hours attached, and it is what makes the duration field
  Cairn has been collecting since v1 finally mean something.
- **Blockers** — the dependency structure V1 records but never shows, drawn as
  a node tree per board.
- **A three-way view selector** in the place the Personal/Work control used to
  sit, and the context switch moved into a proper settings sheet.

The quality bar does not move. §2 of `PROJECT-SPEC.md` still governs: instant on
pointer-down, interruptible mid-motion, well under a second on a cold mobile
connection. The Planner is a large surface and it is not permitted to be a slow
one.

---

## 2. Decisions already made

These are settled. They were reached deliberately during V2 planning. Do not
re-litigate them.

| Decision | Rationale | Cheap to change later? |
|---|---|---|
| **A task has at most one scheduled block.** Work that needs two sittings is two tasks | Keeps task↔block 1:1, which is what lets a resize on the grid write straight back to the task's duration with no reconciliation | No — foundational to the schema |
| **`scheduledAt` is a new field, distinct from both `dueDate` and `completedAt`** | Three different questions: when it is due, when you plan to do it, when you did it. Conflating any two breaks the other | No |
| **Scheduling is reachable only by dragging onto the grid (or its keyboard equivalent).** No scheduling field in the composer | The composer is for what a task *is*; the Planner is for when it happens. A date-time picker in the composer would duplicate the grid badly | Yes |
| **Due dates never auto-place a task on the grid** | A deadline is not a plan. Auto-placing would fill the week with blocks the user never agreed to | Yes |
| **Duration becomes an integer count of minutes**, a multiple of 15, replacing the fixed string set | A 15-minute resize grid cannot be expressed in a six-value enum | No |
| **`half-day` is removed and merges into `4h` (240 minutes)** | The two were never distinguishable in practice, and a preset list with a redundant entry is a list people stop reading | No |
| **The Planner is per-context, and renders the other context's blocks as anonymous ghosts** | Separating Personal and Work exists so a doctor's appointment does not sit in a work review. Ghosting the *time* without the *name* keeps that intact while stopping the grid from lying about a Tuesday that only has one of you in it | Moderate |
| **Ghost blocks carry no task name, no board, and no metadata** — a muted band reading "Busy" | The whole value of the separation is that the other context's content stays private. A ghost that leaks its name is not a ghost | No |
| **All scheduling is local wall-clock time. No timezone is stored** | One user, one clock. A timezone column would be inert data with a migration cost | Moderate |
| **Overlapping blocks are allowed**, packed into side-by-side lanes | Refusing an overlap means refusing to record a real double-booking, which is exactly when the user most needs to see it | Yes |
| ~~**The Blockers graph is a forest of trees, not a general DAG**~~ | `dependsOn` allowed at most one prerequisite per task, so every node had at most one edge leaving it to the left. **Revised — see §14.** A task may now wait on several, which makes it a real DAG; still no graph library | Yes — and it was |
| **Blockers uses the neutral ramp with accent for open nodes.** Not red-for-blocked, green-for-done | §8.2 reserves `--negative` and `--positive` for semantics and forbids decorative use. A healthy dependency chain is the normal state; rendering it in alarm colour trains the user to ignore alarm colour | Yes |
| **The year view is a workload heat map**, not one dot per task | A dot grid cannot be dropped into and answers no question. Density per day answers "when am I slammed", which is the only thing a year of a planner is good for | Yes |
| **Month and year views are read-and-navigate only.** Drag scheduling happens in week and day views | Dropping onto a month cell has no time component, so it would need a second disambiguating step. Clicking through to the week is that step, and it is one the user already understands | Yes |
| **Up Next becomes schedule-aware**, with overdue always first | Once a schedule exists, "what now?" is answered by the schedule. Two competing answers on one screen is worse than either alone | Yes |
| **Eight themes**, chosen from a dropdown rather than cycled | Four was already at the limit of what a cycle can address. Eight needs a list | Yes |
| **Settings persist server-side; theme stays in localStorage** | Working hours and planner defaults should follow the user to their phone. Theme must apply before first paint, which rules out a fetch | Yes |
| **`GET /api/state` continues to return the whole world, now including settings** | Still one user and a small dataset. One round trip on cold load is the §2 bar; a second request for five settings values is not defensible | Yes |
| **No recurring tasks, no reminders, no offline queue** | Unchanged from v1 §3. The Planner does not soften any of these | — |

---

## 3. Data model changes

### 3.1 Tasks

Two changes to `tasks`, one of them destructive.

| Field | Change |
|---|---|
| `duration` | **Removed.** The `'15m' \| '30m' \| '1h' \| '2h' \| '4h' \| 'half-day'` string set is gone |
| `durationMinutes` | **New.** `INTEGER`, nullable. A positive multiple of 15, from 15 to 720. Null means the user has not committed a length |
| `scheduledAt` | **New.** `INTEGER`, nullable. Epoch milliseconds, the local wall-clock start of the task's block. Null means unscheduled |

The migration maps the old values: `15m→15`, `30m→30`, `1h→60`, `2h→120`,
`4h→240`, `half-day→240`. It is a real data migration and it is one-way — write
it as its own migration file and apply it to the remote database before
deploying the Worker, per `docs/DEPLOY.md`.

**Block validity, enforced by the Worker:**

- `durationMinutes` is null, or an integer multiple of 15 in `[15, 720]`.
- A block may not cross local midnight: `scheduledAt` plus the effective
  duration must land on the same local day it started. A request that would
  cross is a 400.
- `scheduledAt`, when set, is snapped to the 15-minute grid by the client. The
  Worker rejects an unsnapped value rather than silently rounding it — a
  server that quietly moves a block is a server the client's optimistic state
  disagrees with.

**A scheduled task with a null duration** renders as a 30-minute block with a
dotted outline: scheduled, length not yet committed. Dropping does not invent a
duration; only resizing sets one.

**Completion does not clear the block.** A completed task keeps its
`scheduledAt` and stays on the grid, greyed and struck through — it is the
record of when the work actually happened. Deleting the task removes it.

**Moving a task between boards does not clear the block.** Unlike `dependsOn`,
a schedule is not scoped to a board.

### 3.2 Settings

A new single-row key/value table. One key, `settings`, holding a JSON document:

```ts
interface Settings {
  /** Minutes from local midnight. Default 540 (9:00 AM). */
  workdayStartMinutes: number;
  /** Minutes from local midnight. Default 1020 (5:00 PM). Must exceed start. */
  workdayEndMinutes: number;
  /** Default 'week'. */
  plannerView: 'week' | 'month' | 'year';
  /** Default false. */
  plannerGroupByBoard: boolean;
  /** Default 'dueDate'. */
  plannerSort: 'priority' | 'difficulty' | 'dueDate' | 'duration';
}
```

A JSON blob rather than a column per setting, deliberately: this is five values
read and written as a unit by one user, and every future planner preference
would otherwise be a migration. Validate the shape at the boundary like any
other untrusted input — a malformed stored document falls back to defaults
rather than breaking the load.

`GET /api/state` returns `{ boards, tasks, settings }`. Settings are written
with `PUT /api/settings`, which takes the whole document and returns what it
saved. Settings writes go through the same optimistic `mutate()` path as
everything else.

---

## 4. Navigation and the app shell

### 4.1 The view selector

The segmented control in the header centre changes what it controls. It is no
longer Personal/Work; it is **Boards · Blockers · Planner**.

Routes:

| Route | View | Selector shows |
|---|---|---|
| `/` | Context home (v1 §9.3) | Boards |
| `/board/:id` | Board detail (v1 §9.4) | Boards |
| `/archived` | Archived boards (v1 §9.8) | Boards |
| `/blockers` | Blockers | Blockers |
| `/planner` | Planner | Planner |

`/board/:id` and `/archived` sit *under* Boards: the selector stays visible and
keeps Boards selected, and the back affordance behaves exactly as it does
today. Selecting a view from `/board/:id` navigates to that view's root.

The thumb still slides by layout animation and still never teleports (§8.4).
On narrow viewports it still drops to a full-width second header line.

### 4.2 The context indicator

With the context switch moved into settings, the header must still say which
context is active — an invisible mode is a mode you file things into by
accident.

The brand slot carries it: the wordmark `Cairn` with the context name beneath
it at 12px/500 in `--text-secondary`. When the user is a level deep and the
wordmark is replaced by the back affordance, the context label stays. The
per-context theme already does part of this work; this makes it explicit.

### 4.3 The settings sheet

The gear's dropdown menu is replaced by a real settings surface: a bottom sheet
on narrow viewports, a centred modal on wide, per §8.4. Sections, in order:

1. **Context** — the Personal/Work segmented control, moved here intact.
   Switching closes the sheet, since the whole app changes underneath it.
2. **Theme** — a dropdown over the eight themes (§5), grouped Dark and Light.
   Per-context, as it is today.
3. **Working hours** — a start and an end, at 30-minute granularity. The end
   must be after the start; the control refuses rather than warns.
4. **Archived boards** — navigates to `/archived` and closes the sheet.
5. **Log out** — unchanged, still clears the session server-side.

---

## 5. Themes

Eight themes, four dark and four light. The four v1 themes are unchanged.

**The four new ones:**

| Theme | Register | Accent |
|---|---|---|
| **Monokai Dark** | The classic editor palette: warm near-black, off-white text | Monokai cyan `#66D9EF` |
| **Monokai Light** | The same palette inverted onto warm paper | Deep teal `#0F7285` |
| **Dusk** | Cool near-black with a violet cast | Violet `#A78BFA` |
| **Slate** | Cool light grey, the most neutral of the four | Indigo `#3B4CC0` |

Monokai's signature pink and green are used where they belong semantically —
`--negative` and `--positive` — which is why the accent is the cyan. The accent
in every theme carries all interactive duty and nothing else may (§8.2).

**Proposed token values.** These are the intended hues; every value must be
contrast-verified in place and adjusted if it fails, and the structure across
all eight themes stays identical — only the values change.

**`monokai-dark`**

| Role | Value |
|---|---|
| `--bg` | `#1B1C18` |
| `--surface` | `#272822` |
| `--surface-2` | `#33342C` |
| `--text` | `#F8F8F2` |
| `--text-secondary` | `#B4B6A7` |
| `--text-tertiary` | `#908B76` |
| `--hairline` | `rgba(248,248,242,0.09)` |
| `--accent` | `#66D9EF` |
| `--accent-tint` | `rgba(102,217,239,0.14)` |
| `--on-accent` | `#0C1D21` |
| `--positive` | `#A6E22E` |
| `--negative` | `#F92672` |
| `--scrim` | `rgba(0,0,0,0.55)` |

**`monokai-light`**

| Role | Value |
|---|---|
| `--bg` | `#FAF9F2` |
| `--surface` | `#FFFFFF` |
| `--surface-2` | `#EFEEE3` |
| `--text` | `#1D1E18` |
| `--text-secondary` | `#55564B` |
| `--text-tertiary` | `#84857A` |
| `--hairline` | `rgba(29,30,24,0.10)` |
| `--accent` | `#0F7285` |
| `--accent-tint` | `rgba(15,114,133,0.10)` |
| `--on-accent` | `#FFFFFF` |
| `--positive` | `#4C7A0B` |
| `--negative` | `#C2185B` |
| `--scrim` | `rgba(0,0,0,0.40)` |

**`dusk`**

| Role | Value |
|---|---|
| `--bg` | `#100E17` |
| `--surface` | `#191622` |
| `--surface-2` | `#221E2E` |
| `--text` | `#EDEAF5` |
| `--text-secondary` | `#A29CB8` |
| `--text-tertiary` | `#7B7590` |
| `--hairline` | `rgba(237,234,245,0.08)` |
| `--accent` | `#A78BFA` |
| `--accent-tint` | `rgba(167,139,250,0.14)` |
| `--on-accent` | `#14091F` |
| `--positive` | `#4ADE80` |
| `--negative` | `#FB7185` |
| `--scrim` | `rgba(0,0,0,0.55)` |

**`slate`**

| Role | Value |
|---|---|
| `--bg` | `#F5F7FA` |
| `--surface` | `#FFFFFF` |
| `--surface-2` | `#E9EDF3` |
| `--text` | `#14181F` |
| `--text-secondary` | `#4E5762` |
| `--text-tertiary` | `#808B99` |
| `--hairline` | `rgba(20,24,31,0.09)` |
| `--accent` | `#3B4CC0` |
| `--accent-tint` | `rgba(59,76,192,0.10)` |
| `--on-accent` | `#FFFFFF` |
| `--positive` | `#157F3D` |
| `--negative` | `#C62828` |
| `--scrim` | `rgba(0,0,0,0.40)` |

### 5.1 The theme control

The cycle is gone. In its place, a dropdown in the settings sheet listing all
eight under two group headers, **Dark** and **Light**.

Each row carries a **split swatch**: a 20px squircle at 6px radius, divided on
a 45° diagonal, the lower-left half filled with that theme's `--bg` and the
upper-right half with its `--accent`. It is a 1px-hairline-bordered shape so a
light theme's near-white `--bg` still reads as a shape against a light sheet.
The selected row carries a check in `--accent`.

This means each theme's `bg` and `accent` must be readable from JavaScript, not
only from CSS — a small static manifest alongside the theme list, kept in step
with `tokens.css`. Do not read computed styles off a hidden element to get
them.

---

## 6. The Planner

The main feature of V2. Route `/planner`.

### 6.1 Layout

Two panes on wide viewports: an **unscheduled task list** on the left at a fixed
width (roughly 280–320px), and the **schedule** filling the rest. On narrow
viewports the schedule takes the full width and the list becomes a bottom sheet
opened from a button in the planner's own toolbar.

A toolbar above the schedule carries: the view selector (Week · Month · Year),
a **Today** button, and previous/next navigation for the current period. The
period label ("March 3 – 9") sits between them.

### 6.2 The unscheduled task list

**Contents:** incomplete, unscheduled tasks from every non-archived board in
the current context. A task leaves this list the moment it is scheduled and
returns if it is unscheduled.

**Blocked and gated tasks are included but recessed** — name at
`--text-secondary`, the blocked or waiting-on marker shown, per §8.4's existing
blocked-row treatment. They remain draggable: planning to do something after
its prerequisite clears is legitimate, and the composer's gate still refuses the
*completion*, which is where the rule actually matters.

**Sorting.** A control offers Priority · Difficulty · Due date · Duration.
Every sort is a total order and **unset always sorts last**, in every mode:

| Sort | Order |
|---|---|
| Priority | flagged first → due moment ascending (undated last) → id ascending |
| Difficulty | 5→1, unset last → due moment ascending (undated last) → id ascending |
| Due date | due moment ascending, undated last → priority flagged first → id ascending |
| Duration | minutes ascending, unset last → due moment ascending → id ascending |

**Group by board** is a toggle, **off by default**. When on, tasks group under
board-name headers with the board's name at 13px uppercase (§8.3) and the
active sort applied within each group; groups themselves follow board order.

Each row shows the task name, its duration chip if set, its due chip if set,
and its priority marker if flagged. Rows are the drag source.

*Empty:* one quiet line — everything is scheduled. *Loading:* skeleton rows.
*Error:* the standard retry line.

### 6.3 The week view — the default

Seven day columns, **Sunday through Saturday**, with a vertical 24-hour time
axis on the left.

- **Scale:** one hour is 64px, so the 15-minute atom is 16px. Sizes in rem so
  the user's text-size setting is respected.
- **Working hours** get `--surface` as their backdrop; off-hours get `--bg`.
  The step is the same one that communicates elevation everywhere else in the
  app, so it reads in all eight themes without a special case.
- **Hairlines** at every hour; a lighter one at the half hour; nothing at 15
  minutes. The grid must not look like graph paper.
- **On mount, scroll to the working-day start**, not to midnight.
- **The now line:** a 1px `--accent` rule across today's column only, with a
  3px dot at its left edge. It updates on the minute, not on a rapid timer.
- **Today's column header** is emphasised by weight, not by colour.

**Blocks.** A block's top is its start, its height its duration. Content by
available height: at 45 minutes and above, the task name on up to two lines
plus a time range and the priority marker; below that, the name on one line,
truncated. A block with a null duration renders 30 minutes tall with a **dotted
1px outline** in place of its fill edge — scheduled, length not committed.

A **completed** block is `--text-tertiary` throughout with the name struck
through and no accent anywhere.

**Overlap** is packed into lanes: any set of blocks that transitively overlap
forms a cluster, the cluster is assigned the minimum number of lanes, and each
block takes `1/lanes` of the column width at its lane's offset. Ghosts
participate in the same packing — a real block must never be drawn over a ghost.

**Ghost blocks** are the other context's scheduled tasks: a `--surface-2` fill,
no border, no accent, the single word "Busy" at `--text-tertiary`, and
`pointer-events: none`. They are never clickable, never draggable, and never
carry a name, a board, or a chip.

### 6.4 The day view — narrow viewports

Below the wide breakpoint, the week view becomes a **single day column with a
day pager**: a compact seven-day strip of weekday initials above the column,
the current day marked, swipe or tap to move between them. Everything else —
scale, working-hours shading, now line, lane packing, ghosts — is identical.

A seven-column grid on a 375px viewport is not a smaller week view, it is an
unusable one. §5 makes iOS Safari the primary mobile target; this is what that
means here.

### 6.5 The month view

A six-row by seven-column day grid for the visible month, with adjacent-month
days at reduced contrast.

Each day cell lists its blocks as one-line entries — start time in tabular
figures, then the task name truncated to the cell width — up to three, then a
`+N more` line at `--text-secondary`. Completed entries are struck through.
Ghosts appear as an unlabelled `--surface-2` bar, count included in the
overflow.

Today's cell is marked with an accent outline, not an accent fill.

**Clicking a day switches to the week view scrolled to that day.** There is no
drag scheduling in month view.

### 6.6 The year view — a workload heat map

A GitHub-style contribution grid: 53 columns of 7 day-squares, weekday rows
labelled sparsely, month labels along the top.

Each square's intensity is that day's **total scheduled minutes** — the sum of
its blocks' effective durations, counting a null duration as 30 — bucketed
against the length of the user's configured working day:

| Bucket | Fill |
|---|---|
| Nothing scheduled | `--surface-2` |
| Up to 25% of a workday | `--accent` at 25% |
| Up to 50% | `--accent` at 50% |
| Up to 75% | `--accent` at 75% |
| Above 75% | `--accent` |

Both contexts' blocks count toward the heat, because a full day is a full day —
but the tooltip reports only the current context's tasks by name.

Hover on a fine pointer, or press on a touch device, shows the date and the
total scheduled time. **Clicking a day switches to the week view at that day.**

On narrow viewports the grid scrolls horizontally, ending at the current week.

### 6.7 Scheduling interactions

This is the section the release is judged on. §8.5 of `PROJECT-SPEC.md` governs
every part of it and is binding: pointer capture, 1:1 tracking with grab-offset
respect, transform and opacity only, no locked input, release velocity handed
into the settling spring, and reduced motion honoured.

**Dragging from the list onto the grid.**

- Initiation matches the existing reorder primitive: ~6px on a fine pointer,
  a 200ms long-press with ~10px of slop on touch.
- The dragged item takes the **height its duration implies** the moment it
  leaves the list — a 2-hour task is a 2-hour-tall object under the finger, so
  the user is placing a real shape, not a proxy. A task with no duration takes
  the 30-minute height with the dotted outline.
- The drop target snaps to the 15-minute grid, and the snapped slot is
  previewed under the drag at reduced opacity as the pointer moves.
- Auto-scroll near the vertical edges of the grid, accelerating with proximity,
  matching the existing reorder behaviour.
- On release, the block is written optimistically and springs into its slot
  from the pointer's release velocity. A failed write animates it back to the
  list rather than snapping.
- **Escape cancels an in-flight drag** and returns the item to the list.

**Moving a block already on the grid** uses the same gesture, from the block
itself, and changes only `scheduledAt`.

**Resizing.** A block's bottom edge is a resize handle with a ≥44px effective
target that does not steal the block's own press target. Dragging it changes
the duration in 15-minute steps, live, with the block's height following 1:1.
On release the new duration is written to **the task's `durationMinutes`** —
this is the same field the composer's chips set, and the grid is the other way
of setting it. A resize may not take the block across midnight or outside
`[15, 720]`; it resists at the boundary rather than stopping dead.

**Unscheduling.** Dragging a block back onto the task list clears `scheduledAt`.
The composer gains an **Unschedule** action, shown only when the task has a
block.

**The keyboard path — required, not optional.** §5's accessibility floor makes a
drag-only Planner a defect. With a task in the list focused:

- <kbd>Enter</kbd> enters placing mode, showing a highlighted slot on the grid.
- <kbd>←</kbd>/<kbd>→</kbd> move by a day, <kbd>↑</kbd>/<kbd>↓</kbd> by 15
  minutes, <kbd>Shift</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> by an hour.
- <kbd>Enter</kbd> places, <kbd>Escape</kbd> cancels.
- With a **block** focused, <kbd>Shift</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> resizes
  by 15 minutes and <kbd>Delete</kbd> unschedules.

Per §8.5, **keyboard-initiated placement animates nothing.** The block appears
in its slot.

### 6.8 Working hours

Set in the settings sheet (§4.3), stored server-side (§3.2), and applied to
every schedule view. Changing them re-shades the grid without a reload and
without a refetch beyond the settings write itself.

---

## 7. Blockers

Route `/blockers`. Shows the current context only.

### 7.1 What the data actually is

> **Revised by §14.** A task may now hold **several** prerequisites, so this
> section's forest is a directed acyclic graph. What survives unchanged: links
> stay on one board, cycles are still refused by the Worker, the layout is still
> a pure function of the task list living in a tested shared module, and it
> still costs no graph library. What changed is depth (the *longest* path from a
> root, not a chain length) and vertical placement (a barycentre sweep, not a
> tidy tree). The original text follows.

`dependsOn` allows a task **at most one prerequisite**, on the same board, with
cycles refused by the Worker. That makes each board's dependency structure a
**forest of trees**: every node has at most one edge leaving it toward its
prerequisite, and any number of edges arriving from its dependents.

This is not a general graph problem and must not be solved with a graph
library. Depth is the chain length from a root; vertical placement is a tidy
tree layout. Both are pure functions of the task list, both belong in a shared
module with unit tests, and neither costs a kilobyte of dependency.

### 7.2 Layout

**One horizontal row per board**, full viewport width, stacked vertically, the
page scrolling between them. Each row owns its own horizontal scroll. The board
name is sticky at the row's left edge with its progress percentage beneath it.

**Boards with no dependency links at all collapse to a single thin line** —
board name, and `N tasks · no dependencies` at `--text-secondary` — expandable
to the compact list on press. Most boards will be in this state, and a page of
mostly-empty full-height rows is not a premium page. Boards that have trees
sort above those that do not.

**Inside a row:**

- **Standalone tasks** — no prerequisite and no dependents — go in a compact
  vertical list anchored at the row's left, in a `--surface-2` well: a
  checkbox and a single truncated line each, capped in height with its own
  scroll. This list is deliberately quiet; it is not what the page is about.
- **The trees** lay out to its right, left to right by depth. A prerequisite
  sits left of everything that waits on it. Roots stack vertically with a
  clear gap; the row's height is the tallest tree plus padding.
- **Edges** are drawn in a single SVG layer behind the nodes, as cubic curves
  with horizontal control points leaving the right edge of the prerequisite and
  arriving at the left edge of the dependent. A prerequisite with several
  dependents draws several edges. Edges never pass through a node.

### 7.3 Nodes

A fixed-width box (roughly 200px) at 12px radius on `--surface`, containing:

- a checkbox at the left, 20px in a ≥44px target;
- the task name, up to two lines, then truncated;
- at most **two** chips — the due date and the priority marker.

Everything else about the task is available through the existing hover-detail
pattern, on a fine pointer, and on long-press on touch. A node carrying every
field is a node that does not fit, and dozens of them are the point of this
page.

**Pressing a node opens the task composer.** The checkbox is a separate target
that does not open it, exactly as in the task row (§8.4).

### 7.4 States

Neutral ramp, accent for open, per §2's decision:

| State | Node | Incoming edge |
|---|---|---|
| **Open** — incomplete, nothing blocking it | `--surface` fill, 1.5px `--accent` outline | — |
| **Gated** — waiting on an incomplete prerequisite | `--surface` fill, `--hairline` border, name at `--text-secondary`, chips at `--text-tertiary` | `--text-tertiary` — the gate is closed |
| **Released** — its prerequisite is complete | Open styling | `--positive` at ~60% — the gate is open |
| **Completed** | Name struck through, everything at `--text-tertiary`, no outline | unchanged |

`--negative` appears in exactly one place on this page: an **overdue due-date
chip**, as it already does everywhere else. Nothing else on Blockers is red.

Completing a prerequisite flips its outgoing edges to the released treatment
and releases its dependents in the same render — the gate is derived, never
stored, so there is no second write and no refetch. The transition is a colour
fade, well under 300ms, and is retained under reduced motion since it aids
comprehension.

A gated node's checkbox **refuses with the same explanation the task row
gives** — the rule lives in `shared/dependencies.ts` and this page uses it, it
does not restate it.

### 7.5 Auto-scroll

**On mount only**, each row scrolls horizontally to its **leftmost incomplete
node** — the current frontier of that board's work, which is what "what do I
unblock first" means. It must not re-run on subsequent renders: a page that
scrolls itself every time a checkbox is ticked is a page that fights its user.

Under reduced motion the scroll is instant rather than smooth.

### 7.6 States

*Empty (no dependencies anywhere in the context):* one quiet typographic line
explaining that tasks waiting on other tasks appear here, with no illustration
and no call to action.
*Loading:* skeleton rows matching the real row geometry.
*Error:* the standard plain-language line plus retry; the header and view
selector stay functional.

---

## 8. Up Next, rewritten

This replaces §6.7 and §7.2 of `PROJECT-SPEC.md`.

Up Next still sits at the top of the context home, still caps at **five**, still
excludes completed, hand-blocked, and dependency-gated tasks, and is still
per-context.

**The ranking is three tiers, in order. A task appears in the first tier it
qualifies for and never twice.**

1. **Overdue** — has a due moment in the past. Most overdue first. Overdue
   always outranks everything, including something scheduled for this morning.
2. **Scheduled today** — has a block starting within today's local day. Sorted
   by start time ascending, so a block whose start has already passed sorts
   ahead of one still to come. A task qualifies here with or without a due date.
3. **Everything else with a due date** — sorted by **effective due moment**,
   which is the due moment minus **24 hours** for a priority-flagged task and
   the plain due moment otherwise.

Within every tier, ties break toward higher difficulty (unset weighs 3, as it
does for progress), then toward the lower id — so the order is total and the
strip cannot reshuffle between two renders of the same data.

The 24-hour bonus is how "priority tasks near their due date rank highest"
becomes a sort rather than a vibe: a flagged task jumps ahead of anything due
within a day of it and has no effect at all on something due next month. It has
no cliff, which a "promote if due within N days" rule would have.

**Cards** now distinguish the two reasons an entry is present: a tier-2 entry
leads with its **scheduled time** behind a clock glyph; tier-1 and tier-3
entries lead with their **due date** behind a calendar glyph, overdue ones in
`--negative` as before. An entry that has both shows the one its tier is about.

Everything else about the surface — the horizontal card row on narrow
viewports, check-off in place, the collapse state persisted per context, the
single-line empty state — is unchanged.

---

## 9. Composer changes

Small, and all downstream of §3.1.

- The duration chips become **15m · 30m · 1h · 2h · 4h · Custom**. `Half day` is
  gone. The five presets set 15/30/60/120/240 minutes and behave exactly as
  they do today.
- **Custom** is selected — not chosen — when the task's duration is not one of
  the five presets, which is what a grid resize produces. It displays the actual
  value ("1h 45m"). Pressing it opens a stepper over the same 15-minute grid.
- An **Unschedule** action appears in the composer's bottom action group, beside
  Move to board, **only when the task has a block**. It reads the scheduled slot
  ("Scheduled Tue 2:00 PM") so the action is legible before it is taken.
- **No scheduling field is added.** Placement is the grid's job.

---

## 10. Design and motion — what carries over

`PROJECT-SPEC.md` §8 applies in full and unchanged. The parts most at risk in
V2 work:

- **One accent does all interactive duty.** The Planner has a great deal of
  surface to fill and it is not permitted to fill it with colour. Blocks are
  `--surface`/`--accent-tint`, the now line and open-node outlines are the
  accent, and `--positive`/`--negative` mean success and destructive/overdue
  and nothing else.
- **Tabular figures everywhere.** The time axis, block time ranges, the year
  heat map tooltip, durations. A proportional figure in a time column is a
  defect.
- **Transform and opacity only.** A block's height during a live resize is the
  one place this is genuinely hard; solve it with a transform and reconcile the
  real height on release, not by animating `height`.
- **Nothing exceeds 300ms**, no `ease-in`, no `@keyframes` on anything rapidly
  re-triggered, no `scale(0)` entrances.
- **`prefers-reduced-motion` is gentler, not off.** Drag must still work; the
  spring settles become instant, the stagger goes away, the colour fades stay.
- **Hover gated behind `@media (hover: hover) and (pointer: fine)`** — the
  Planner and Blockers both lean on hover for detail, and a touch device
  false-positives hover on tap.
- **Every list surface needs empty, loading, and error states.** The task list,
  both new views, and every Blockers row.
- **Touch targets ≥44px**, including the block resize handle and the node
  checkbox.

---

## 11. Out of scope — design for, do not build

Deliberately excluded from V2. Do not build them, and do not add abstractions
or flags "ready" for them beyond what costs nothing.

- ~~**Multiple prerequisites per task.**~~ **Built — see §14.** It was revisited
  after living with the visualization, which is exactly the condition this entry
  set.
- **Dependencies that cross boards**, and any gate whose cause is somewhere the
  user is not looking.
- **Splitting one task across several blocks.** Two sittings is two tasks.
- **Drag scheduling in month and year views.**
- **Dragging a task from the Planner into a board**, or any cross-surface drag
  other than list↔grid.
- **Recurring blocks, templates, or a "repeat this week" action.**
- **Auto-scheduling, auto-rescheduling, or spill-forward** of blocks whose time
  has passed unfinished. Not even a nudge.
- **Calendar import or export**, ICS, or any external calendar integration.
- **Timezone support.** Local wall-clock only.
- **Statistics built on the heat map** — streaks, velocity, completion history.
  The data is now sitting right there; nothing reads it.
- **Notifications or reminders** for a block that is about to start. *(Still
  excluded — see the addendum below. Notifications now exist, and deliberately
  do not cover Planner blocks: a due date is a commitment, a block is a plan.)*
- Everything already excluded by v1 §10 that V2 does not explicitly revise.

---

## 13. Addendum — push notifications

Added after V2 shipped, and a deliberate revision of v1 §10's "no push
notifications or reminders" and of §11 above. `docs/NOTIFICATIONS.md` is the
complete specification; what follows is what changed in the documents this one
supersedes.

**What exists now.** Web Push (VAPID, no third-party service) to any device that
has subscribed, carrying two kinds of message: a once-a-day summary of what is
due today and what is overdue, at a start-of-day time set separately for Mon–Fri
and Sat–Sun; and a per-task reminder a configurable number of minutes ahead of
any task that has a due *time*. Tapping either opens the installed app — the
summary at the home screen, a reminder at its task's board with the task
highlighted.

**Decisions, in the register of §2:**

| Decision | Rationale | Cheap to change later? |
|---|---|---|
| **Web Push only.** No email, SMS, or chat-service fallback | It is free, needs no account, and a tap opens the home-screen app — which is the whole of the stated requirement. A second channel is a second content pipeline to keep in step for no additional reach | Yes |
| **Notification settings are global, not per-context** | Personal and Work are separate because a doctor's appointment does not belong in a work review. The phone in your pocket is not a context, and a morning where the summary hid the dentist would be the feature lying | Moderate |
| **One time zone is stored, in settings, and it is *picked* rather than detected** | Cron fires in UTC; "8:00 AM" is not an instant without a zone. This is the single exception to §2's "no timezone is stored", and it is scoped to notifications — the Planner remains local wall-clock throughout. Picked rather than detected because a zone that followed the device would move the morning summary every time the app was opened somewhere else | Moderate |
| **The cron ticks every minute** | The reminder lead is an offset from an arbitrary due time; 1:33 PM minus five minutes is 1:28, which no coarser schedule lands on. A tick with notifications off reads one row and returns | Yes |
| **Idempotency is by key, written before the send** | A phone that buzzes twice about one task is the failure a user actually notices; a missed notification is not. So the ledger is written first and a crash costs at most one message | No |
| **A summary with nothing due and nothing overdue is not sent** | §6.7's empty state is a quiet line on a screen the user chose to open. A push is an interruption, and "nothing today" has not earned one | Yes |
| **Reminders cover due *times*, never Planner blocks** | A due date is a commitment; a block is a plan, and §11 above rejects nudging about one. That line still holds | Yes |
| **The service worker has no `fetch` handler** | A service worker is required to receive a push, and is also the first half of offline-first — which v1 §3 rejects as the largest complexity multiplier in the project. Registering one for notifications must not smuggle the other in | No |

**Settings gains five fields** (§3.2): `notificationsEnabled`, `timeZone`,
`weekdayStartMinutes`, `weekendStartMinutes`, `dueReminderLeadMinutes`. They ride
in the same JSON document for the same reason everything else there does, and
they are read by the Worker's scheduled handler rather than by any screen.

**The settings sheet gains a Notifications section** (§4.3), between Working
hours and Archived boards: the master toggle, the two start-of-day times, the
reminder lead, the time zone, and a test-send. Every refusal — an un-installed
PWA on iOS, a denied permission, a deployment with no keys — is named in a
sentence rather than collapsed into a toggle that will not stay on.

---

## 12. V3 ideas

Recorded so the thinking is not lost, and so nobody mistakes any of it for
something this build was supposed to do.

- **Many-to-many dependencies**, which turn Blockers from a forest into a real
  DAG and make bottleneck surfacing genuinely interesting — a prerequisite with
  six things queued behind it is the highest-leverage task on the board and
  currently looks like every other task.
- **Critical path.** The longest chain through a board is the minimum number of
  sequential steps left. Worth showing when a board is being planned rather
  than worked.
- **Blocked counts on the dashboard.** A board card could say "3 blocked" the
  way it says "7 of 12", putting the bottleneck signal where the overview
  already is.
- **Capacity awareness.** The Planner knows the working hours and the scheduled
  minutes; it could say "Thursday is 40 minutes over" without scheduling
  anything itself.
- **Difficulty-aware scheduling hints** — putting the 5s in the morning — which
  is the first thing in this project that would need an opinion of its own.

---

## 14. Addendum — many prerequisites per task

Added after the Planner and Blockers shipped, and a deliberate revision of §2's
"forest of trees" row, of §7.1's data description, and of §11's exclusion. §12
recorded this as the first V3 idea; living with the single link is what made the
case, which is the condition §11 set for revisiting it.

**What changed.** A task may wait on **any number** of other tasks on the same
board, and it waits for **all** of them. Everything else about a dependency is
unchanged: links never cross boards, cycles are refused, the gate is derived on
read and never stored, completing a prerequisite releases whatever it frees in
the same render, and deleting one releases its dependents rather than taking
them with it.

**Decisions, in the register of §2:**

| Decision | Rationale | Cheap to change later? |
|---|---|---|
| **All-of, not any-of.** A task with three prerequisites waits for all three | An "any one of these releases it" edge would be a second kind of arrow, and a graph whose edges mean two different things is one nobody can read at a glance | Yes |
| **The links move to a join table**, and `tasks.depends_on` is dropped | A set does not fit in a column. Leaving the column behind as well would be a second, immediately-stale answer to the same question | No — one-way migration |
| **Depth is the *longest* path from a root** | A task must be drawn right of *every* prerequisite. Taking the shortest path, or the first link's, puts an edge travelling leftwards on screen, which reads as the dependency pointing the wrong way | No |
| **Groups are connected components, not trees** | With several parents there is no single root to name a group by. Two tasks belong in one drawing if any chain of links joins them, in either direction | No |
| **Vertical order is a two-sweep barycentre pass**, not tidy-tree centring | With one parent, centring over the children is exact. With several, no arrangement satisfies every edge, so each column is ordered by the average position of its neighbours — left-to-right, then right-to-left balancing both sides so a join sits between its branches instead of in line with whatever follows it | Yes |
| **Still no graph library** | The layout is a topological sort and two sweeps. It is a hundred lines of tested pure function against a kilobyte-scale dependency, and §5's bundle bar has not moved | Yes |
| **Cycle refusal walks the graph, not a chain** | Two links that are each legal can close a loop together, so a set is validated one link at a time against the links accepted before it, and reachability is a depth-first search with three-state colouring — a plain visited set cannot tell a diamond from a cycle | No |
| **A cap of 25 prerequisites per task** | Not a domain rule. An unbounded array from an untrusted body is an unbounded batch of inserts, and a task waiting on fifty others is not something anyone can read | Yes |

**The composer** replaces its single "Waiting on" dropdown with the picked
prerequisites as removable chips plus a select that adds one more. The select
never shows a current value — the chips are the state, the select is the verb.
Its options are re-derived as the draft grows, so picking one can remove another
from the list and a loop cannot be built one legal-looking step at a time.

**Blockers** draws every prerequisite as its own curve, all of them arriving at
the centre of the dependent's left edge so they visibly flow into it.

**§7.2's "edges never pass through a node" is preserved, and it took work.** The
forest gave it away free — every edge spanned exactly one column, so there was
nothing in between to hit. In a graph a task can wait on something three columns
back. So a long edge is **broken at every column it crosses**, and each break
holds a row of its own in that column: a zero-height vertex that competes for
vertical space with the real cards and pushes them aside, reserving a channel
for the line. It is the dummy-vertex idea from layered graph drawing, and it is
the only part of that literature this needs. After routing, no leg of any edge
spans more than one column, which is the invariant the tests assert directly.

The "add after" plus for an edge sits in the **first** gap that edge travels
through — always free of cards, and the curve's own midpoint when the edge is a
single column, so nothing changed for the ordinary case. A **stub** belongs only
to a node with no dependents at all: one that has them already has a line
leaving its right edge, and drawing a stub as well put a second stroke and a
plus straight on top of the real edge.

**Two fixes to the "add a task after this one" affordance**, both regressions
from the release that introduced it:

- The plus stayed lit after the composer closed, because closing returns focus
  to the button that opened it and the reveal was gated on `:focus-within`. It
  is now `:has(:focus-visible)`, which a mouse click does not set — so the
  keyboard path keeps its reveal and the pointer path lets go.
- The plus at the end of a chain never appeared at rest, leaving a stub line
  trailing into empty space with nothing to explain it. Stub pluses now rest at
  the same reduced contrast touch devices get, and brighten on hover. Edge
  pluses stay hover-only: the line they sit on is drawn either way, so the
  picture is complete without them.

**Still out of scope**, unchanged from §11: dependencies that cross boards, and
any gate whose cause is somewhere the user is not looking.
