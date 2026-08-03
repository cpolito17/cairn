/**
 * The app shell. PROJECT-SPEC.md §9.2, §8.4, §8.5.
 *
 * A translucent header over scrolling content — backdrop blur with a solid
 * `--surface` fallback under `prefers-reduced-transparency`, and a scroll-edge
 * fade instead of a permanent hairline, so a page scrolled to the top has no
 * line under its header at all.
 *
 * Contents: the wordmark, or a compact back affordance once the user is a level
 * deep · the Personal/Work segmented control, centered · a trailing overflow
 * menu with the theme toggle, archived boards, and log out. On narrow viewports
 * the segmented control drops to a full-width second line rather than
 * compressing — one control, moved by the grid in `index.css`, not two
 * instances fighting over the same `layoutId`.
 *
 * Switching context is local state and nothing else: `/api/state` already holds
 * both contexts, so there is no fetch to make.
 */

import {
  Archive,
  CaretLeft,
  CloudSlash,
  DotsThreeVertical,
  Moon,
  SignOut,
  Sun,
} from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as api from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useStore } from '../lib/store';
import { CONTEXTS, type Context } from '../../shared/types';
import { Segmented } from './ui/Segmented';

/** §8.5 standard out curve. */
const OUT = [0.23, 1, 0.32, 1] as const;

const CONTEXT_OPTIONS = CONTEXTS.map((value) => ({
  value,
  label: value === 'personal' ? 'Personal' : 'Work',
}));

export function AppShell({ children, onSignedOut }: { children: ReactNode; onSignedOut(): void }) {
  const route = useRoute();
  const context = useStore((state) => state.context);
  const setContext = useStore((state) => state.setContext);
  const online = useStore((state) => state.online);
  const [scrolled, setScrolled] = useState(false);

  // The scroll-edge fade appears only once there is content behind the header.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 2);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const deep = route.name !== 'home';

  return (
    <div className="min-h-dvh">
      <header
        className="app-header theme-eased sticky top-0 z-30"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <AnimatePresence>{!online && <OfflineIndicator />}</AnimatePresence>

        <div className="app-header-grid px-gutter py-3">
          <div className="app-header-brand min-w-0">
            {deep ? (
              <button
                type="button"
                onClick={() => navigate('/')}
                className="pressable -ml-2 inline-flex items-center gap-1 rounded-chip px-2
                           py-2 text-text-secondary"
                style={{ minHeight: 'var(--tap-target)' }}
              >
                <CaretLeft size={20} />
                <span className="text-meta" style={{ fontWeight: 600 }}>
                  Boards
                </span>
              </button>
            ) : (
              <span
                className="text-board-title text-text"
                style={{ letterSpacing: '-0.02em' }}
              >
                Cairn
              </span>
            )}
          </div>

          <div className="app-header-segmented">
            <Segmented
              id="context"
              label="Context"
              options={CONTEXT_OPTIONS}
              value={context}
              onChange={(value: Context) => setContext(value)}
            />
          </div>

          <div className="app-header-actions">
            <OverflowMenu onSignedOut={onSignedOut} />
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

/**
 * The trailing overflow menu. It scales from 0.96 with its transform origin at
 * the trigger — top right — rather than at its own center (§8.5).
 */
function OverflowMenu({ onSignedOut }: { onSignedOut(): void }) {
  const [open, setOpen] = useState(false);
  const theme = useStore((state) => state.theme);
  const toggleTheme = useStore((state) => state.toggleTheme);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function logOut() {
    setOpen(false);
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
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        onClick={() => setOpen((was) => !was)}
        className="pressable -mr-2 flex items-center justify-center rounded-chip
                   text-text-secondary"
        style={{ width: 'var(--tap-target)', height: 'var(--tap-target)' }}
      >
        <DotsThreeVertical size={20} weight="bold" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            className="absolute right-0 z-40 mt-1 overflow-hidden bg-surface py-1"
            style={{
              top: '100%',
              minWidth: '200px',
              borderRadius: 'var(--radius-control)',
              border: 'var(--hairline-width) solid var(--hairline)',
              boxShadow: 'var(--shadow-md)',
              transformOrigin: 'top right',
            }}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.16, ease: OUT }}
          >
            <MenuItem
              icon={theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
              onClick={() => {
                toggleTheme();
                setOpen(false);
              }}
            >
              {theme === 'dark' ? 'Light theme' : 'Dark theme'}
            </MenuItem>

            <MenuItem
              icon={<Archive size={20} />}
              onClick={() => {
                setOpen(false);
                navigate('/archived');
              }}
            >
              Archived boards
            </MenuItem>

            <MenuItem icon={<SignOut size={20} />} onClick={logOut}>
              Log out
            </MenuItem>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuItem({
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
      role="menuitem"
      onClick={onClick}
      className="pressable flex w-full items-center gap-3 px-4 text-left text-body text-text
                 hover:bg-surface-2"
      style={{ minHeight: 'var(--tap-target)' }}
    >
      <span className="text-text-secondary">{icon}</span>
      {children}
    </button>
  );
}
