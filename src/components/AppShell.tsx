/**
 * The app shell. PROJECT-SPEC.md §9.2, §8.4, §8.5; PROJECT-SPEC-V2.md §4.
 *
 * A translucent header over scrolling content — backdrop blur with a solid
 * `--surface` fallback under `prefers-reduced-transparency`, and a scroll-edge
 * fade instead of a permanent hairline, so a page scrolled to the top has no
 * line under its header at all.
 *
 * Contents: the wordmark, or a compact back affordance once the user is a level
 * deep, with the **active context named beneath either of them** · the
 * Boards/Blockers/Planner segmented control, centered · the gear, which opens
 * the settings sheet. On narrow viewports the segmented control drops to a
 * full-width second line rather than compressing — one control, moved by the
 * grid in `index.css`, not two instances fighting over the same `layoutId`.
 *
 * **The segmented control changed what it controls, in place** (V2 §4.1). It
 * used to switch Personal/Work; it now switches view. It is the same component
 * in the same grid slot with the same sliding thumb, because it is one control
 * that changed its meaning rather than a new control that arrived beside the
 * old one — and the context switch it gave up moved into the settings sheet.
 *
 * **The context label under the wordmark used to say Personal/Work outright**
 * (V2 §4.2) — a mode you cannot see is a mode you file things into by
 * accident. The `ContextToggle` pill now does that job instead, visible in
 * the same header without opening anything, so the small label under the
 * wordmark carries only what the pill does not: the demo notice, when there
 * is one.
 *
 * Switching context is local state and nothing else: `/api/state` already holds
 * both contexts, so there is no fetch to make.
 */

import { Briefcase, CaretLeft, CloudSlash, Gear, User } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isDemo } from '../lib/demo';
import { auditSeenToday, markAuditSeen } from '../lib/overdueAudit';
import { navigate, useRoute, VIEW_ROOTS, viewOf, type View } from '../lib/router';
import { selectOverdue, useStore } from '../lib/store';
import type { Context } from '../../shared/types';
import { OverdueAudit } from './OverdueAudit';
import { SettingsSheet } from './SettingsSheet';
import { Segmented } from './ui/Segmented';
import { Wordmark } from './Wordmark';
import { OUT } from '../lib/motion';

const VIEW_OPTIONS: { value: View; label: string }[] = [
  { value: 'boards', label: 'Boards' },
  { value: 'blockers', label: 'Blockers' },
  { value: 'planner', label: 'Planner' },
];

export function AppShell({ children, onSignedOut }: { children: ReactNode; onSignedOut(): void }) {
  const route = useRoute();
  const context = useStore((state) => state.context);
  const setContext = useStore((state) => state.setContext);
  const online = useStore((state) => state.online);
  const [scrolled, setScrolled] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);

  // The scroll-edge fade appears only once there is content behind the header.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 2);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useOverdueAuditOnFirstVisit(context, () => setAuditOpen(true));

  /**
   * A level deep is `/board/:id` and `/archived` — the two routes that sit
   * *under* Boards. Not `/blockers` or `/planner`: those are views of their
   * own, reached from the selector, and a back affordance on them would offer
   * to return from somewhere the user never descended into.
   */
  const deep = route.name === 'board' || route.name === 'archived';

  /**
   * Null only on `notFound`, where the selector is hidden rather than showing
   * an arbitrary segment selected — a path that is not part of the app is not
   * one of the three views, and claiming otherwise is worse than a gap.
   */
  const view = viewOf(route);

  return (
    <div className="min-h-dvh">
      <header
        className="app-header theme-eased sticky top-0 z-30"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <AnimatePresence>{!online && <OfflineIndicator />}</AnimatePresence>

        <div className="app-header-grid px-gutter py-2">
          <div className="app-header-brand min-w-0">
            {/* Both states share this line box, at the tap-target height the
                back affordance needs. Letting the wordmark set its own height
                would make the header jump by ~19px on every navigation into and
                out of a board — a sticky header that resizes under a scrolled
                page, which is the jarring change §8.5 exists to prevent. */}
            <div className="flex items-center" style={{ minHeight: 'var(--tap-target)' }}>
              {deep ? (
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  className="pressable -ml-2 inline-flex items-center gap-1 rounded-chip px-2
                             text-text-secondary"
                  style={{ minHeight: 'var(--tap-target)' }}
                >
                  <CaretLeft size={20} />
                  <span className="text-meta" style={{ fontWeight: 600 }}>
                    Boards
                  </span>
                </button>
              ) : (
                // text-board-title's own two sizes — 1.375rem / md:1.5rem —
                // so the wordmark image replaces the styled text at the size
                // it held, not just its place.
                <Wordmark className="h-[1.375rem] md:h-[1.5rem]" />
              )}
            </div>

            {/* Personal/Work no longer prints here — the `ContextToggle` pill
                in the header says it now, in one tap's reach instead of a
                passive label. The demo notice is what is left: a visitor who
                cannot tell they are in a sandbox is a visitor who thinks they
                broke something real, and that still belongs under the
                wordmark, in --text-secondary at 12px/500. */}
            {isDemo() && (
              <span
                className="block truncate text-text-secondary"
                style={{ fontSize: '12px', fontWeight: 500, lineHeight: 1.35 }}
              >
                Demo
              </span>
            )}
          </div>

          <div className="app-header-segmented">
            {view && (
              <Segmented
                id="view"
                label="View"
                options={VIEW_OPTIONS}
                value={view}
                // Selecting a view from `/board/:id` goes to that view's root,
                // Boards included — which is what makes Boards a way back out
                // of a board rather than a segment that is already lit and
                // does nothing.
                onChange={(next: View) => navigate(VIEW_ROOTS[next])}
              />
            )}
          </div>

          <div className="app-header-actions">
            {isDemo() && <PortfolioLink />}
            <ContextToggle context={context} onChange={setContext} />

            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
              className="pressable -mr-2 flex items-center justify-center rounded-chip
                         text-text-secondary"
              style={{ width: 'var(--tap-target)', height: 'var(--tap-target)' }}
            >
              <Gear size={20} />
            </button>
          </div>
        </div>

        {/* The scroll edge: a fade, not a 1px border. Opacity only. */}
        <span
          aria-hidden="true"
          className="scroll-fade pointer-events-none absolute inset-x-0 top-full block"
          style={{
            height: '16px',
            opacity: scrolled ? 1 : 0,
            background:
              'linear-gradient(to bottom, color-mix(in srgb, var(--bg) 80%, transparent), transparent)',
          }}
        />
      </header>

      <main className="px-gutter pt-section pb-12">{children}</main>

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSignedOut={onSignedOut}
        onOpenOverdueAudit={() => {
          setSettingsOpen(false);
          setAuditOpen(true);
        }}
      />

      {/* Both entry points land here: the once-a-day prompt above, and the
          Settings row. One owner, so the panel can never be open twice. */}
      <OverdueAudit
        open={auditOpen}
        onClose={() => setAuditOpen(false)}
        context={context}
      />
    </div>
  );
}

