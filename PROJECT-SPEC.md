# CAIRN — Project Spec

## How to use this document

Read this document fully before planning anything. It describes **what** to build and **why**, exhaustively. It deliberately does not describe **how** — file structure, module boundaries, data schema, and internal architecture are yours to decide.

Ask only questions that would materially change the build. If nothing is blocking, proceed. Build only what is specified here; do the simplest thing that works well. Anything in the "Out of scope" section is designed-for but explicitly not built now. Verify as you go, against the acceptance criteria in each section rather than against your own explanation of the work.

---

## 1. What we're building

**Cairn** is a private, single-user task tracker on the web, for Charlie, reachable from any device with a browser.

The problem it solves: task tools are either too heavy (Notion, Asana — slow, cluttered, built for teams) or too flat (Apple Reminders — no notion of a project with a shape). Cairn sits between: two life contexts, projects inside them, tasks inside those, and a progress bar that tells the truth about how far along a project actually is.

It enables one thing well: **opening the app on any device and immediately knowing what to do next, then feeling good about checking it off.**

v1 scope: authentication, two fixed contexts, boards, tasks, drag-to-reorder, completion, per-board progress, and an "Up Next" surface. Nothing else.

---

## 2. The thing that matters most

**Speed and feel, in that order.**

Cairn is judged against a single bar: it must load in well under a second on a cold mobile connection, and every interaction — checking a task, dragging a row, opening the composer — must respond on pointer-down with no perceptible latency, and must be interruptible mid-motion.

This is the quality bar that overrides feature ambition. A feature that adds meaningful bundle weight or blocks the first paint is the wrong trade. If a choice is between "more capable" and "instant," choose instant.

The second half of that bar is craft: the drag-and-drop and the check-off animation are the two interactions the user will perform thousands of times, and they are the reason this app exists rather than a text file. They must feel physical — velocity-aware, grabbable mid-flight, never snapping.

---

## 3. Decisions already made

These are settled. Do not re-litigate them.

| Decision | Rationale | Cheap to change later? |
|---|---|---|
| **Cloudflare Workers + D1**, deployed to a subdomain of an existing Cloudflare-managed domain | Matches the owner's existing deployment pipeline; no server to maintain; edge-fast; free at this volume | No — foundational |
| **Single user, single password**, no accounts, no registration, no multi-tenancy | It is one person's tool. Every line of account infrastructure is waste | No |
| **Long-lived session** (~90 days) via a signed, httpOnly, Secure, SameSite cookie | The owner should log in roughly never | Yes |
| **No TOTP / 2FA in v1** | Ceremony without payoff for a to-do list; the password plus rate limiting is the right level | Yes |
| **Online-first installable PWA**, not offline-first | Offline sync means conflict resolution and a local write log — the single largest complexity multiplier available in this project. Design the data layer so it could be added; do not add it | Moderate |
| **Exactly two contexts: Personal and Work.** Fixed, not user-creatable | Stated requirement; two is simpler in every dimension | Yes |
| **Hierarchy stops at Tab → Board → Task.** No sub-tasks inside tasks | The board *is* the project and the task *is* the sub-task; a third level is redundant | No |
| **Only the task name is required.** Every other field is optional | Speed of capture beats completeness of data. A task must be creatable with one keystroke sequence and no decisions | No |
| **Progress is difficulty-weighted**, not a plain count | A board where four trivial tasks are done and the hard one isn't should not read 80% complete | Yes |
| **Unset difficulty is treated as 3** in the weighting | Makes the weighted formula collapse exactly to plain completed/total on a board where nobody set difficulties — no special-casing, no surprising behavior | Yes |
| **Priority is a binary flag**, not a second 1–5 scale | Two five-point dials per task means the user answers two fuzzy questions and starts skipping both. One precise question beats two vague ones | Yes |
| **No recurring tasks** | Recurrence rules, instance generation, and series-vs-instance completion semantics are a multi-week feature. Explicitly rejected for v1 | Moderate |
| **No push notifications or reminders** | Requires push infrastructure and permission flows | Yes |
| **No tags/labels in v1** | A per-tab colored tag set fights the one-accent design law and adds visual clutter to the exact surface that must stay calm | Yes |
| **Drag-and-drop reorders within a single board only.** Moving between boards happens through a menu action | Cross-board dragging is a much harder interaction problem serving a rare action | Yes |
| **Up Next is anchored at the top of each tab and is per-tab** — Personal's Up Next never shows Work tasks | Stated requirement; context separation is the point of having tabs | Yes |
| **Dark theme is the default**, following system preference on first load, with a manual override that persists | Stated preference | Yes |
| **Design dials: DESIGN_VARIANCE 3 · MOTION_INTENSITY 7 · VISUAL_DENSITY 6** | See §8 | Yes |

