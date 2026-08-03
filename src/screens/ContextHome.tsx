/**
 * The context home. PROJECT-SPEC.md §9.3.
 *
 * Up Next at the top, then the boards. Order is the store's — `selectBoardsFor`
 * is the only thing that decides which boards these are and what order they
 * come in.
 *
 * The empty state is the one with a real decision in it: a home with no boards
 * hides Up Next entirely rather than stacking a second empty state under the
 * first, and offers exactly one thing to do.
 */

import { useState } from 'react';
import { motion } from 'motion/react';
import { BoardCard } from '../components/BoardCard';
import { BoardEditor } from '../components/BoardEditor';
import { UpNext, UpNextSkeleton } from '../components/UpNext';
import { Button } from '../components/ui/Button';
import { EmptyLine, ErrorLine, SectionHeader } from '../components/ui/Section';
import { SkeletonCard } from '../components/ui/Skeleton';
import { claimColdLoad, staggerDelay } from '../lib/coldload';
import { useBoards, useStore } from '../lib/store';

/** §8.5 standard out curve. */
const OUT = [0.23, 1, 0.32, 1] as const;

export function ContextHome() {
  const context = useStore((state) => state.context);
  const status = useStore((state) => state.status);
  const boards = useBoards(context);
  const [creating, setCreating] = useState(false);

  if (status === 'loading') return <HomeSkeleton />;
  if (status === 'error') return <HomeError />;

  if (boards.length === 0) {
    return (
      <>
        <EmptyLine
          action={
            <Button onClick={() => setCreating(true)}>Create your first board</Button>
          }
        >
          Boards are projects. Each one holds a list of tasks and tracks how far
          along it is.
        </EmptyLine>
        <BoardEditor
          open={creating}
          onClose={() => setCreating(false)}
          context={context}
        />
      </>
    );
  }

  return (
    <>
      <UpNext context={context} />

      <section>
        <SectionHeader
          action={
            <Button variant="tertiary" onClick={() => setCreating(true)}>
              New board
            </Button>
          }
        >
          {boards.length} {boards.length === 1 ? 'Board' : 'Boards'}
        </SectionHeader>

        <ul className="grid gap-3 md:grid-cols-2">
          {boards.map((board, index) => (
            <StaggeredCard key={board.id} index={index} boardId={board.id}>
              <BoardCard board={board} />
            </StaggeredCard>
          ))}
        </ul>
      </section>

      <BoardEditor
        open={creating}
        onClose={() => setCreating(false)}
        context={context}
      />
    </>
  );
}

/**
 * The 40ms stagger, on the cold load only (§8.5). A card added later — or the
 * whole list on a return visit — appears without an entrance, which is the
 * point: the stagger says "this screen just arrived", and it would be a lie
 * the second time.
 */
function StaggeredCard({
  index,
  boardId,
  children,
}: {
  index: number;
  boardId: string;
  children: React.ReactNode;
}) {
  const [cold] = useState(() => claimColdLoad(`board-card:${boardId}`));

  return (
    <motion.li
      initial={cold ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: OUT, delay: cold ? staggerDelay(index) : 0 }}
    >
      {children}
    </motion.li>
  );
}

function HomeSkeleton() {
  return (
    <>
      <UpNextSkeleton />
      <section>
        <SectionHeader>Boards</SectionHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </section>
    </>
  );
}

function HomeError() {
  const load = useStore((state) => state.load);
  return (
    <ErrorLine
      action={
        <Button variant="secondary" onClick={() => void load()}>
          Try again
        </Button>
      }
    >
      Couldn&rsquo;t load your boards. The connection may have dropped.
    </ErrorLine>
  );
}
