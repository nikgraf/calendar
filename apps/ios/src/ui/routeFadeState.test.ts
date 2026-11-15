import { describe, expect, it } from 'vite-plus/test';
import { type Fade, fadeStep } from './routeFadeState.ts';

/** A content and its version: the key is what a swap goes by. */
interface Item {
  readonly key: string;
  readonly version: number;
}
const item = (key: string, version = 0): Item => ({ key, version });
const keyOf = (shown: Item) => shown.key;
const step = (state: Fade<Item>, ...events: Array<Parameters<typeof fadeStep<Item>>[1]>) =>
  events.reduce((current, event) => fadeStep(current, event, keyOf), state);

const detail = item('detail');
const editor = item('editor');
const still: Fade<Item> = { kind: 'still', shown: detail };

describe('fadeStep', () => {
  it('updates the content in place for the same key', () => {
    expect(step(still, { item: item('detail', 1), kind: 'item' })).toEqual({
      kind: 'still',
      shown: item('detail', 1),
    });
  });

  it('keeps the old content whole until the new one is laid out, then cross-fades', () => {
    const waiting = step(still, { item: editor, kind: 'item' });
    expect(waiting).toEqual({ kind: 'waiting', leaving: detail, shown: editor });
    const fading = step(waiting, { key: 'editor', kind: 'ready' });
    expect(fading).toEqual({ kind: 'fading', leaving: detail, shown: editor });
    expect(step(fading, { key: 'editor', kind: 'faded' })).toEqual({
      kind: 'still',
      shown: editor,
    });
  });

  it('ignores a layout or a finished fade of a content no longer shown', () => {
    const waiting = step(still, { item: editor, kind: 'item' });
    expect(step(waiting, { key: 'detail', kind: 'ready' })).toBe(waiting);
    expect(step(waiting, { key: 'editor', kind: 'faded' })).toBe(waiting);
    expect(step(still, { key: 'detail', kind: 'ready' })).toBe(still);
  });

  it('keeps the swap going when the content on either side is updated', () => {
    const waiting = step(still, { item: editor, kind: 'item' });
    expect(step(waiting, { item: item('editor', 1), kind: 'item' })).toEqual({
      kind: 'waiting',
      leaving: detail,
      shown: item('editor', 1),
    });
    const fading = step(waiting, { key: 'editor', kind: 'ready' });
    expect(step(fading, { item: item('editor', 1), kind: 'item' })).toEqual({
      kind: 'fading',
      leaving: detail,
      shown: item('editor', 1),
    });
  });

  it('ignores a second layout mid-fade and a finished fade at rest', () => {
    const fading = step(still, { item: editor, kind: 'item' }, { key: 'editor', kind: 'ready' });
    expect(step(fading, { key: 'editor', kind: 'ready' })).toBe(fading);
    expect(step(still, { key: 'detail', kind: 'faded' })).toBe(still);
  });

  it('goes back to the content still leaving: at once before the new one showed', () => {
    const waiting = step(still, { item: editor, kind: 'item' });
    expect(step(waiting, { item: item('detail', 2), kind: 'item' })).toEqual({
      kind: 'still',
      shown: item('detail', 2),
    });
  });

  it('turns the fade round when the content leaving comes back mid-fade', () => {
    const fading = step(still, { item: editor, kind: 'item' }, { key: 'editor', kind: 'ready' });
    const back = step(fading, { item: item('detail', 2), kind: 'item' });
    expect(back).toEqual({ kind: 'fading', leaving: editor, shown: item('detail', 2) });
    // The editor's interrupted fade-in finishing late changes nothing.
    expect(step(back, { key: 'editor', kind: 'faded' })).toBe(back);
    expect(step(back, { key: 'detail', kind: 'faded' })).toEqual({
      kind: 'still',
      shown: item('detail', 2),
    });
  });

  it('fades from what is on screen when a third content comes mid-swap', () => {
    const waiting = step(still, { item: editor, kind: 'item' });
    // Not drawn yet: the detail is what is on screen.
    expect(step(waiting, { item: item('other'), kind: 'item' })).toEqual({
      kind: 'waiting',
      leaving: detail,
      shown: item('other'),
    });
    // Fading in: the editor is.
    const fading = step(waiting, { key: 'editor', kind: 'ready' });
    expect(step(fading, { item: item('other'), kind: 'item' })).toEqual({
      kind: 'waiting',
      leaving: editor,
      shown: item('other'),
    });
  });
});
