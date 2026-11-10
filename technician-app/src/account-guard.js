// One place that says whether a relay read or its answer still belongs to the account on screen.
// App makes a guard from the shown account. A read asks `begin(owner)` before it starts: it gets
// a token only if `owner` is the account on screen now, and each token advances that account's own
// sequence number, never another account's. When the answer comes back `fresh(token)` says whether
// to apply it: the account must still be the one shown and no newer read for it may have begun.
// A call made under an account that is no longer shown starts nothing and advances nothing.
import { useMemo, useRef } from 'react';

export function useAccountGuard(accountId) {
  const shown = useRef(accountId);
  shown.current = accountId; // set while rendering, so it is already right when a callback from an earlier render runs
  const seqs = useRef(new Map());
  return useMemo(() => {
    const bump = (owner) => {
      const n = (seqs.current.get(owner) ?? 0) + 1;
      seqs.current.set(owner, n);
      return n;
    };
    return {
      shown: () => shown.current,
      // The person (or a notification) chose this account: it counts as shown at once, before the next render.
      select: (id) => { shown.current = id; },
      isShown: (owner) => !!owner && shown.current === owner,
      begin: (owner) => (owner && shown.current === owner ? { owner, n: bump(owner) } : null),
      fresh: (token) => !!token && shown.current === token.owner && seqs.current.get(token.owner) === token.n,
      invalidate: (owner) => { if (owner) bump(owner); },
    };
  }, []);
}
