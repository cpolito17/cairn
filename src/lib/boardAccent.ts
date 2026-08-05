import type { BoardAccent } from '../../shared/types';

export const BOARD_ACCENT_CHOICES: readonly {
  value: BoardAccent | null;
  label: string;
}[] = [
  { value: null, label: 'Theme accent' },
  { value: 'coral', label: 'Coral' },
  { value: 'amber', label: 'Amber' },
  { value: 'lime', label: 'Lime' },
  { value: 'emerald', label: 'Emerald' },
  { value: 'teal', label: 'Teal' },
  { value: 'cyan', label: 'Cyan' },
  { value: 'blue', label: 'Blue' },
  { value: 'indigo', label: 'Indigo' },
  { value: 'violet', label: 'Violet' },
  { value: 'rose', label: 'Rose' },
];

export function boardAccentColor(accent: BoardAccent | null): string {
  return accent === null ? 'var(--accent)' : `var(--board-accent-${accent})`;
}
