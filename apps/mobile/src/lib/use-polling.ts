import { useEffect, useRef } from 'react';

// Calls `fn` every `ms` while `enabled`. The latest `fn` is always used; it stops on unmount.
export function usePolling(fn: () => void | Promise<void>, ms: number, enabled: boolean): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => void latest.current(), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
}
