import { describe, expect, it } from 'vitest';
import { type ClientPage, makeClientPages } from './rpcClientPages.ts';

/** A page whose destroyed event the test fires. */
const fakePage = (id: number) => {
  const destroyed: Array<() => void> = [];
  const page: ClientPage = {
    id,
    onDestroyed: (listener) => destroyed.push(listener),
  };
  return {
    destroy: () => {
      for (const listener of destroyed) {
        listener();
      }
    },
    destroyed,
    page,
  };
};

describe('makeClientPages', () => {
  it('reports a page gone when it starts a new document, then follows that one', () => {
    const gone: Array<number> = [];
    const pages = makeClientPages((clientId) => gone.push(clientId));
    const window = fakePage(7);
    pages.seen(window.page);
    pages.seen(window.page);
    // Watched once, however many frames it sends.
    expect(window.destroyed).toHaveLength(1);

    pages.newDocument(7);
    expect(gone).toEqual([7]);
    // The new document's first frame makes it a client again; its own
    // successor is reported too.
    pages.seen(window.page);
    pages.newDocument(7);
    expect(gone).toEqual([7, 7]);
  });

  it('ignores the first document of a page, and reports a page once', () => {
    const gone: Array<number> = [];
    const pages = makeClientPages((clientId) => gone.push(clientId));
    // A window's first document announces itself before any frame.
    pages.newDocument(3);
    expect(gone).toEqual([]);

    const window = fakePage(3);
    pages.seen(window.page);
    pages.newDocument(3);
    // Closed before the new document sent anything: already gone.
    window.destroy();
    expect(gone).toEqual([3]);

    const other = fakePage(4);
    pages.seen(other.page);
    other.destroy();
    expect(gone).toEqual([3, 4]);
  });
});
