import { Schema } from 'effect';

/**
 * What saving an edit of a repeating event for all events takes from the
 * occurrences changed on their own. A new start or a new rule makes
 * Google cancel every exception whose slot the series no longer draws
 * (verified live): a moved or renamed occurrence loses its change, and a
 * day deleted on its own is drawn again. Nothing for an edit that keeps
 * the slots (a title, a place, the end time alone), and nothing for an
 * occurrence whose day the edited series draws no more (a shorter
 * series, other weekdays): that one goes as the edit says.
 */
export const SeriesEditLoss = Schema.Struct({
  /** Occurrences edited on their own that go back to the series' plain ones. */
  changed: Schema.Number,
  /** Occurrences deleted on their own that the series draws again. */
  deleted: Schema.Number,
});
export type SeriesEditLoss = typeof SeriesEditLoss.Type;

export const NO_SERIES_EDIT_LOSS: SeriesEditLoss = { changed: 0, deleted: 0 };

const occurrences = (count: number): string =>
  count === 1 ? '1 single occurrence' : `${String(count)} single occurrences`;

/** One sentence for the editor's question before the save, or null when nothing is lost. */
export const seriesEditLossSummary = (loss: SeriesEditLoss): string | null => {
  if (loss.changed > 0 && loss.deleted > 0) {
    return `Saving this for all events undoes the changes you made to ${occurrences(loss.changed)} and brings back ${String(loss.deleted)} you deleted.`;
  }
  if (loss.changed > 0) {
    return `Saving this for all events undoes the changes you made to ${occurrences(loss.changed)}.`;
  }
  if (loss.deleted > 0) {
    return `Saving this for all events brings back ${occurrences(loss.deleted)} you deleted.`;
  }
  return null;
};
