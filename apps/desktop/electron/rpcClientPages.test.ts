import { describe, expect, it } from 'vitest';
import { type ClientPage, makeClientPages } from './rpcClientPages.ts';

/** A page whose new-document and destroyed events the test fires. */
const fakePage = (id: number) => {
  const newDocument: Array<() => void> = [];
  const destroyed: Array<() => void> = [];
  const page: ClientPage = {
    id,
    onDestroyed: (listener) => destroyed.push(listener),
    onNewDocument: (listener) => newDocument.push(listener),
  };
  return {
    destroy: () => {
      for (const listener of destroyed) {
        listener();
      }
    },
    newDocument,
    page,
    reload: () => {
      for (const listener of newDocument) {
        listener();
      }
    },
  };
};

describe('makeClientPages', () => {
  it('reports a reloaded page gone, then follows its new document', () => {
    const gone: Array<number> = [];
    const seen = makeClientPages((clientId) => gone.push(clientId));
    const window = fakePage(7);
    seen(window.page);
    seen(window.page);
    // Watched once, however many frames it sends.
    expect(window.newDocument).toHaveLength(1);

    window.reload();
    expect(gone).toEqual([7]);
    // The reloaded page's first frame makes it a client again; its next
    // reload is reported too.
    seen(window.page);
    window.reload();
    expect(gone).toEqual([7, 7]);
  });

  it('reports a page once, whether it reloads or closes first', () => {
    const gone: Array<number> = [];
    const seen = makeClientPages((clientId) => gone.push(clientId));
    const window = fakePage(3);
    seen(window.page);
    window.reload();
    // Closed before the new document sent anything: already gone.
    window.destroy();
    expect(gone).toEqual([3]);

    const other = fakePage(4);
    seen(other.page);
    other.destroy();
    expect(gone).toEqual([3, 4]);
  });
});