---

## 4. Systems overview

A hint for your decomposition, not a set of issues. Five distinct systems:

**Auth & session.** Password verification against a stored hash, session issuance, session validation on every request, rate limiting on failed attempts, logout. *Risk concentration: high.* Errors here are security-relevant and silent — a session cookie missing a flag, or a timing-variant comparison, produces no visible symptom. This work needs judgment and review, not speed.

**Data & API layer.** Persistence for boards and tasks, ordering, and the read/write endpoints the client needs. *Risk concentration: low-to-moderate.* Mostly conventional, and highly verifiable — a wrong result fails a test immediately. The one subtle piece is **ordering**: the representation must support inserting a task between two others without rewriting every row, and must remain stable when the same account writes from two devices.

**Frontend state & optimistic updates.** Every mutation must appear instantly in the UI and reconcile with the server afterward, including reorder and completion. *Risk concentration: moderate-to-high, and hard to notice.* Optimistic ordering bugs surface as a row that snaps back a half-second after it lands — subtle, intermittent, and invisible to any automated test. This is judgment work.

**Motion & drag-and-drop.** The reorder gesture, the completion transition, sheets, and the progress bar. *Risk concentration: highest for craft, lowest for correctness.* Nothing here breaks the app, but this is the system the whole project is judged on, and it cannot be verified by a test — only by exercising it on a real phone and a real trackpad.

**Design system & deploy.** Tokens, typography, theming, and the Cloudflare deployment including DNS routing to the subdomain. *Risk concentration: low, but the deploy step has historically been the one that bites* — routing a Worker to a subdomain of an already-configured domain is where mistakes hide.

