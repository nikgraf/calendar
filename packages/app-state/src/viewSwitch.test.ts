import { describe, expect, it } from 'vite-plus/test';
import {
  anchorOffset,
  PLAIN_RISE,
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
