import { describe, expect, it } from 'vite-plus/test';
import { readExtras } from './extras.ts';

/** The minutes a phrase adds, or the change when it is not an addition alone. */
const minutesOf = (phrase: string) => {
  const { reminders } = readExtras(phrase);
  return reminders !== undefined && !reminders.clear && reminders.remove.length === 0
    ? reminders.add
    : reminders;
};

describe('readExtras — notifications', () => {
  it('reads "remind me … before" as a notification, not a to-do, and takes it off the phrase', () => {
    expect(readExtras('Dentist Tuesday at 10, remind me 30 minutes before')).toEqual({
      reminders: { add: [30], clear: false, remove: [] },
      rest: 'Dentist Tuesday at 10',
    });
    expect(readExtras('Zahnarzt Dienstag um 10, erinnere mich eine Stunde vorher')).toEqual({
      reminders: { add: [60], clear: false, remove: [] },
      rest: 'Zahnarzt Dienstag um 10',
    });
    expect(readExtras('Team sync Wednesday at 3 and notify me an hour before')).toEqual({
      reminders: { add: [60], clear: false, remove: [] },
      rest: 'Team sync Wednesday at 3',
    });
  });

  it('leaves a to-do cue, a bound and a moved start alone', () => {
    for (const phrase of [
      'Remind me to call the bank tomorrow',
      'Reminder: dentist Tuesday',
      'Erinnerung: Zahnarzt Dienstag',
      'arrive 10 minutes before the meeting',
      'an hour earlier',
      'eine Stunde früher',
      'Team sync Wednesday at 3',
    ]) {
      expect(readExtras(phrase), phrase).toEqual({ rest: phrase });
    }
  });

  it('reads a change that is about nothing else, leaving no words for the model', () => {
    expect(readExtras('notify me 15 minutes before')).toEqual({
      reminders: { add: [15], clear: false, remove: [] },
      rest: '',
    });
    expect(readExtras('and an hour before as well')).toEqual({
      reminders: { add: [60], clear: false, remove: [] },
      rest: '',
    });
    expect(readExtras('remind me the day before')).toEqual({
      reminders: { add: [1440], clear: false, remove: [] },
      rest: '',
    });
    expect(readExtras('Erinnere mich am Tag davor')).toEqual({
      reminders: { add: [1440], clear: false, remove: [] },
      rest: '',
    });
    expect(readExtras('eine Stunde vorher erinnern')).toEqual({
      reminders: { add: [60], clear: false, remove: [] },
      rest: '',
    });
    expect(readExtras('remind me at the start')).toEqual({
      reminders: { add: [0], clear: false, remove: [] },
      rest: '',
    });
  });

  it('reads every offset form in minutes', () => {
    expect(minutesOf('remind me 2 days before')).toEqual([2880]);
    expect(minutesOf('remind me a week before')).toEqual([10_080]);
    expect(minutesOf('remind me half an hour before')).toEqual([30]);
    expect(minutesOf('erinnere mich eine halbe Stunde vorher')).toEqual([30]);
    expect(minutesOf('erinnere mich eine Viertelstunde vorher')).toEqual([15]);
    expect(minutesOf('remind me an hour and a half before')).toEqual([90]);
    expect(minutesOf('remind me 1.5 hours before')).toEqual([90]);
    expect(minutesOf('remind me twenty-five minutes before')).toEqual([25]);
    expect(minutesOf('erinnere mich fünfundzwanzig Minuten vorher')).toEqual([25]);
    expect(minutesOf('remind me 10 and 30 minutes before')).toEqual([10, 30]);
    expect(minutesOf('remind me 15 minutes and an hour before')).toEqual([15, 60]);
    expect(minutesOf('notify me 10 min, 1 h and 1 day before')).toEqual([10, 60, 1440]);
    expect(minutesOf('with a 30-minute reminder')).toEqual([30]);
    expect(minutesOf('Dinner Friday at 7 with a 30 minute reminder')).toEqual([30]);
    expect(readExtras('Dinner Friday at 7 with a 30 minute reminder').rest).toBe(
      'Dinner Friday at 7',
    );
  });

  it('replaces, removes or clears the notifications on the words that say so', () => {
    expect(readExtras('change the reminder to 10 minutes before').reminders).toEqual({
      add: [10],
      clear: true,
      remove: [],
    });
    expect(readExtras('notify me 5 minutes before instead').reminders).toEqual({
      add: [5],
      clear: true,
      remove: [],
    });
    expect(readExtras('remove the 15 minute reminder').reminders).toEqual({
      add: [],
      clear: false,
      remove: [15],
    });
    for (const phrase of [
      'no reminder',
      'remove the notifications',
      "don't remind me",
      'keine Erinnerung',
      'ohne Benachrichtigung',
      'Erinnerung entfernen',
    ]) {
      expect(readExtras(phrase), phrase).toEqual({
        reminders: { add: [], clear: true, remove: [] },
        rest: '',
      });
    }
    // Cleared and set in one breath: the ones set are all there are.
    expect(readExtras('no reminders, just notify me 5 minutes before').reminders).toEqual({
      add: [5],
      clear: true,
      remove: [],
    });
  });
});