function PortfolioLink() {
  return (
    <a
      href="https://charliepolito.com/"
      className="portfolio-link pressable hoverable inline-flex shrink-0 items-center gap-2 rounded-pill
                 bg-surface-2 px-3 text-text-secondary"
      aria-label="Back to CharliePolito.com portfolio"
    >
      <img src="/brand/portfolio-hd.svg" alt="" aria-hidden="true" width="20" height="20" />
      <span className="portfolio-link-label text-meta" style={{ fontWeight: 600 }}>
        CharliePolito.com
      </span>
    </a>
  );
}

/**
 * Open the Overdue Audit on the first visit of the day, per context.
 *
 * Three conditions, and each one is load-bearing:
 *
 *   * **The data has to be there.** Before `/api/state` lands there are no
 *     tasks, so there is nothing overdue and the panel would decide "all clear"
 *     against an empty world.
 *   * **Something has to be overdue.** A panel that opens to say nothing is
 *     wrong is the interruption without the payload.
 *   * **Not already offered today**, in this context (`lib/overdueAudit.ts`).
 *
 * The mark is written the moment it opens, so a reload five minutes later is
 * quiet whether or not anything was triaged.
 *
 * It re-arms on a context switch rather than once per session: Personal and
 * Work keep separate marks, and a first visit to Work is a first visit.
 */
function useOverdueAuditOnFirstVisit(context: Context, open: () => void): void {
  const ready = useStore((state) => state.status === 'ready');
  const overdueCount = useStore((state) => selectOverdue(state, context).length);
  // The opener changes identity every render; the effect must not.
  const latest = useRef(open);
  latest.current = open;

  useEffect(() => {
    if (!ready || overdueCount === 0) return;
    if (auditSeenToday(context)) return;
    markAuditSeen(context);
    latest.current();
  }, [ready, overdueCount, context]);
}

/**
 * The Personal/Work switch, beside the gear rather than inside what it opens
 * (V2 §4.3 moved out — see `SettingsSheet.tsx`). One pill reading the current
 * context — its name, then a `User`/`Briefcase` glyph for it — that flips to
 * the other context on press, rather than a segmented pair: there are only
 * two contexts and this control's whole job is "say which one and let me
 * switch," which one pill already does in the header's tightest slot.
 *
 * A press here does the same thing the old settings-sheet control did on
 * change: the whole app reads from the new context immediately, no fetch and
 * no confirmation, because `/api/state` already holds both.
 */
function ContextToggle({
  context,
  onChange,
}: {
  context: Context;
  onChange(context: Context): void;
}) {
  const personal = context === 'personal';
  return (
    <button
      type="button"
      onClick={() => onChange(personal ? 'work' : 'personal')}
      aria-label={`Switch to ${personal ? 'Work' : 'Personal'}`}
      className="pressable hoverable flex shrink-0 items-center gap-2 rounded-pill bg-surface-2
                 px-3 text-text-secondary"
      style={{ height: 'var(--tap-target)' }}
    >
      <span className="text-meta" style={{ fontWeight: 600 }}>
        {personal ? 'Personal' : 'Work'}
      </span>
      {personal ? <User size={18} /> : <Briefcase size={18} />}
    </button>
  );
}

/**
 * The offline notice. It animates in from the top edge, is non-blocking, and
 * touches nothing already on screen — §6.8 is explicit that loaded data stays
 * readable and undimmed while connectivity is gone.
 */
function OfflineIndicator() {
  return (
    <motion.div
      role="status"
      className="flex items-center justify-center gap-2 overflow-hidden"
      style={{
        background: 'color-mix(in srgb, var(--text-secondary) 12%, var(--surface-2))',
        color: 'var(--text-secondary)',
      }}
      initial={{ y: '-100%', opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: '-100%', opacity: 0 }}
      transition={{ duration: 0.22, ease: OUT }}
    >
      <span className="flex items-center gap-2 py-1 text-meta" style={{ fontWeight: 600 }}>
        <CloudSlash size={16} />
        Offline
      </span>
    </motion.div>
  );
}
