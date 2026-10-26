import { createContext, useContext } from 'react';
import { useWindowDimensions } from 'react-native';

/**
 * The editor's form-sheet detents (`app/_layout.tsx`), as fractions of
 * the sheet at full height: half for a new item, so the calendar behind
 * it stays in view, full for an existing one.
 */
export const EDITOR_SHEET_DETENTS: ReadonlyArray<number> = [0.5, 1];

/** The detent index a push asks for: the route's `detent` param (`EditorHost`). */
export const editorDetentIndex = (detent: unknown): number => (detent === 'half' ? 0 : 1);

/**
 * How tall the editor sheet stands at a detent: its fraction of the full
 * sheet, which runs from below the status bar to the bottom of the
 * screen. UIKit leaves a few points above a full sheet, so this runs a
 * little tall; what reads it wants a proportion, not a frame.
 */
export const editorSheetHeight = (index: number, windowHeight: number, topInset: number): number =>
  (EDITOR_SHEET_DETENTS[index] ?? 1) * (windowHeight - topInset);

/**
 * What the thread's turns may take of the sheet before they scroll inside
 * it: a third, so at half height the two newest turns and "+N earlier
 * queries" still fit, and a strip of the form stays in view under the
 * header to drag the sheet up by.
 */
export const turnListMaxHeight = (sheetHeight: number): number => Math.round(sheetHeight / 3);

/** The editor sheet as it stands: its detent index and height (`editorSheetHeight`). */
export interface EditorSheetState {
  readonly detent: number;
  readonly height: number;
}

/** The editor sheet as it stands, set by its route (`app/editor.tsx`). */
export const EditorSheet = createContext<EditorSheetState | undefined>(undefined);

/** The editor sheet's height, or the window's outside the sheet (a page sheet's editor). */
export function useEditorSheetHeight(): number {
  const sheet = useContext(EditorSheet);
  const { height } = useWindowDimensions();
  return sheet?.height ?? height;
}

/** Whether the editor sheet stands at half height; false outside the sheet. */
export function useEditorSheetAtHalf(): boolean {
  return useContext(EditorSheet)?.detent === 0;
}
