import { describe, expect, it } from 'vite-plus/test';
import { deleteQuestion, deleteTaskQuestion } from './deleteQuestion.ts';

describe('deleteQuestion', () => {
  it('names the item, and for a series how much of it goes', () => {
    expect(deleteQuestion('Planning')).toBe('Delete “Planning”?');
    expect(deleteQuestion('Standup', 'instance')).toBe('Delete this occurrence of “Standup”?');
    expect(deleteQuestion('Standup', 'following')).toBe(
      'Delete “Standup” from this occurrence on?',
    );
    expect(deleteQuestion(' Standup ', 'series')).toBe('Delete every occurrence of “Standup”?');
  });

  it('names the subtasks a task takes with it', () => {
    expect(deleteTaskQuestion(' Groceries ', 0)).toBe('Delete “Groceries”?');
    expect(deleteTaskQuestion('Groceries', 1)).toBe('Delete “Groceries” and its subtask?');
    expect(deleteTaskQuestion('Groceries', 3)).toBe('Delete “Groceries” and its 3 subtasks?');
  });
});