describe('readExtras — notes', () => {
  it('reads a note after its cue, in the phrase’s own spelling, and takes it off the phrase', () => {
    expect(readExtras('Lunch with Tom tomorrow at 1, note: bring the contract')).toEqual({
      notes: { kind: 'add', text: 'bring the contract' },
      rest: 'Lunch with Tom tomorrow at 1',
    });
    expect(readExtras('notier, dass ich die Versicherungskarte mitnehmen muss')).toEqual({
      notes: { kind: 'add', text: 'ich die Versicherungskarte mitnehmen muss' },
      rest: '',
    });
    expect(readExtras('add a note: bring the insurance card')).toEqual({
      notes: { kind: 'add', text: 'bring the insurance card' },
      rest: '',
    });
    expect(readExtras('also add to the notes: bring the slides')).toEqual({
      notes: { kind: 'add', text: 'bring the slides' },
      rest: '',
    });
    expect(readExtras('note that we need to talk about the roadmap')).toEqual({
      notes: { kind: 'add', text: 'we need to talk about the roadmap' },
      rest: '',
    });
    expect(readExtras('Dinner Friday with the note "ask about the trip"')).toEqual({
      notes: { kind: 'add', text: 'ask about the trip' },
      rest: 'Dinner Friday',
    });
    expect(readExtras('Mit der Notiz: Karte mitbringen')).toEqual({
      notes: { kind: 'add', text: 'Karte mitbringen' },
      rest: '',
    });
  });

  it('replaces or clears the notes on the words that say so', () => {
    expect(readExtras('replace the notes with: call first')).toEqual({
      notes: { kind: 'replace', text: 'call first' },
      rest: '',
    });
    expect(readExtras('set the description to bring cash')).toEqual({
      notes: { kind: 'replace', text: 'bring cash' },
      rest: '',
    });
    for (const phrase of ['clear the notes', 'remove the note', 'ohne Notiz', 'Notizen löschen']) {
      expect(readExtras(phrase), phrase).toEqual({ notes: { kind: 'clear' }, rest: '' });
    }
  });

  it('leaves a bare "note" or "notes" alone', () => {
    for (const phrase of ['Notes review Monday at 9', 'Drinks at the Note bar Friday']) {
      expect(readExtras(phrase), phrase).toEqual({ rest: phrase });
    }
  });
});

describe('readExtras — a long phrase', () => {
  it('reads the note and the notification among the rest, which stays whole', () => {
    expect(
      readExtras(
        'Set up a dinner with Tom Baker next Friday at seven at Loos Bar, invite Anna Lee too, remind me an hour before and note that we need to talk about the roadmap',
      ),
    ).toEqual({
      notes: { kind: 'add', text: 'we need to talk about the roadmap' },
      reminders: { add: [60], clear: false, remove: [] },
      rest: 'Set up a dinner with Tom Baker next Friday at seven at Loos Bar, invite Anna Lee too',
    });
    expect(
      readExtras(
        'Workshop with the design team on Tuesday from 2 to 4 in the big meeting room, invite tom.baker@example.com and Anna Berger, notes: bring the printouts, notification 30 minutes before',
      ),
    ).toEqual({
      notes: { kind: 'add', text: 'bring the printouts' },
      reminders: { add: [30], clear: false, remove: [] },
      rest: 'Workshop with the design team on Tuesday from 2 to 4 in the big meeting room, invite tom.baker@example.com and Anna Berger',
    });
    expect(
      readExtras(
        'Trag mir für nächsten Mittwoch um 10 Uhr einen Zahnarzttermin in der Praxis Dr. Huber ein, erinnere mich eine Stunde vorher und notier, dass ich die Versicherungskarte mitnehmen muss',
      ),
    ).toEqual({
      notes: { kind: 'add', text: 'ich die Versicherungskarte mitnehmen muss' },
      reminders: { add: [60], clear: false, remove: [] },
      rest: 'Trag mir für nächsten Mittwoch um 10 Uhr einen Zahnarzttermin in der Praxis Dr. Huber ein',
    });
  });

  it('ends a note where an invitation begins', () => {
    expect(readExtras('note: bring the slides, and invite Tom')).toEqual({
      notes: { kind: 'add', text: 'bring the slides' },
      rest: 'invite Tom',
    });
    expect(readExtras('Thursday instead, remind me 10 minutes before')).toEqual({
      reminders: { add: [10], clear: false, remove: [] },
      rest: 'Thursday instead',
    });
  });
});