**Safety-domain exposure: none.** Authentication work here is defensive (protecting one user's own data), not offensive security. No biology, chemistry, health, or model-distillation content. The manager session runs on Fable without concern.

---

## 5. Constraints (real ones only)

- **Platform:** Cloudflare Workers, D1 for persistence, static assets served from the edge. Deployed to a subdomain of the owner's existing Cloudflare-managed domain.
- **Client:** A React single-page application built with Vite. Not a server-rendered framework — there is no SEO surface, no public content, and one user, so an SPA behind a login yields the smallest, fastest artifact. Ship a minimal bundle; audit it before calling the build done.
- **Styling:** Tailwind v4 with the design tokens in §8 defined as CSS variables and referenced through the theme config. No component library, no shadcn — the component surface here is small enough that a library is net weight.
- **Animation:** Motion (`motion/react`). Spring-driven for anything the user can touch mid-flight; CSS transitions for simple state changes; never `@keyframes` on anything rapidly re-triggered.
- **Icons:** Phosphor (`@phosphor-icons/react`), light or regular weight, one weight globally, one family only. Do not hand-roll SVG icons.
- **Fonts:** Geist Sans, self-hosted with `font-display: swap`. Inter, Roboto, Helvetica, Arial, and Open Sans are banned. Numerals use tabular figures everywhere.
- **Drag-and-drop:** must be Pointer Events based with pointer capture, 1:1 tracking, grab-offset respect, and release-velocity handoff. Motion's reorder primitives or dnd-kit are both acceptable starting points; a library that cannot deliver velocity handoff and mid-flight interruption is not.
- **Browsers:** current Safari (iOS and macOS) and current Chrome. iOS Safari is the primary mobile target — use `100dvh`, never `100vh`.
- **Accessibility floor:** keyboard-operable throughout, visible focus states, 4.5:1 contrast on text in both themes, `prefers-reduced-motion` honored, touch targets ≥ 44px.

---

## 6. Features

### 6.1 Authentication

A single password, set by the owner and stored only as a hash. The login screen accepts the password and nothing else — no username, no email, no "forgot password" flow.

On success, the server issues a session cookie valid for approximately 90 days, marked httpOnly, Secure, and SameSite. Sessions are validated on every data request. On expiry or invalidation, the user lands back on the login screen with their intended destination preserved so they return there after logging in.

Failed attempts are rate limited — after a small number of consecutive failures from the same source, further attempts are refused for a cooling-off period, and the error message never distinguishes "wrong password" from "rate limited" in a way that helps an attacker. Password comparison is timing-safe.

Logout is available from the app header and clears the session server-side, not just client-side.

**States:** idle · submitting (button shows a spinner inside the same pill, no size change) · error (inline message, field shakes once) · rate-limited (message states when to try again).

### 6.2 Contexts (tabs)

Two contexts: **Personal** and **Work**. A segmented control in the app header switches between them. The active context persists across sessions and reloads — reopening the app returns the user to the context they left.

The two contexts are fully separate: separate boards, separate Up Next. Nothing crosses.

### 6.3 Boards

A board is a project. It belongs to exactly one context and contains an ordered list of tasks.

**Board fields:** name (required), optional one-line description. Nothing else — a board is a container, not a record.

**Board actions:** create, rename, edit description, archive, unarchive, delete. Archive hides the board from the tab without destroying it; delete is permanent and requires a confirmation that names the board and states the number of tasks that will be destroyed. Deleting is the only destructive action in the app and is styled accordingly.

**Board ordering:** boards within a tab are ordered by the user, reorderable by drag on the tab home. New boards are added at the end.

**Progress:** every board carries a progress percentage, difficulty-weighted (see §7.1), displayed as both a bar and a number.

### 6.4 Tasks

A task belongs to exactly one board. **Only the name is required.**

| Field | Required | Behavior |
|---|---|---|
| **Name** | Yes | Free text, up to ~120 characters. Single line. |
| **Notes** | No | Free-form plain text, multi-line, no formatting. Collapsed by default in the row; a small indicator shows a task has notes. |
| **Due date** | No | A calendar date. |
| **Due time** | No | A clock time, only offerable once a date is set. Used for tasks with a fixed moment — a meeting, a call, a deadline at a specific hour. A task with a date but no time is due "sometime that day." |
| **Duration estimate** | No | Chosen from fixed chips: 15m · 30m · 1h · 2h · 4h · half-day. Not free text — chips get used, number fields get skipped. |
| **Difficulty** | No | Integer 1 (easy) to 5 (difficult). Entered by tapping a five-segment pip control. Feeds the weighted progress calculation. |
| **Priority** | No | A binary flag. Set or unset. Marks "this one matters." |
| **Blocked** | No | A binary flag. Marks a task as waiting on something external. Blocked tasks are visually distinct and are excluded from Up Next. |
| **Created at** | Auto | Recorded, never displayed in v1. Captured now because it cannot be backfilled later. |
| **Completed at** | Auto | Recorded on completion, cleared on un-completion. Not displayed in v1. |
| **Position** | Auto | The user-controlled order within the board. The representation is yours to choose; it must support inserting between two neighbors without rewriting the whole list, and must be stable under writes from two devices. |

**Task actions:** create, edit any field, complete, un-complete, move to another board, delete.

**Creating a task** has two paths, and the fast one is the default:

- **Quick add.** A persistent single-line input at the bottom of the board. Type a name, press Enter, task appears at the end of the active list, input clears and stays focused for the next one. Zero decisions, no dialog, no round trip the user waits on.
- **Full composer.** Opened from the quick-add row's expand affordance, or by tapping an existing task. Presents every field. Saving returns to the board.

**Editing** always uses the full composer.

**Moving a task to another board** is a menu action inside the composer: choose a destination board from the current context, task is appended to the end of that board's active list. Not available across contexts in v1.

### 6.5 Completion

Checking a task's checkbox:

1. The checkbox responds instantly on pointer-down.
2. The task is marked complete and its completion time recorded.
3. The row transitions to its completed appearance: text drops to tertiary contrast, the name gets a strikethrough, all metadata chips desaturate.
4. The row animates from its position down into the **Completed** group at the bottom of the board — a real movement, not a disappear-and-reappear.
5. The board's progress bar and percentage update, the number counting rather than jumping.
6. An undo affordance appears briefly.

Un-checking a completed task restores it to the **bottom of the active list** — its old position is not preserved, deliberately, because preserving it means the list reshuffles under the user's hands.

The Completed group sits at the bottom of the board under a header reading "Completed · N", and is collapsible. Completed tasks are not reorderable and the completed region is not a valid drop target. Collapse state persists per board.

### 6.6 Reordering

Within a board, active tasks are reorderable by drag. This is one of the two interactions the app is judged on; §8.5 specifies its physics in full.

Boards on the tab home are reorderable by the same mechanism.

Completed tasks cannot be reordered.

### 6.7 Up Next

A surface anchored at the very top of each context's home, above the boards. It answers "what now?" without opening anything.

**Contents:** incomplete, non-blocked tasks from every board in the current context that have a due date, sorted soonest-first, overdue first. Capped at five. Each entry shows the task name, the board it belongs to, and its due date — rendered as a relative phrase for near dates ("Today, 3:00 PM", "Tomorrow", "Overdue by 2 days") and an absolute date beyond that. Priority-flagged tasks carry their marker. Overdue entries use the negative semantic color for their date text only.

**Interaction:** tapping an entry navigates to its board and briefly highlights the task. Entries can be checked off directly from Up Next, with the same completion behavior; the entry then leaves the strip and the next-soonest task takes its place.

**Layout:** a horizontally scrolling row of compact cards on narrow viewports, bleeding off the right edge to signal scrollability; a single row of up to five cards on wide viewports. The whole surface is collapsible, and the collapse state persists per context.

**Empty state:** a single quiet line — nothing scheduled — with no illustration and no call to action. This surface must not shout when it has nothing to say.

### 6.8 Data behavior

Every mutation applies optimistically to the local UI and reconciles with the server after. A failed write rolls the UI back and surfaces a toast explaining what didn't save, with a retry.

Loss of connectivity shows a non-blocking indicator in the header. Already-loaded data stays on screen and readable. Writes attempted while offline fail with the same rollback-and-retry treatment — nothing is queued.

Concurrent writes from two devices resolve last-write-wins. There is no merge logic and no conflict UI.

---

## 7. Domain logic

### 7.1 Difficulty-weighted progress

A board's progress is the share of its **difficulty weight** that has been completed, not the share of its task count.

Each task contributes weight equal to its difficulty. A task whose difficulty was never set contributes the midpoint weight of 3. This choice is deliberate: on a board where no difficulties are assigned, every task weighs the same and the result is exactly the plain completed-over-total ratio — the weighted model degrades gracefully into the simple one with no special-casing.

Progress is the completed weight over the total weight, expressed as a whole-number percentage. A board with no tasks reads 0% and its bar renders empty, not full.

The number and the bar update together whenever any task is completed, un-completed, created, deleted, moved, or has its difficulty changed.

### 7.2 Up Next selection

Up Next ranks by urgency, not importance, because importance is what the boards are for. Selection principles, in order:

- Only incomplete tasks, only from the current context, only ones with a due date, never blocked ones.
- Overdue tasks outrank everything and appear first, most-overdue first.
- Remaining tasks sort by due moment ascending. A task with a date and time sorts at that time; a task with a date and no time sorts at the end of that day, so a timed meeting precedes an untimed same-day task.
- Ties break toward the priority-flagged task, then toward the higher difficulty, then arbitrarily but stably — the order must not shuffle between renders.

### 7.3 Ordering semantics

A task's position is meaningful only within its board's active list. Completed tasks retain no meaningful position. A newly created task goes to the end of the active list. A task moved from another board goes to the end. An un-completed task goes to the end.

Reordering must be persisted the moment the drag is released, optimistically reflected before the server confirms, and rolled back visibly if the write fails.

---

## 8. UI/UX & design system

This section is the complete design specification. Build from it directly; the design skills that produced it are not needed downstream.

**Precedence stack that produced this:** `design-taste-frontend` (authoritative) → `design-cornerstone` (the owner's house language) → `apple-design` (application register) + `emil-design-eng` (motion craft) → `high-end-visual-design` (aesthetic pack, applied selectively).

Two conflicts were resolved during authoring, and the resolutions are binding: **icons are Phosphor, not Lucide** (design-taste-frontend overrides the cornerstone's house default), and **the aesthetic pack's marketing-scale conventions do not apply** — no 96px+ section padding, no asymmetric bento, no editorial hero. What is taken from the pack is its material language: banned generic fonts, ultra-light iconography, no flat 1px grey borders, no harsh drop shadows, custom cubic-bézier easing everywhere, and the nested-enclosure treatment on the board card.

### 8.1 Design read and dials

**Reading this as:** a single-user productivity application for its own author, with a utilitarian-precision language, leaning toward native Tailwind v4 + Geist + spring-driven motion in the cornerstone's app ("Nucleus") register.

| Dial | Value | Why |
|---|---|---|
| `DESIGN_VARIANCE` | **3** | A tool used every day must be structurally predictable. Delight lives in motion, not in layout surprises. Symmetric, gridded, calm. |
| `MOTION_INTENSITY` | **7** | High, because satisfying drag-and-drop is a stated requirement — but not 9. Every animation stays interruptible and never delays input. |
| `VISUAL_DENSITY` | **6** | A full board should be legible at a glance without scrolling more than necessary. Denser than a marketing page, looser than a dashboard. |

### 8.2 Color tokens

One accent, performing all interactive duty: primary actions, active states, selection, links, focus rings, checked checkboxes, progress fill. Nothing else is allowed to be orange. Positive and negative are reserved strictly for semantics — success and destructive/overdue — and never appear decoratively. There is no warning role; nothing in v1 needs one.

**Dark theme (default):**

| Role | Value | Use |
|---|---|---|
| `--bg` | `#0B0B0C` | App background |
| `--surface` | `#141416` | Cards, rows, board panels, sheets |
| `--surface-2` | `#1C1C1F` | Recessed wells: inputs, segmented-control track, progress track |
| `--text` | `#F2F2F3` | Primary text |
| `--text-secondary` | `#A0A0A6` | Labels, metadata, board names in Up Next |
| `--text-tertiary` | `#6B6B72` | Placeholders, completed-task text, timestamps |
| `--hairline` | `rgba(255,255,255,0.08)` | 1px dividers |
| `--accent` | `#FF8A3D` | All interactive duty |
| `--accent-tint` | `rgba(255,138,61,0.14)` | Secondary button fills, selected chips, focus glow |
| `--on-accent` | `#140A03` | Text and icons on accent fills |
| `--positive` | `#3FBF7F` | Success confirmations only |
| `--negative` | `#F0544F` | Destructive actions, errors, overdue dates |
| `--scrim` | `rgba(0,0,0,0.50)` | Under sheets and modals |

**Light theme:**

| Role | Value |
|---|---|
| `--bg` | `#FAFAF9` |
| `--surface` | `#FFFFFF` |
| `--surface-2` | `#F1F1EF` |
| `--text` | `#16161A` |
| `--text-secondary` | `#5C5C63` |
| `--text-tertiary` | `#94949C` |
| `--hairline` | `rgba(0,0,0,0.08)` |
| `--accent` | `#D9611C` |
| `--accent-tint` | `rgba(217,97,28,0.10)` |
| `--on-accent` | `#FFFFFF` |
| `--positive` | `#16A34A` |
| `--negative` | `#DC2626` |
| `--scrim` | `rgba(0,0,0,0.40)` |

Structure is identical between themes; only surface values change. Verify 4.5:1 on text and 3:1 on UI elements in both. Theme changes ease over ~200ms rather than snapping.

**Shadows** are soft and vertical, never harsh: a barely-there small shadow on raised rows, a medium one on popovers and the dragged row, a large diffused one on sheets. In dark theme, elevation is communicated primarily by a lighter surface step rather than shadow.

### 8.3 Typography

Geist Sans throughout, self-hosted. `font-variant-numeric: tabular-nums` applied globally to every figure — percentages, counts, dates, times, durations. Proportional figures in any aligned or changing number is a defect.

| Role | Size (mobile) | Weight | Tracking | Leading |
|---|---|---|---|---|
| Progress percentage / hero figure | 32px | 700 | −0.02em | 1.05 |
| Board title | 22px | 700 | −0.01em | 1.15 |
| Section header (e.g. "Completed · 7", "Up Next") | 13px, uppercase | 600 | +0.02em | 1.2 |
| Task name / row label | 16px | 500 | 0 | 1.3 |
| Body / notes | 15px | 400 | 0 | 1.5 |
| Metadata chips, dates, durations | 12px | 500 | +0.01em | 1.35 |

Scale up roughly 1.125× at desktop breakpoints. Sizes in rem so user text-size settings are respected. Hierarchy comes from weight and size together — never from adding color.

### 8.4 Spacing, radii, and component anatomy

4px grid throughout. Screen gutters 16px mobile, 24–32px desktop. Card internal padding 16–20px. Vertical rhythm between sections 24–32px — this is application UI, not a landing page.

Radii: 8px for chips and small controls, 12px for buttons and task rows, 16px for board cards, 24px for sheet top corners, fully rounded for primary buttons and pips.

**Buttons.** Three tiers, one primary per view. Primary is a fully-rounded pill in accent fill with `--on-accent` text at 600 weight, 48px tall, full-width in sheets. Secondary is the same pill shape in `--accent-tint` with accent text. Tertiary is plain accent text with no container. Destructive is text or tint in `--negative`. Every decision surface — the delete confirmation especially — pairs its primary with a de-emphasized escape ("Cancel"). Disabled is reduced opacity on the same shape, never a grey restyle. Loading replaces the label with a spinner inside the same pill; the button never changes size.

**Task row.** The workhorse component, approximately 56px tall at minimum and growing with content. Left to right: checkbox (24px hit area inside a ≥44px target) → task name → a trailing cluster of metadata chips. The chip cluster shows only the fields that are set — an unadorned task shows nothing but its name, which is the common case and must look intentional, not empty. Chips, in order: due date/time, duration, difficulty pips, priority marker, blocked marker, notes indicator. Chips are 12px text at tertiary or secondary contrast with a small leading Phosphor glyph. The entire row is the tap target for opening the composer; the checkbox is a separate target that does not open it.

**Difficulty pips.** Five small segments. Filled segments in `--text-secondary`, empty in `--hairline` — deliberately *not* accent, because difficulty is data, not interaction. In the composer the pips become tappable and the filled state moves to accent while focused, since there it *is* a control.

**Priority marker.** A single small filled Phosphor glyph in `--accent`. This is legitimate accent use: it is a toggle-able control in the composer and a state indicator in the row.

**Blocked marker.** A small glyph in `--text-tertiary`, and the row's name drops to `--text-secondary`. Blocked tasks read as recessed without reading as complete.

**Board card** (tab home). The one place the aesthetic pack's nested-enclosure treatment applies: an outer shell at `--surface` with a hairline and a 16px radius, holding an inner content area with a concentric smaller radius. Contains the board name, an optional one-line description at secondary contrast, the progress bar, the percentage as a tabular figure, and a task count ("7 of 12"). Long-press or drag handle initiates reorder.

**Progress bar.** A recessed track in `--surface-2` at full pill radius, 6px tall, with an accent fill. The fill animates its width via `transform: scaleX` from a left origin — never by animating the `width` property. The percentage figure beside it uses a number ticker that rolls digits on change.

**Segmented control** (Personal / Work). The elevated-thumb variant: a recessed `--surface-2` track, the selected segment raised in `--surface` with a small soft shadow, hairline dividers only between unselected segments. The thumb slides on selection change via layout animation — it never teleports.

**Inputs.** `--surface-2` wells at 12px radius with no border at rest; focus adds a 2px accent ring. Labels above at 13px/500, errors below in `--negative`, validated on blur.

**Composer.** A bottom sheet on narrow viewports with 24px top corners, a centered grabber handle, over the scrim; a centered modal on wide viewports. Fields in order: name, notes, due date, due time, duration chips, difficulty pips, priority toggle, blocked toggle. A "Move to board" action and a destructive "Delete task" action sit isolated at the bottom.

**Toasts.** Full-width cards at 12px radius with a leading semantic glyph in a circular chip, one line of message, trailing dismiss. Enter and exit from the same edge, swipe-to-dismiss along that axis, timers pause when the tab is hidden. Stacked toasts scale and offset their predecessors slightly.

**Empty, loading, and error states are required for every list surface.** Empty boards: one quiet line plus the quick-add already focused. Loading: skeleton rows matching the real row geometry with a shimmer — never a lone centered spinner in a content area. Error: plain language about what happened plus a retry.

**Iconography:** Phosphor at one weight globally, 20px in rows, 16px in chips, `--text-secondary` unless active or semantic. No hand-drawn SVG paths. No emoji anywhere in the interface.

**Imagery:** none. This app has no illustrations, no stock photography, and no decorative graphics. Its empty states are typographic.

### 8.5 Motion doctrine

Every animation must answer "why does this animate?" with spatial consistency, feedback, state indication, or preventing a jarring change. **Frequency governs everything:** keyboard-initiated actions get no animation, ever. Actions performed a hundred times a day get the minimum that still communicates.

**House easing curves.** Never the CSS keywords — never `linear` or `ease-in-out` as written, and never `ease-in` on any UI transition, because it delays the exact moment the user is watching.

| Curve | Value | Use |
|---|---|---|
| Standard out | `cubic-bezier(0.23, 1, 0.32, 1)` | Entrances, responses, state changes |
| On-screen movement | `cubic-bezier(0.77, 0, 0.175, 1)` | Elements moving between positions |
| Drawer | `cubic-bezier(0.32, 0.72, 0, 1)` | Sheets and drawers |

**Durations.** Button press feedback 100–160ms. Tooltips and small popovers 125–200ms. Dropdowns 150–250ms. Sheets and modals 200–300ms. **Hard ceiling: no UI animation exceeds 300ms.**

**Springs, not durations, for anything touchable mid-flight.** Think in damping ratio and response. Default UI spring: damping 1.0, response 0.3–0.4 — critically damped, no overshoot. Reposition: 1.0 / 0.4. Sheets: 0.8 / 0.3. Bounce is earned by momentum only: a flicked row may overshoot slightly; a menu that faded in may not. Keep any bounce in the 0.1–0.3 range. This product's personality is crisp and precise, not playful — when in doubt, remove the bounce.

**Interruptibility is the single most important principle.** Never lock input during a transition. Always animate from the live presentation value, never the logical target, or the element visibly jumps on interrupt. Use CSS transitions or springs — never `@keyframes` — for anything rapidly re-triggered, because keyframes restart from zero while transitions retarget. On reversal, blend velocity rather than cutting it.

**Press feedback** is `scale(0.97)` on pointer-down with a 160ms out-curve, on every pressable element. On pointer-down, not on release.

**Spatial consistency.** Sheets enter from the bottom edge and dismiss downward, the way they came. Popovers and menus scale from 0.96 with their transform origin at the trigger, never at their center. Modals are the one exception and stay center-origin. Nothing ever animates from `scale(0)` — real things do not appear from nothing.

**The drag-to-reorder gesture — specified in full, because this is the app.**

- Initiation: on touch, a 200ms long-press with roughly 10px of hit-slop, so scrolling never accidentally becomes dragging. On a fine pointer, dragging begins after about 6px of movement from pointer-down, immediately.
- On grab, the row lifts: scale to ~1.02, elevate to the medium shadow, raise above its siblings. 150ms, out-curve.
- Tracking is 1:1 with the pointer and **respects the grab offset** — the row does not jump so its center meets the finger. Use pointer capture so tracking survives the pointer leaving the row's bounds. Ignore additional touch points once a drag is underway.
- Displaced rows move out of the way with a layout animation, spring damping 1.0 / response 0.35. They move; they never teleport, and they never all move at once as a block.
- At the list boundaries, apply progressive rubber-band resistance rather than a hard stop.
- Near the viewport edges during a drag, the list auto-scrolls, accelerating with proximity to the edge.
- On release, hand the pointer's velocity into the settling spring so there is no seam between dragging and animating. Project where the gesture was going before choosing the landing slot — a flick should throw the row further than its release point.
- The completed group is not a valid drop target; a row dragged over it is refused with a visible boundary rather than silently accepted.
- Persist on release, optimistically. If the write fails, animate the row back to its origin — do not snap it.

**The completion transition — the other interaction that matters.**

- The checkbox responds on pointer-down with press feedback.
- The check mark draws in rather than appearing: a clip-path or stroke reveal over ~180ms with the out-curve, while the box fills to accent.
- The row's text and chips crossfade to their completed contrast over ~150ms, with the strikethrough drawing across the name rather than appearing instantly.
- The row then travels to the Completed group via a layout animation, spring 1.0 / 0.4, while the rows above close the gap in the same motion. This is one continuous movement, not a disappearance followed by an appearance.
- The progress bar's fill scales to its new value over 200ms with the out-curve, and the percentage figure tickers its digits.
- The undo toast enters from the bottom edge.
- Un-checking runs the same sequence in reverse geometry — the row travels back up to the bottom of the active list.

**Other motion.**

- Up Next entries and board cards stagger in on first paint at 40ms intervals, fading and rising 8px. Never on subsequent renders — only the cold load.
- The Completed group collapses and expands via height and opacity together; this pairing needs tuning by feel, not by formula.
- The context segmented control's thumb slides via layout animation, ~200ms.
- Theme changes ease rather than snapping.
- Use a subtle blur to bridge any crossfade where two states look like two different objects; keep blur under 20px for Safari's sake.
- Loading uses skeletons with a linear shimmer; action buttons use fast spinners. Linear easing is legal for shimmers and spinners and nowhere else.

**Performance and accessibility, non-negotiable.**

- Animate `transform` and `opacity` only. Width, height, margin, padding, top, and left are layout-triggering and are defects.
- Do not drive child transforms through a parent CSS variable — set transform on the element.
- `will-change` only where motion is imminent.
- `prefers-reduced-motion: reduce` is gentler, not zero: keep opacity and color fades that aid comprehension, drop movement, springs, parallax, and overshoot. Drag must still function.
- Gate all hover motion behind `@media (hover: hover) and (pointer: fine)` — touch devices false-positive hover on tap.
- Every interactive element has default, hover (gated), active, focus-visible, and disabled states.

### 8.6 Design acceptance criteria

```markdown
- [ ] One accent color performs all interactive duty; red/green reserved for semantics
- [ ] All figures use tabular numerals; the progress percentage tickers rather than jumping
- [ ] Button hierarchy: one filled pill primary per view; every decision screen has a de-emphasized escape hatch
- [ ] Sheets/popovers respect spatial origin: enter/exit along the same path; popovers scale from trigger
- [ ] All UI motion < 300ms, custom cubic-bezier or spring, transform/opacity only, no scale(0), no ease-in
- [ ] Keyboard-triggered actions have NO animation
- [ ] prefers-reduced-motion + hover gating (`@media (hover: hover) and (pointer: fine)`) implemented
- [ ] Press feedback (scale 0.97) on all pressable elements, on pointer-down
- [ ] Light and dark theme both specified from token roles; structure identical across themes
- [ ] Touch targets >= 44px; spacing on 4px grid; radii from the scale above
- [ ] Drag tracks 1:1, respects grab offset, uses pointer capture, hands off release velocity
- [ ] No banned fonts (Inter/Roboto/Helvetica/Arial/Open Sans); no hand-rolled SVG icons; no emoji
- [ ] Every list surface has empty, loading, and error states
```

---

## 9. Screens

### 9.1 Login

Full-viewport, vertically centered, single column, narrow measure. Contains: the wordmark, a single password field (type password, autofocus, autocomplete current-password), and a full-width primary pill reading "Unlock". Nothing else — no links, no secondary actions, no marketing.

*Empty:* the resting state. *Submitting:* spinner inside the pill, field disabled. *Error:* inline message beneath the field in `--negative`, field shakes once — a short horizontal wiggle, well under 300ms, suppressed under reduced motion. *Rate limited:* the message states the cooling-off period and the button disables until it elapses.

Navigation out: on success, to the last-used context's home, or to the destination the user was originally trying to reach.

### 9.2 App shell

Persists across every authenticated screen. A translucent header over scrolling content, using backdrop blur with a solid fallback under `prefers-reduced-transparency`, and a scroll-edge fade rather than a permanent 1px border beneath it.

Header contents: the wordmark or a compact back affordance depending on depth · the Personal/Work segmented control, centered · a trailing overflow menu containing theme toggle, archived boards, and log out. An offline indicator appears in the header when connectivity is lost and animates in from the top edge.

On narrow viewports, the segmented control takes the full width of a second header line rather than compressing.

### 9.3 Context home

The default screen. Vertical order:

1. **Up Next**, anchored at the top, per §6.7. Section header "Up Next" with a collapse chevron. Below it, the card row.
2. **Boards.** A section header showing the board count, with a trailing "New board" tertiary action. Below it, board cards — single column on narrow viewports, two columns on wide. Each card per §8.4. Cards reorder by drag.

*Empty (no boards):* one typographic line explaining that boards are projects, and a primary "Create your first board". Up Next is hidden entirely rather than showing its own empty state — two empty states stacked is a wasteland.
*Loading:* skeleton cards matching real card geometry, shimmering.
*Error:* plain-language failure line plus a retry button; the header and tabs remain functional.

Navigation: tapping a board card pushes to the board. Tapping an Up Next entry pushes to that board and highlights the task.

### 9.4 Board

Vertical order:

1. **Board header.** Board name as the screen title, optional description beneath at secondary contrast, then the progress bar with its percentage and task count. A trailing overflow menu: rename, edit description, archive, delete.
2. **Active tasks.** The ordered, draggable list of incomplete tasks. Each row per §8.4.
3. **Quick add.** A persistent single-line input pinned below the active list — and pinned to the bottom of the viewport on mobile above the keyboard when focused. Placeholder invites a task name. Enter commits and keeps focus. A trailing expand affordance opens the full composer pre-filled with whatever has been typed.
4. **Completed group.** Header "Completed · N" with a collapse chevron, then the greyed rows.

*Empty (no tasks):* the progress bar renders empty at 0%, and a single line sits above the quick-add, which is already focused. No illustration.
*All complete:* the active list shows a brief line of acknowledgement; the progress bar is full; the Completed group holds everything.
*Loading:* skeleton rows.
*Error:* retry line in place of the list; the header and quick-add stay visible.

Navigation: back to the context home, always top-left.

### 9.5 Task composer

Bottom sheet on narrow viewports, centered modal on wide. Per §8.4.

*Create mode:* title "New task", primary "Add". *Edit mode:* title is the task name, primary "Save", and the destructive delete and "Move to board" actions appear at the bottom.

Dismissal: the primary action, an explicit close in the top-left, tapping the scrim, or dragging the sheet down with velocity-based dismissal. Unsaved changes on dismiss are discarded silently in create mode; in edit mode, if fields changed, confirm before discarding.

*Validation:* the name field is required and validates on blur; every other field can be left empty and the primary action stays enabled regardless.

### 9.6 Board editor

A compact sheet or modal with the board name field, the optional description field, and a primary confirm plus a tertiary cancel. Used for both create and rename.

### 9.7 Delete confirmation

A centered modal. States the board or task name explicitly and, for boards, the number of tasks that will be destroyed. Primary action is destructive-styled and reads with the specific verb ("Delete board"), never "OK". A de-emphasized "Cancel" always sits beside it.

### 9.8 Archived boards

Reached from the header overflow menu. A simple list of archived boards in the current context, each row showing the name and its final progress figure, with an unarchive action and a delete action. *Empty:* one line stating nothing is archived. Navigation: back to the context home.

---

## 10. Out of scope — design for, do not build

These are deliberately excluded from v1. Do not build them. Do not add abstractions, flags, or scaffolding "ready" for them beyond what costs nothing:

- Recurring tasks and any recurrence rule system
- Push notifications, reminders, and email digests
- Offline write queueing, sync, and conflict resolution
- Tags, labels, or any user-defined taxonomy
- Sub-tasks nested inside tasks
- More than two contexts, or user-creatable contexts
- Dragging tasks between boards
- Search and filtering
- Statistics, streaks, velocity, or completion history views (the timestamps are recorded, nothing reads them)
- Sharing, collaboration, comments, or any second user
- File attachments
- Calendar integration or ICS export
- Themes beyond the specified light and dark
- Any account management: registration, password reset, email

---

## 11. Confirm before starting

- **The domain and subdomain** the app deploys to, and confirmation that the Cloudflare zone is already configured. Do not guess at DNS records.
- **How the initial password is set** — the owner will supply the mechanism they prefer for getting a hash into the deployment environment. Do not invent a registration flow or ship a default password.
- **The product name and wordmark treatment** if "Cairn" is not final.
