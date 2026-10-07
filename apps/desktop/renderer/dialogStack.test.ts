import { describe, expect, it } from 'vitest';
import { makeDialogStack } from './dialogStack.ts';

const key = (name: string) => Object.assign(new Event('keydown'), { key: name });

describe('makeDialogStack', () => {
  it('one Escape closes only the top dialog, even when it closes before the next listener', () => {
    const window = new EventTarget();
    const dialogs = makeDialogStack(window);
    const closed: Array<string> = [];
    // The agent request (z 50) opened first, the editor (z 30) after it —
    // a quick-add that finished while the request was up. Its close runs
    // at once, as React's commit does between a native key's listeners.
    const closeApproval = dialogs.open(50, {
      onEscape: () => {
        closed.push('approval');
        closeApproval();
      },
      onKey: () => undefined,
    });
    const closeEditor = dialogs.open(30, {
      onEscape: () => {
        closed.push('editor');
        closeEditor();
      },
      onKey: () => undefined,
    });

    window.dispatchEvent(key('Escape'));
    expect(closed).toEqual(['approval']);
    expect(dialogs.isOpen()).toBe(true);
    window.dispatchEvent(key('Escape'));
    expect(closed).toEqual(['approval', 'editor']);
    expect(dialogs.isOpen()).toBe(false);
  });

  it('the highest zIndex is on top whatever the order, then the last opened', () => {
    const window = new EventTarget();
    const dialogs = makeDialogStack(window);
    const seen: Array<string> = [];
    const listen = (name: string) => ({
      onEscape: () => undefined,
      onKey: (event: KeyboardEvent) => seen.push(`${name}:${event.key}`),
    });
    dialogs.open(30, listen('editor'));
    const closeApproval = dialogs.open(50, listen('approval'));
    dialogs.open(30, listen('bar'));

    window.dispatchEvent(key('Tab'));
    closeApproval();
    window.dispatchEvent(key('Tab'));
    expect(seen).toEqual(['approval:Tab', 'bar:Tab']);
  });
});
