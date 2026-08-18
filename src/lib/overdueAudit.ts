/**
 * When the Overdue Audit last showed itself, per context.
 *
 * The audit exists because an overdue task you cannot act on outranks
 * everything in Up Next and stays there — so the strip fills with work that is
 * not answerable and stops answering "what now?". Triage is the fix, and triage
 * has to be *offered* rather than waited for, because a list you have learned
 * to scroll past is one you will not go and clean up.
 *
 * Once a day, though, and not once a load. An interruption that arrives every
 * time you open the app is one you dismiss reflexively, which is the same
 * failure as the clog it was built to clear.
 *
 * **The mark is a local date string in `localStorage`, per context.** Three
 * decisions in that sentence:
 *
 *   * *A date, not a timestamp.* "Once today" is a calendar question, and the
 *     day rolls over at local midnight whatever the elapsed hours say.
 *   * *`localStorage`, so per device.* Sitting down at a laptop is its own
 *     first visit even if the phone already saw it at 7am — that is when you
 *     are able to act. It also means the audit needs nothing from the server
 *     and can decide before the first paint.
 *   * *Per context.* Everything about Up Next is per context, and Personal's
 *     overdue work is not Work's. Switching context on the first visit of the
 *     day surfaces that context's audit once, too.
 *
 * The mark is written when the panel *opens*, not when it is acted on. Closing
 * it without triaging anything is a decision, and re-asking on the next reload
 * would be refusing to take it.
 */

import { isoDate } from './dates';

const key = (context: string): string => `cairn:overdue-audit:${context}`;

/** True when the audit has already opened by itself today, in this context. */
export function auditSeenToday(context: string, now: number = Date.now()): boolean {
  try {
    return localStorage.getItem(key(context)) === isoDate(now);
  } catch {
    // Storage denied: treat it as seen. A private-mode window that reopened the
    // panel on every navigation would be the most annoying possible failure of
    // a feature whose entire premise is "not too often".
    return true;
  }
}

/** Record that today's audit has been offered for this context. */
export function markAuditSeen(context: string, now: number = Date.now()): void {
  try {
    localStorage.setItem(key(context), isoDate(now));
  } catch {
    // Persistence lost, not the panel.
  }
}
