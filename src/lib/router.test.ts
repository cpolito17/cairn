/**
 * The route table and the route → view mapping. PROJECT-SPEC-V2.md §4.1.
 *
 * The mapping is the part worth testing rather than the parsing: `/board/:id`
 * and `/archived` sitting *under* Boards is a decision that is invisible in the
 * URL and easy to undo by accident, and the symptom — the header selector
 * clearing when you open a board — is subtle enough to ship.
 */

import { describe, expect, it } from 'vitest';
import { parseRoute, VIEW_ROOTS, VIEWS, viewOf } from './router';

describe('parseRoute', () => {
  it('reads the three view roots', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/blockers')).toEqual({ name: 'blockers' });
    expect(parseRoute('/planner')).toEqual({ name: 'planner' });
  });

  it('reads the two routes under Boards', () => {
    expect(parseRoute('/archived')).toEqual({ name: 'archived' });
    expect(parseRoute('/board/abc')).toEqual({ name: 'board', id: 'abc' });
  });

  it('decodes a board id', () => {
    expect(parseRoute('/board/a%2Fb')).toEqual({ name: 'board', id: 'a/b' });
  });

  it('does not mistake a deeper path for a known route', () => {
    expect(parseRoute('/planner/week')).toEqual({ name: 'notFound', path: '/planner/week' });
    expect(parseRoute('/board/abc/edit')).toEqual({ name: 'notFound', path: '/board/abc/edit' });
  });
});

describe('viewOf', () => {
  it('keeps Boards selected a level deep', () => {
    expect(viewOf({ name: 'board', id: 'abc' })).toBe('boards');
    expect(viewOf({ name: 'archived' })).toBe('boards');
  });

  it('maps each view root to its own view', () => {
    expect(viewOf({ name: 'home' })).toBe('boards');
    expect(viewOf({ name: 'blockers' })).toBe('blockers');
    expect(viewOf({ name: 'planner' })).toBe('planner');
  });

  it('selects nothing on a path the app does not have', () => {
    expect(viewOf({ name: 'notFound', path: '/nope' })).toBeNull();
  });
});

describe('VIEW_ROOTS', () => {
  it('covers every view, and each root maps back to its own view', () => {
    for (const view of VIEWS) {
      const root = VIEW_ROOTS[view];
      expect(root).toBeTruthy();
      // The round trip is what makes selecting a view from a board land
      // somewhere the selector then agrees with.
      expect(viewOf(parseRoute(root))).toBe(view);
    }
  });
});
