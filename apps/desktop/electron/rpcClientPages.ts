/** A renderer page as the rpc server sees it; Electron's WebContents adapts to it. */
export interface ClientPage {
  readonly id: number;
  readonly onDestroyed: (listener: () => void) => void;
  /** Calls back when the page starts loading a new document, a reload included. */
  readonly onNewDocument: (listener: () => void) => void;
}

/**
 * Tracks which pages are rpc clients and reports each one gone exactly
 * once: when its window closes, or when it loads a new document. A
 * reload (⌘R) is a new rpc client under the same webContents id that
 * numbers its requests from 0 again, while the server still ran the old
 * page's invalidations stream under one of those ids — and the server
 * drops a request whose id is still running, so a query of the new page
 * could hang for good. Disconnecting first ends the old page's streams.
 * Returns the function to call with every frame's page.
 */
export const makeClientPages = (onGone: (clientId: number) => void) => {
  const known = new Set<number>();
  const watched = new Set<number>();
  const gone = (clientId: number) => {
    if (known.delete(clientId)) {
      onGone(clientId);
    }
  };
  return (page: ClientPage): void => {
    const clientId = page.id;
    known.add(clientId);
    if (watched.has(clientId)) {
      return;
    }
    watched.add(clientId);
    page.onNewDocument(() => gone(clientId));
    page.onDestroyed(() => {
      watched.delete(clientId);
      gone(clientId);
    });
  };
};
