import { describe, expect, it } from 'vite-plus/test';
import {
  anchorOffset,
  leftAfterTurn,
  PLAIN_RISE,
  topAtEnd,
  type ViewSwitch,
  viewMounted,
  viewShown,
  viewSwitchAfter,
} from './viewSwitch.ts';

const atAssistant: ViewSwitch = { kind: 'rest', view: 'assistant' };
const toForm: ViewSwitch = { from: 'assistant', kind: 'flight', to: 'form' };

describe('viewSwitchAfter', () => {
  it('starts a flight from rest, and none to the view already on', () => {
    expect(viewSwitchAfter(atAssistant, { to: 'form', type: 'flip' })).toEqual(toForm);
    expect(viewSwitchAfter(atAssistant, { to: 'assistant', type: 'flip' })).toBe(atAssistant);
  });

  it('turns a flight round on a tap back, and keeps it on a tap ahead', () => {
    expect(viewSwitchAfter(toForm, { to: 'assistant', type: 'flip' })).toEqual({
      from: 'form',
      kind: 'flight',
      to: 'assistant',
    });
    expect(viewSwitchAfter(toForm, { to: 'form', type: 'flip' })).toBe(toForm);
  });

  it('comes to rest where the flight was going, and ignores a stale end', () => {
    expect(viewSwitchAfter(toForm, { type: 'settled', view: 'form' })).toEqual({
      kind: 'rest',
      view: 'form',
    });
    // The flight was turned round: the end of the first leg is not its end.
    expect(viewSwitchAfter(toForm, { type: 'settled', view: 'assistant' })).toBe(toForm);
    expect(viewSwitchAfter(atAssistant, { type: 'settled', view: 'form' })).toBe(atAssistant);
  });

  it('snaps to a view from anywhere', () => {
    expect(viewSwitchAfter(toForm, { to: 'form', type: 'snap' })).toEqual({
      kind: 'rest',
      view: 'form',
    });
  });
});

describe('what is mounted and shown', () => {
  it('mounts the view at rest, and both ends in flight', () => {
    expect(viewMounted(atAssistant, 'assistant')).toBe(true);
    expect(viewMounted(atAssistant, 'form')).toBe(false);
    expect(viewMounted(toForm, 'assistant')).toBe(true);
    expect(viewMounted(toForm, 'form')).toBe(true);
    expect(viewShown(toForm)).toBe('form');
  });
});

describe('topAtEnd', () => {
  const viewport = { height: 600, top: 100 };

  it('moves a row up by what is left to scroll in a conversation that came in at its start', () => {
    // 900 of content at offset 0: 300 left to scroll.
    expect(topAtEnd(850, { height: 900, top: 100 }, viewport)).toBe(550);
  });

  it('leaves a row where it is in a conversation at its end, or one that fits', () => {
    expect(topAtEnd(550, { height: 900, top: -200 }, viewport)).toBe(550);
    expect(topAtEnd(500, { height: 600, top: 100 }, viewport)).toBe(500);
  });

  it('takes it as it is without the boxes', () => {
    expect(topAtEnd(500, undefined, viewport)).toBe(500);
    expect(topAtEnd(undefined, { height: 900, top: 100 }, viewport)).toBeUndefined();
  });
});

describe('leftAfterTurn', () => {
  it('runs back as long as it ran, or forward for what it had left', () => {
    expect(leftAfterTurn(270, -1, 280)).toBe(270);
    expect(leftAfterTurn(10, 1, 280)).toBe(270);
    expect(leftAfterTurn(300, 1, 280)).toBe(0);
  });
});

describe('anchorOffset', () => {
  const visible = { bottom: 760, top: 110 };

  it('puts the form title on the card title', () => {
    expect(anchorOffset(540, 170, visible)).toBe(370);
  });

  it('rises a little from nowhere without a card in sight', () => {
    expect(anchorOffset(undefined, 170, visible)).toBe(PLAIN_RISE);
    expect(anchorOffset(540, undefined, visible)).toBe(PLAIN_RISE);
    // Scrolled out of the conversation's frame, above or below.
    expect(anchorOffset(40, 170, visible)).toBe(PLAIN_RISE);
    expect(anchorOffset(900, 170, visible)).toBe(PLAIN_RISE);
    expect(anchorOffset(540, 170, undefined)).toBe(PLAIN_RISE);
  });
});
