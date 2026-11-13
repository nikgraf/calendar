/**
 * The first phrase of every model bench case
 * (`apps/desktop/e2e/bench/cases/*.json`), copied here because the phone
 * cannot read the desktop's files. `modelSpikeCases.test.ts` fails when
 * the copy and the cases differ: change a case, then run
 * `node apps/ios/scripts/model-spike-cases.mjs` to write this file again.
 * A phrase that was recorded is its transcript.
 */
export interface SpikeCase {
  /** The bench case's file name: the Mac scores the phone's answer by it. */
  readonly id: string;
  readonly lang: 'de' | 'en';
  readonly text: string;
}

export const SPIKE_CASES: ReadonlyArray<SpikeCase> = [
  { id: 'abendessen-teo-freitag', lang: 'de', text: 'Abendessen mit Teo nächsten Freitag' },
  {
    id: 'add-event-lunch-stefan',
    lang: 'en',
    text: 'Add an event to have lunch with Stefan tomorrow at 1',
  },
  { id: 'add-reminder-call-bank', lang: 'en', text: 'Add a reminder to call the bank tomorrow' },
  {
    id: 'at-an-event-lunch-stefan',
    lang: 'en',
    text: 'At an event for lunch tomorrow with Stefan',
  },
  { id: 'book-club-monthly', lang: 'en', text: 'Book club every month on Wednesday at 7pm' },
  { id: 'breakfast-meeting-monday', lang: 'en', text: 'Breakfast meeting Monday' },
  { id: 'call-anna-tomorrow', lang: 'en', text: 'Call with Anna tomorrow' },
  { id: 'dentist-thursday', lang: 'en', text: 'Dentist Thursday' },
  { id: 'dinner-ruby-tuesday', lang: 'en', text: 'Dinner at Ruby Tuesday tomorrow' },
  { id: 'dinner-teo-at-8', lang: 'en', text: 'Dinner with Teo at 8 next Friday' },
  { id: 'dinner-teo-next-friday', lang: 'en', text: 'Dinner with Teo next Friday' },
  { id: 'dont-forget-passport', lang: 'en', text: "Don't forget to renew the passport next week" },
  { id: 'drinks-jo-loos-bar', lang: 'en', text: 'drinks with jo at Loos Bar friday 7pm' },
  {
    id: 'drinks-team-friday-630-830',
    lang: 'en',
    text: 'Drinks with the team from 6:30 to 8:30pm on Friday',
  },
  {
    id: 'erinnerung-eine-stunde',
    lang: 'de',
    text: 'Zahnarzt Dienstag um 10, erinnere mich eine Stunde vorher',
  },
  {
    id: 'erstelle-termin-mittagessen',
    lang: 'de',
    text: 'Erstelle einen Termin für Mittagessen mit Stefan am Freitag um 12',
  },
  { id: 'flow-city-moves', lang: 'en', text: 'Conference on Friday' },
  { id: 'flow-dentist-allday-extras', lang: 'en', text: 'Dentist Thursday at 10' },
  { id: 'flow-dinner', lang: 'en', text: 'Dinner with Teo next Friday' },
  { id: 'flow-location-clear', lang: 'en', text: 'Coffee tomorrow at 10 at Café Prückel' },
  { id: 'flow-lunch-guests', lang: 'en', text: 'Lunch with Sarah tomorrow at 1' },
  { id: 'flow-notes', lang: 'en', text: 'Call with Anna Lee tomorrow at 11' },
  { id: 'flow-notifications', lang: 'en', text: 'Team sync Wednesday at 3' },
  { id: 'flow-ort-eingrenzen', lang: 'de', text: 'Abendessen am Freitag um 19 Uhr' },
  { id: 'flow-place-as-heard', lang: 'en', text: 'Lunch tomorrow at 1' },
  { id: 'flow-place-in-city', lang: 'en', text: 'Lunch tomorrow at 1' },
  { id: 'flow-place-the-one', lang: 'en', text: 'Dinner on Friday at 7' },
  { id: 'flow-shift', lang: 'en', text: 'Yoga today at 5:30pm' },
  { id: 'flow-standup-repeat', lang: 'en', text: 'Standup Monday at 9' },
  { id: 'flow-task-alert', lang: 'en', text: 'remind me to call the bank tomorrow at 9' },
  { id: 'flow-task', lang: 'en', text: 'remind me to call the bank tomorrow' },
  { id: 'flow-with-company', lang: 'en', text: 'Lunch tomorrow at 1' },
  { id: 'flow-zahnarzt', lang: 'de', text: 'Zahnarzt nächsten Dienstag um halb drei' },
  { id: 'ich-muss-miete', lang: 'de', text: 'Ich muss morgen die Miete überweisen' },
  { id: 'invite-anna-ambiguous', lang: 'en', text: 'Coffee Thursday at 3, invite Anna' },
  { id: 'invite-email', lang: 'en', text: 'Sync on Friday at 10, invite jo@example.com' },
  {
    id: 'invite-german',
    lang: 'de',
    text: 'Teammeeting am Mittwoch um 9, lade Tom Baker und Jörg Müller ein',
  },
  { id: 'invite-max-two-addresses', lang: 'en', text: 'Call tomorrow at 4, invite Max' },
  { id: 'invite-tom-baker', lang: 'en', text: 'Lunch tomorrow at noon, invite Tom Baker' },
  {
    id: 'invite-two',
    lang: 'en',
    text: 'Planning session Monday at 2pm, invite Tom Baker and Anna Lee',
  },
  { id: 'jeden-dienstag-fussball', lang: 'de', text: 'Jeden Dienstag um 18 Uhr Fußball' },
  { id: 'kaffee-cafe-prueckel', lang: 'de', text: 'Kaffee morgen um 15 Uhr im Café Prückel' },
  { id: 'kaffee-max-figlmueller', lang: 'de', text: 'Kaffee mit Max um 10 Uhr im Figlmüller' },
  {
    id: 'long-call-chatty',
    lang: 'en',
    text: "I'd like to schedule a call with Sarah sometime tomorrow afternoon, let's say 3pm, it should take about half an hour",
  },
  {
    id: 'long-dinner-full',
    lang: 'en',
    text: 'Set up a dinner with Tom Baker next Friday at seven at Loos Bar, invite Anna Lee too, remind me an hour before and note that we need to talk about the roadmap',
  },
  {
    id: 'long-german-full',
    lang: 'de',
    text: 'Trag mir für nächsten Mittwoch um 10 Uhr einen Zahnarzttermin in der Praxis Dr. Huber ein, erinnere mich eine Stunde vorher und notier, dass ich die Versicherungskarte mitnehmen muss',
  },
  {
    id: 'long-run-prater',
    lang: 'en',
    text: 'Block Saturday morning for a run in the Prater with Jo around 8 and invite jo@example.com',
  },
  {
    id: 'long-workshop-full',
    lang: 'en',
    text: 'Workshop with the design team on Tuesday from 2 to 4 in the big meeting room, invite tom.baker@example.com and Anna Berger, notes: bring the printouts, notification 30 minutes before',
  },
  { id: 'lunch-sarah-tomorrow-at-1', lang: 'en', text: 'Lunch with Sarah tomorrow at 1' },
  { id: 'lunch-tom-tomorrow', lang: 'en', text: 'lunch with tom tomorrow' },
  {
    id: 'notes-bring-contract',
    lang: 'en',
    text: 'Lunch with Tom tomorrow at 1, note: bring the contract',
  },
  {
    id: 'piano-weekly-until-march',
    lang: 'en',
    text: 'Piano lesson every Tuesday at 5pm until March',
  },
  {
    id: 'pick-up-keys-reception',
    lang: 'en',
    text: 'remind me to pick up the keys at reception tomorrow',
  },
  {
    id: 'project-review-big-room',
    lang: 'en',
    text: 'Project review Wednesday at 11 in the big meeting room',
  },
  {
    id: 'put-lunch-on-calendar',
    lang: 'en',
    text: 'Put lunch with Stefan on my calendar for tomorrow at 1',
  },
  {
    id: 'remind-call-bank-10-before',
    lang: 'en',
    text: 'remind me to call the bank tomorrow at 9, 10 minutes before',
  },
  { id: 'remind-call-bank-tue-930', lang: 'en', text: 'remind me to call the bank tue 9:30' },
  {
    id: 'reminder-30-before',
    lang: 'en',
    text: 'Dentist Tuesday at 10, remind me 30 minutes before',
  },
  {
    id: 'schedule-call-sarah-thursday',
    lang: 'en',
    text: 'Schedule a call with Sarah for Thursday at 3',
  },
  { id: 'standup-every-weekday-930', lang: 'en', text: 'Standup every weekday at 9:30' },
  {
    id: 'standup-werktags-ausser-freitag',
    lang: 'de',
    text: 'Standup jeden Werktag um 9 außer Freitag',
  },
  { id: 'team-offsite-oct-20', lang: 'en', text: 'Team offsite Oct 20' },
  { id: 'team-standup-every-monday-9', lang: 'en', text: 'Team standup every monday at 9' },
  { id: 'therapy-every-two-weeks', lang: 'en', text: 'Therapy every two weeks on Thursday at 4' },
  {
    id: 'trag-mir-zahnarzt-ein',
    lang: 'de',
    text: 'Trag mir am Dienstag um 10 einen Zahnarzttermin ein',
  },
  { id: 'trip-to-vienna-saturday', lang: 'en', text: 'Trip to Vienna on Saturday' },
  { id: 'vacation-until-friday', lang: 'en', text: 'Vacation until Friday' },
  { id: 'with-is-not-invite', lang: 'en', text: 'Dinner with Tom Baker on Saturday' },
  { id: 'workshop-tuesday-2-4', lang: 'en', text: 'Workshop Tuesday 2-4pm' },
  { id: 'yoga-every-day-except-sunday', lang: 'en', text: 'Yoga every day at 7 except Sunday' },
  { id: 'yoga-today-530pm', lang: 'en', text: 'Yoga today at 5:30pm' },
  {
    id: 'zahnarzt-dienstag-halb-drei',
    lang: 'de',
    text: 'Zahnarzt nächsten Dienstag um halb drei',
  },
];
