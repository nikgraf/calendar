import { describe, expect, it } from 'vitest';
import { deleteQuestion } from './deleteQuestion.ts';

describe('deleteQuestion', () => {
  it('names the item, and for a series how much of it goes', () => {
    expect(deleteQuestion('Planning')).toBe('Delete “Planning”?');
    expect(deleteQuestion('Standup', 'instance')).toBe('Delete this occurrence of “Standup”?');
    expect(deleteQuestion('Standup', 'following')).toBe(
      'Delete “Standup” from this occurrence on?',
    );
    expect(deleteQuestion(' Standup ', 'series')).toBe('Delete every occurrence of “Standup”?');
  });
});
