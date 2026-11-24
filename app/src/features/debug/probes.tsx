import { useEffect, useRef } from 'react';
import { useLocation, useNavigation } from 'react-router';
import { debugNavigation } from '@/lib/debug/capture';

/**
 * Times each navigation, from its start to the commit of its page (its chunk and its loader included). A navigation
 * with nothing to load (the page's chunk already there) has no loading state: it is listed, without a time.
 */
export function NavigationTimer() {
  const navigation = useNavigation();
  const { pathname } = useLocation();
  const started = useRef<number | null>(null);
  const shown = useRef(pathname);

  useEffect(() => {
    if (navigation.state !== 'idle') {
      started.current ??= performance.now();
      return;
    }
    if (started.current === null && shown.current === pathname) return;
    debugNavigation(pathname, started.current === null ? undefined : performance.now() - started.current);
    started.current = null;
    shown.current = pathname;
  }, [navigation.state, pathname]);

  return null;
}
