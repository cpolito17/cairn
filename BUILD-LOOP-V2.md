# Cairn V2 — Build Loop

Eight issues, flat and ordered, numbered 23 through 30 so they continue the v1
sequence. Work them in numerical order — each one assumes the previous ones
landed. There is no runbook beyond this file.

`PROJECT-SPEC-V2.md` is the governing document. `PROJECT-SPEC.md` still holds
everywhere V2 does not revise it, and its §8 design system and §8.5 motion
doctrine are binding on every ticket here.

## The loop

1. **Set the effort** from the issue's `effort:` label. All eight tickets run on
   Opus 5; only the effort dial changes.
2. **Clear context** between issues. Every issue is written to be self-contained
   against the repo as the previous issue left it — carrying context forward
   costs more than it saves and lets stale assumptions leak between tickets.
3. **Paste the start prompt** for that issue from below.
4. **Verify by exercising the artifact** — run it, click it, drag it — against
   the issue's acceptance criteria. Not by reading the worker's summary of what
   it did. Then commit with `Closes #N`.

If a worker misses the same acceptance criterion twice, clear context and re-run
at the next effort step up rather than arguing with it in place.

**One standing warning for this release.** Issue #23 contains a one-way data
migration: the `duration` column is dropped after its values are converted to
minutes. Apply it to the remote database before deploying the Worker, per
`docs/DEPLOY.md`, and do not let a later ticket "fix" a schema mismatch by
editing an already-applied migration file.

---

## Start prompts

### Issue #23 — Data foundations: minutes, scheduling, settings, Up Next

> Read `PROJECT-SPEC-V2.md` §2, §3, and §8 in full, plus `PROJECT-SPEC.md` §6.4,
> §6.8, and §7.3. Then read GitHub issue #23 in full and implement it.
>
> This ticket is the whole schema change for V2 and every later issue is built
> on it, so it is the one that must be exactly right. Write the migration as its
> own file, convert every `duration` value to minutes before dropping the
> column, and verify the conversion against a local database with rows of every
> old value in it — including `half-day`. Write the domain tests first: the
> lane-packing cases, the 15-minute snap, the midnight refusal, and the full
> three-tier Up Next ranking including the 24-hour priority bonus. Then make
> them pass. Build no UI beyond the composer's duration chips. Exercise the
> endpoints against `wrangler dev` and report what each check actually
> returned.

### Issue #24 — Navigation, settings sheet, and eight themes

> Read `PROJECT-SPEC-V2.md` §4 and §5 in full, plus `PROJECT-SPEC.md` §8.2
> (colour tokens), §8.4 (segmented control, inputs, sheets), and the
> press-feedback, thumb, and theme paragraphs of §8.5.  Then read GitHub issue
> #24 in full and implement it.
>
> Two things in this ticket are easy to get subtly wrong. The view selector
> replaces the context selector *in place* — same component, same layout
> animation, same narrow-viewport second line — and `/board/:id` and `/archived`
> must keep Boards selected rather than clearing the selector. And every one of
> the four new themes has to be contrast-verified in place, in both the
> smallest text roles and the UI elements, not assumed from the hex values in
> the spec; adjust and report any value you had to change. Render placeholders
> for `/blockers` and `/planner`; those are later issues. Report each acceptance
> criterion with what you observed.

### Issue #25 — Planner: week and day views, task list, grid

> Read `PROJECT-SPEC-V2.md` §6.1 through §6.6 and §6.8 in full, plus
> `PROJECT-SPEC.md` §8.3, §8.4, and the stagger and reduced-motion paragraphs of
> §8.5 — skip §6.7 of the V2 spec entirely, the drag is the next issue. Then
> read GitHub issue #25 in full and implement it.
>
> This is a large surface and all of it is specified; build from the spec rather
> than inventing. Read through the store's selectors and the pure modules from
> issue #23 — never compute lane packing, sort order, or heat-map buckets in a
> component. Every list surface needs its empty, loading, and error state in this
> ticket, not later. Blocks render, move nothing: no dragging, no resizing, no
> keyboard placement. Walk the acceptance criteria in a browser and report the
> real result of each, including the 375px day-view check and the eight-theme
> pass.

### Issue #26 — Planner: drag, resize, and keyboard scheduling

