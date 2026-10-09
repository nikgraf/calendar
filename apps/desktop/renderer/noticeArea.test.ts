import { describe, expect, it } from 'vite-plus/test';
import { NOTICE_MIN_WIDTH, noticeArea } from './noticeArea.ts';

// The sidebar is 232 px wide, the editor panel 360.
const SIDEBAR = 232;
const EDITOR = 360;
const column = (windowWidth: number) => ({ left: SIDEBAR, right: windowWidth - EDITOR });

describe('noticeArea', () => {
  it('keeps the notices in the grid column while it is wide enough', () => {
    // CI's 1024 px window: the column is 432 px.
    expect(noticeArea(column(1024), 1024)).toBeUndefined();
  });

  it('reaches over the sidebar, not the panel, when the column alone is too narrow', () => {
    // 900 px: a 308 px column; everything left of the editor is 540 px.
    expect(noticeArea(column(900), 900)).toEqual({ left: 540 - NOTICE_MIN_WIDTH, right: 540 });
  });

  it('starts at the window edge and enters the panel only as far as it must', () => {
    // The window's minimum: 600 px leaves the column 8 px, 240 px left of the editor.
    expect(noticeArea(column(600), 600)).toEqual({ left: 0, right: NOTICE_MIN_WIDTH });
    // Never wider than the window.
    expect(noticeArea({ left: 0, right: 0 }, 300)).toEqual({ left: 0, right: 300 });
  });
});