describe('readExtras — review', () => {
  it('ends a note cut at a notification clause cleanly, and lets a note mention one', () => {
    expect(readExtras('note: bring the slides and remind me 10 minutes before')).toEqual({
      notes: { kind: 'add', text: 'bring the slides' },
      reminders: { add: [10], clear: false, remove: [] },
      rest: '',
    });
    expect(readExtras('note: check the notification settings first')).toEqual({
      notes: { kind: 'add', text: 'check the notification settings first' },
      rest: '',
    });
  });

  it('reads a bare offset after a clock hour, and a cue followed by a colon', () => {
    expect(readExtras('Dinner Friday at 7, 30 minutes before')).toEqual({
      reminders: { add: [30], clear: false, remove: [] },
      rest: 'Dinner Friday at 7',
    });
    expect(readExtras('Dentist, Erinnerung: 10 Minuten vorher')).toEqual({
      reminders: { add: [10], clear: false, remove: [] },
      rest: 'Dentist',
    });
    expect(readExtras('Reminder: 10 minutes before')).toEqual({
      reminders: { add: [10], clear: false, remove: [] },
      rest: '',
    });
  });

  it('mends the phrase whatever the case of its joining words, brackets included', () => {
    expect(readExtras('Notes: bring wine. Also invite Tom')).toEqual({
      notes: { kind: 'add', text: 'bring wine' },
      rest: 'invite Tom',
    });
    expect(readExtras('Dinner at 7 (note: bring wine)')).toEqual({
      notes: { kind: 'add', text: 'bring wine' },
      rest: 'Dinner at 7',
    });
    expect(readExtras('Remove the note about wine')).toEqual({
      notes: { kind: 'clear' },
      rest: '',
    });
  });

  it('leaves a title that only sounds like a note cue alone', () => {
    for (const phrase of [
      'Intro to notes app Monday at 9',
      'Project details - review Tuesday at 9',
      'Design details Monday at 10',
    ]) {
      expect(readExtras(phrase), phrase).toEqual({ rest: phrase });
    }
  });
});

describe('readExtras — second review', () => {
  it('keeps a negated invitation inside the note, and an invitation after a boundary out of it', () => {
    expect(readExtras('note: do not invite tom@example.com')).toEqual({
      notes: { kind: 'add', text: 'do not invite tom@example.com' },
      rest: '',
    });
    expect(readExtras('note: bring wine, do not invite Tom')).toEqual({
      notes: { kind: 'add', text: 'bring wine, do not invite Tom' },
      rest: '',
    });
    expect(readExtras('note: bring wine, and invite Tom')).toEqual({
      notes: { kind: 'add', text: 'bring wine' },
      rest: 'invite Tom',
    });
  });

  it('leaves a clearing said not to happen to the model', () => {
    for (const phrase of [
      "don't clear the notes",
      'do not remove the reminders',
      'never remove the notifications',
      'nicht die Notizen löschen',
    ]) {
      expect(readExtras(phrase), phrase).toEqual({ rest: phrase });
    }
  });

  it('composes a removal with an addition', () => {
    expect(readExtras('remove the 15 minute reminder and notify me an hour before')).toEqual({
      reminders: { add: [60], clear: false, remove: [15] },
      rest: '',
    });
    expect(readExtras('no reminders, just notify me 5 minutes before').reminders).toEqual({
      add: [5],
      clear: true,
      remove: [],
    });
  });

  it('leaves a to-do whose action is about notes alone, and reads a note after its action', () => {
    for (const phrase of [
      'Remind me to add notes to the report tomorrow',
      'Remind me to note down the meter reading Friday',
      "Don't forget to put a note in the lunchbox",
    ]) {
      expect(readExtras(phrase), phrase).toEqual({ rest: phrase });
    }
    expect(readExtras('Remind me to call Tom tomorrow, note: he owes me lunch')).toEqual({
      notes: { kind: 'add', text: 'he owes me lunch' },
      rest: 'Remind me to call Tom tomorrow',
    });
    expect(readExtras('Remind me to call Tom and note that he owes me lunch')).toEqual({
      notes: { kind: 'add', text: 'he owes me lunch' },
      rest: 'Remind me to call Tom',
    });
  });
});

describe('readExtras — Codex round 2', () => {
  it('keeps quoted words as the note, whatever they say', () => {
    expect(readExtras('Dinner with the note "remind me 30 minutes before"')).toEqual({
      notes: { kind: 'add', text: 'remind me 30 minutes before' },
      rest: 'Dinner',
    });
  });

  it('leaves a to-do whose action clears or replaces notes, or notifications, to the model', () => {
    for (const phrase of [
      'Remind me to clear the notes tomorrow',
      'Remind me to replace the notes with the new ones',
      'Remind me to remove the reminders from the shared calendar',
    ]) {
      expect(readExtras(phrase), phrase).toEqual({ rest: phrase });
    }
  });

  it('reads a denied replacement as nothing, not as a removal', () => {
    for (const phrase of [
      "don't change the reminder to 10 minutes before",
      'do not set the notification to an hour before',
    ]) {
      expect(readExtras(phrase), phrase).toEqual({ rest: phrase });
    }
    // A denied addition still takes the offset off: "don't remind me 10 minutes before".
    expect(readExtras("don't remind me 10 minutes before").reminders).toEqual({
      add: [],
      clear: false,
      remove: [10],
    });
  });

  it('needs the whole note word', () => {
    for (const phrase of [
      'Make a notebook cover tomorrow',
      'Add to the notebook stack Monday',
      'Mit der Notizbuch-Lieferung Dienstag',
    ]) {
      expect(readExtras(phrase), phrase).toEqual({ rest: phrase });
    }
  });
});
