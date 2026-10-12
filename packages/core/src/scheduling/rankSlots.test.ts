import { describe, expect, it } from 'vite-plus/test';
import { rankSlotsAround } from './rankSlots.ts';

const slot = (date: string, startTime: string, endTime: string) => ({ date, endTime, startTime });

describe('rankSlotsAround', () => {
  it('keeps the solver order without a centre', () => {
    const slots = [slot('2026-08-25', '08:00', '09:00'), slot('2026-08-25', '11:00', '12:00')];
    expect(rankSlotsAround(slots, undefined)).toBe(slots);
  });

  it('puts the slot nearest the centre first, the sooner of equals before the later', () => {
    const slots = [
      slot('2026-08-25', '08:15', '08:45'), // middle 08:30, 90 min off
      slot('2026-08-25', '09:45', '10:15'), // middle 10:00, on the centre
      slot('2026-08-25', '10:45', '11:15'), // middle 11:00, 60 min off
      slot('2026-08-26', '09:30', '10:00'), // middle 09:45, 15 min off: the same band as 10:00
    ];
    expect(rankSlotsAround(slots, '10:00').map((entry) => entry.startTime)).toEqual([
      '09:45',
      '09:30',
      '10:45',
      '08:15',
    ]);
  });

  it('leaves the input untouched', () => {
    const slots = [slot('2026-08-25', '11:00', '12:00'), slot('2026-08-25', '08:00', '09:00')];
    rankSlotsAround(slots, '08:30');
    expect(slots[0]?.startTime).toBe('11:00');
  });
});