> Read `PROJECT-SPEC-V2.md` §6.7 in full — it is the governing document for this
> work — plus §2 and §3.1, and `PROJECT-SPEC.md` §2, §5 (the drag-and-drop
> constraint), and §8.5 in full. Then read GitHub issue #26 in full and
> implement it.
>
> This is the interaction V2 is judged on, and it is a *second* primitive rather
> than an extension of `Reorderable` — cross-surface, two-dimensional, with a
> resize edge. Every requirement in §6.7 is binding: grab-offset respect,
> pointer capture, 1:1 tracking, the dragged item taking its duration's real
> height, 15-minute snapping with a previewed slot, edge auto-scroll,
> release-velocity handoff, mid-flight interruption, Escape-to-cancel, and
> resize resistance at the boundaries. Transform and opacity only — the live
> resize is the hard case and animating `height` is a defect. Never lock input.
> The keyboard path is not optional and is not decoration; it must actually
> schedule a task end to end, and it must animate nothing.
>
> No test can confirm this ticket. Verify it with your hands: a real iPhone in
> Safari and a desktop trackpad in Chrome. Report which criteria you physically
> exercised and on what device — if you could not test something on hardware,
> say so plainly rather than marking it passed.

### Issue #27 — Planner: month and year views

> Read `PROJECT-SPEC-V2.md` §6.5 and §6.6, plus §3.2 for the working-hours
> value the heat-map buckets are measured against. Then read GitHub issue #27 in
> full and implement it.
>
> Both views are read-and-navigate only — no drag scheduling, per §11 of the V2
> spec. The bucketing is a pure function with tests: a day at exactly 25% of a
> workday, a day above 100%, a day of nothing, and a null-duration block
> counting as 30 minutes. Both contexts' blocks count toward the heat; only the
> current context's appear by name in the tooltip. Verify the month grid across
> a month that starts on a Sunday and one that needs six rows, and verify the
> year grid at 375px.

### Issue #28 — Blockers

> Read `PROJECT-SPEC-V2.md` §7 in full, plus `PROJECT-SPEC.md` §6.4's
> waiting-on row, §8.2, and §8.4's task-row and blocked-marker paragraphs. Read
> `shared/dependencies.ts` before writing anything. Then read GitHub issue #28
> in full and implement it.
>
> The data is a forest of trees, not a general graph — each task has at most one
> prerequisite. Do not add a graph library; the depth and tidy-tree layout are
> pure functions that belong in a shared module with unit tests, including the
> cases that bite: a root with many dependents, a chain five deep, a board of
> entirely standalone tasks, and data that already contains a cycle. The colour
> rules are the ones in §7.4 and they are deliberate — neutral ramp, accent for
> open, `--negative` on overdue chips only. No red edges. Auto-scroll fires on
> mount and never again. Report each acceptance criterion with what you
> observed, including the reduced-motion and 375px passes.

### Issue #29 — Animation review pass

> Invoke the `review-animations` skill. Read `PROJECT-SPEC.md` §8.5 and §8.6 and
> `PROJECT-SPEC-V2.md` §10, then read GitHub issue #29 in full.
>
> Review every piece of motion added by issues #24 through #28 — enumerate the
> files, do not sample. The standard defaults to flagging; approval is earned.
> Escalate on sight for the patterns listed in the issue, and pay particular
> attention to the two places V2 makes them likely: the live block resize, where
> animating `height` is the obvious wrong answer, and the Blockers edge
> transitions. For each surviving animation, answer "why does this animate?"; an
> animation that cannot answer gets removed rather than tuned. Produce a
> `| Before | After | Why |` table covering every finding, post it as a comment
> on issue #29, and apply the fixes in the same change. Do not add animations
> the spec does not call for, and do not touch anything that is not motion code.

### Issue #30 — Full-output enforcement pass

> Invoke the `full-output-enforcement` skill. Read GitHub issue #30 in full.
>
> Walk every source file in `worker/`, `shared/`, `src/`, `migrations/`, and the
> root configs — every file, no sampling. Find and complete every placeholder,
> abridged file, and stub function left behind by issues #23 through #29.
> Complete what is missing; change nothing that is present and working. No
> refactors, no renames, no restyling, no added tests beyond what a completed
> stub requires. Pay specific attention to the dead ends the duration migration
> leaves: any surviving reference to the `Duration` string union, the
> `DURATIONS` array, `isDuration`, or `'half-day'` anywhere in the tree is a
> defect this ticket closes. If a stub cannot be finished without a design
> decision, stop and flag it in a comment on issue #30 instead of inventing
> behavior. Finish by running `tsc --noEmit`, the tests, and the build, and
> report the actual output of each.

---

## Standing rules for every ticket

- Build only what the spec specifies. No features, no abstractions for
  hypothetical futures, no error handling for cases that cannot occur.
- Validate at system boundaries — user input and external requests — and trust
  internal code.
- Report against what actually passed. If a check fails, say so with the output.
  If a step was skipped, say that.
- The decisions table in `PROJECT-SPEC-V2.md` §2, the "Decisions already made"
  table in `PROJECT-SPEC.md` §3, and the architecture block in each issue are
  settled. Implement them; do not relitigate them.
- No new runtime dependencies. `motion`, `zustand`, `@phosphor-icons/react`, and
  React are the whole list, and V2 does not extend it — no calendar library, no
  graph library, no drag-and-drop library, no date library.
