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
 * **That move is why the context label exists** (V2 §4.2). A mode you cannot
 * see is a mode you file things into by accident, and the per-context theme
 * only carries that for someone who has set two different ones. The label says
 * it outright, on every route, and it stays when the wordmark is replaced by
 * the back affordance — a level deep is exactly where "which tab am I in" is
 * least obvious.
 *
 * Switching context is local state and nothing else: `/api/state` already holds
 * both contexts, so there is no fetch to make.
 */

import { CaretLeft, CloudSlash, Gear } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { navigate, useRoute, VIEW_ROOTS, viewOf, type View } from '../lib/router';
import { useStore } from '../lib/store';
import { SettingsSheet } from './SettingsSheet';
import { Segmented } from './ui/Segmented';
import { OUT } from '../lib/motion';

const VIEW_OPTIONS: { value: View; label: string }[] = [
  { value: 'boards', label: 'Boards' },
  { value: 'blockers', label: 'Blockers' },
  { value: 'planner', label: 'Planner' },
];

export function AppShell({ children, onSignedOut }: { children: ReactNode; onSignedOut(): void }) {
  const route = useRoute();
  const context = useStore((state) => state.context);
  const online = useStore((state) => state.online);
  const [scrolled, setScrolled] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The scroll-edge fade appears only once there is content behind the header.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 2);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

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
                <span
                  className="block truncate text-board-title text-text"
                  style={{ fontFamily: 'var(--font-wordmark)', fontWeight: 400, letterSpacing: '-0.01em' }}
                >
                  tasks
                </span>
              )}
            </div>

            {/* V2 §4.2: 12px/500 in --text-secondary, under whichever of the
                two is showing. `aria-live` is deliberately absent — the context
                changes only because the user just changed it, from a sheet that
                closes to reveal this, so announcing it would be reading their
                own action back to them. */}
            <span
              className="block truncate text-text-secondary"
              style={{ fontSize: '12px', fontWeight: 500, lineHeight: 1.35 }}
            >
              {context === 'personal' ? 'Personal' : 'Work'}
            </span>
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
      />
    </div>
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
