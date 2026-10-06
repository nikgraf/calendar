/** A renderer page as the rpc server sees it; Electron's WebContents adapts to it. */
export interface ClientPage {
  readonly id: number;
  readonly onDestroyed: (listener: () => void) => void;
}

/**
 * Tracks which pages are rpc clients and reports each one gone exactly
 * once: when its window closes, or when it loads a new document. A
 * reload (⌘R) is a new rpc client under the same webContents id that
 * numbers its requests from 0 again, while the server still ran the old
 * page's invalidations stream under one of those ids — and the server
 * drops a request whose id is still running, so a query of the new page
 * could hang for good. Disconnecting first ends the old page's streams.
 *
 * The new document says so itself (`newDocument`, sent by the preload
 * before any rpc frame of it). Navigation events cannot: Electron reports
 * did-start-navigation before main.ts's will-navigate can refuse the
 * navigation, and a refused one leaves the old document — streams and
 * all — in place.
 */
export const makeClientPages = (onGone: (clientId: number) => void) => {
  const known = new Set<number>();
  const watched = new Set<number>();
  const gone = (clientId: number) => {
    if (known.delete(clientId)) {
      onGone(clientId);
    }
  };
  return {
    /** The page started a new document: the old document's client is gone. */
    newDocument: gone,
    /** Called with every rpc frame's page; the first makes it a client. */
    seen: (page: ClientPage): void => {
      const clientId = page.id;
      known.add(clientId);
      if (watched.has(clientId)) {
        return;
      }
      watched.add(clientId);
      page.onDestroyed(() => {
        watched.delete(clientId);
        gone(clientId);
      });
    },
  };
};
