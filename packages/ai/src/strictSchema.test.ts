import { describe, expect, it } from 'vite-plus/test';
import { strictSchema, withoutNulls } from './strictSchema.ts';

const QUICK_ADD = {
  additionalProperties: false,
  properties: {
    date: { description: 'YYYY-MM-DD', type: 'string' },
    isAllDay: { type: 'boolean' },
    recurrence: {
      additionalProperties: false,
      properties: {
        count: { type: 'number' },
        freq: { enum: ['daily', 'weekly'], type: 'string' },
      },
      type: 'object',
    },
    title: { type: 'string' },
  },
  required: ['title'],
  type: 'object',
};

describe('strictSchema', () => {
  it('requires every property, making the optional ones nullable, at every level', () => {
    expect(strictSchema(QUICK_ADD)).toEqual({
      additionalProperties: false,
      properties: {
        date: { description: 'YYYY-MM-DD', type: ['string', 'null'] },
        isAllDay: { type: ['boolean', 'null'] },
        recurrence: {
          anyOf: [
            {
              additionalProperties: false,
              properties: {
                count: { type: ['number', 'null'] },
                freq: { enum: ['daily', 'weekly', null], type: ['string', 'null'] },
              },
              required: ['count', 'freq'],
              type: 'object',
            },
            { type: 'null' },
          ],
        },
        title: { type: 'string' },
      },
      required: ['date', 'isAllDay', 'recurrence', 'title'],
      type: 'object',
    });
  });

  it('reaches into arrays of objects (the capture schema)', () => {
    const capture = {
      properties: {
        events: {
          items: { properties: { title: { type: 'string' } }, required: ['title'], type: 'object' },
          maxItems: 8,
          type: 'array',
        },
      },
      required: ['events'],
      type: 'object',
    };
    expect(strictSchema(capture)).toMatchObject({
      properties: {
        events: {
          items: { additionalProperties: false, required: ['title'] },
          maxItems: 8,
          type: 'array',
        },
      },
      required: ['events'],
    });
  });
});

describe('withoutNulls', () => {
  it('drops the nulls a strict answer carries for what the model left out', () => {
    expect(
      withoutNulls({
        date: null,
        events: [{ location: null, title: 'x' }, null],
        recurrence: null,
        title: 'Dinner',
      }),
    ).toEqual({ events: [{ title: 'x' }], title: 'Dinner' });
  });
});
