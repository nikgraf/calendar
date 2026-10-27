import { describe, expect, it, vi } from 'vite-plus/test';
import {
  EDITOR_SHEET_DETENTS,
  editorDetentIndex,
  editorSheetHeight,
  turnListMaxHeight,
} from './editorSheet.ts';

// The module reads the window through a hook; nothing here renders.
vi.mock('react-native', () => ({ useWindowDimensions: () => ({ height: 874, width: 402 }) }));

// An iPhone 17 Pro in portrait: the window and the status bar's inset.
const WINDOW = 874;
const TOP = 62;

describe('editorDetentIndex', () => {
  it('opens a new item at half height and anything else at full', () => {
    expect(EDITOR_SHEET_DETENTS[editorDetentIndex('half')]).toBe(0.5);
    expect(EDITOR_SHEET_DETENTS[editorDetentIndex('full')]).toBe(1);
    expect(EDITOR_SHEET_DETENTS[editorDetentIndex(undefined)]).toBe(1);
  });
});

describe('editorSheetHeight', () => {
  it('is the detent fraction of the sheet below the status bar', () => {
    expect(editorSheetHeight(1, WINDOW, TOP)).toBe(812);
    expect(editorSheetHeight(0, WINDOW, TOP)).toBe(406);
  });

  it('reads an unknown detent as full', () => {
    expect(editorSheetHeight(7, WINDOW, TOP)).toBe(812);
  });
});

describe('turnListMaxHeight', () => {
  it('follows the sheet: a half sheet gives the turns half the room', () => {
    const full = turnListMaxHeight(editorSheetHeight(1, WINDOW, TOP));
    const half = turnListMaxHeight(editorSheetHeight(0, WINDOW, TOP));
    expect(full).toBe(271);
    expect(half).toBe(135);
    // The screen-based cap this replaced: 30 % of the window at either detent.
    expect(half).toBeLessThan(Math.round(WINDOW * 0.3));
  });
});
