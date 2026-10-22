import { Schema } from 'effect';

/**
 * The first run, and the Getting started card after it. Neither syncs:
 * the state lives in `device_settings` under `onboarding`, read and
 * written over the `getOnboarding` / `setOnboarding` rpcs, and stays out
 * of the settings document (a copied setup starts its own lessons).
 */

/** The lessons of the Getting started card, in the order the card lists them. */
export const LESSON_IDS = [
  'create',
  'search',
  'alerts',
  'contacts',
  'zones',
  'otherDevice',
] as const;
export type LessonId = (typeof LESSON_IDS)[number];
export const LESSON_COUNT = LESSON_IDS.length;

/** How a lesson was ticked: tried in place, or skipped (Skip, or Done without trying). */
export const LessonMark = Schema.Literals(['done', 'skipped']);
export type LessonMark = typeof LessonMark.Type;

/** The card: open with its rows, folded to one line, or removed (Settings brings it back). */
export const OnboardingCard = Schema.Literals(['collapsed', 'expanded', 'hidden']);
export type OnboardingCard = typeof OnboardingCard.Type;

/** How the first run ended: walked through, or skipped (the card then starts with "Add your accounts"). */
export const SetupOutcome = Schema.Literals(['done', 'skipped']);
export type SetupOutcome = typeof SetupOutcome.Type;

export const OnboardingState = Schema.Struct({
  card: OnboardingCard,
  /** One mark per lesson tried or skipped; an unmarked lesson is still open. */
  lessons: Schema.Struct({
    alerts: Schema.optional(LessonMark),
    contacts: Schema.optional(LessonMark),
    create: Schema.optional(LessonMark),
    otherDevice: Schema.optional(LessonMark),
    search: Schema.optional(LessonMark),
    zones: Schema.optional(LessonMark),
  }),
  /** Absent until the setup was walked through or skipped. */
  setup: Schema.optional(SetupOutcome),
});
export type OnboardingState = typeof OnboardingState.Type;
export type LessonMarks = OnboardingState['lessons'];

export const DEFAULT_ONBOARDING_STATE: OnboardingState = { card: 'expanded', lessons: {} };

/**
 * The state with only what is set, lessons in card order: the stored
 * value is the same whatever order the marks were made in.
 */
export const canonicalOnboardingState = (state: OnboardingState): OnboardingState => {
  const lessons: Record<string, LessonMark> = {};
  for (const id of LESSON_IDS) {
    const mark = state.lessons[id];
    if (mark !== undefined) {
      lessons[id] = mark;
    }
  }
  return {
    card: state.card,
    lessons,
    ...(state.setup === undefined ? {} : { setup: state.setup }),
  };
};

/** How many lessons are ticked, of how many. */
export const lessonProgress = (state: OnboardingState): { done: number; total: number } => ({
  done: LESSON_IDS.filter((id) => state.lessons[id] !== undefined).length,
  total: LESSON_COUNT,
});

/** The card shows unless it was hidden, and leaves by itself once every row is ticked. */
export const cardVisible = (state: OnboardingState): boolean =>
  state.card !== 'hidden' && lessonProgress(state).done < LESSON_COUNT;

/** The first run shows while nothing is connected and the setup was neither finished nor skipped. */
export const setupNeeded = (state: OnboardingState, accountCount: number): boolean =>
  state.setup === undefined && accountCount === 0;

/** The first lesson still open, in card order. */
export const nextLesson = (state: OnboardingState): LessonId | undefined =>
  LESSON_IDS.find((id) => state.lessons[id] === undefined);

/** The lesson's place in the card, 1-based: "Getting started · 3 of 6". */
export const lessonPosition = (id: LessonId): number => LESSON_IDS.indexOf(id) + 1;

/**
 * A lesson ticked. Tried wins over skipped: a lesson done once stays
 * done when its frame is closed with Done later, and a skip never
 * undoes a try.
 */
export const withLessonMark = (
  state: OnboardingState,
  id: LessonId,
  mark: LessonMark,
): OnboardingState =>
  state.lessons[id] === 'done' && mark === 'skipped'
    ? state
    : { ...state, lessons: { ...state.lessons, [id]: mark } };

/** Start Over: the ticks cleared and the card back, the setup outcome kept. */
export const withLessonsReset = (state: OnboardingState): OnboardingState => ({
  ...state,
  card: 'expanded',
  lessons: {},
});

/** The card's rows: the lessons, led by "Add your accounts" while nothing is connected. */
export type LessonRowId = LessonId | 'accounts';
export interface LessonRow {
  readonly id: LessonRowId;
  readonly mark: LessonMark | undefined;
}
export const lessonRows = (
  state: OnboardingState,
  { accountCount }: { readonly accountCount: number },
): ReadonlyArray<LessonRow> => [
  ...(accountCount === 0 ? [{ id: 'accounts' as const, mark: undefined }] : []),
  ...LESSON_IDS.map((id) => ({ id, mark: state.lessons[id] })),
];

/** Which device the copy is written for: the lessons name it, and the other one. */
export type OnboardingDevice = 'iphone' | 'mac';

const DEVICE_NAME: Record<OnboardingDevice, string> = { iphone: 'iPhone', mac: 'Mac' };
const OTHER_DEVICE: Record<OnboardingDevice, OnboardingDevice> = { iphone: 'mac', mac: 'iphone' };

/** "this iPhone" / "this Mac". */
export const thisDevice = (device: OnboardingDevice): string => `this ${DEVICE_NAME[device]}`;
/** "your Mac" for an iPhone, "your iPhone" for a Mac. */
export const otherDevice = (device: OnboardingDevice): string =>
  `your ${DEVICE_NAME[OTHER_DEVICE[device]]}`;

/** The phrase the Create lesson opens the quick-add field with. */
export const LESSON_CREATE_PHRASE = 'Lunch with Sam tomorrow at 12:30 at Mercato';
/** The sentence the Search lesson opens the search with. */
export const LESSON_SEARCH_PHRASE = 'meetings with Sam last month';

export interface LessonCopy {
  /** One paragraph at the top of the lesson's frame. */
  readonly intro: string;
  /** Under the title on the card and in Settings. */
  readonly subtitle: string;
  readonly title: string;
}

/** What each row says, on the device it is read on. */
export const lessonCopy = (id: LessonRowId, device: OnboardingDevice): LessonCopy => {
  const here = thisDevice(device);
  const other = otherDevice(device);
  switch (id) {
    case 'accounts':
      return {
        intro: 'Pick what you use, connect it, done in a minute.',
        subtitle: 'Google Calendar, Google Tasks, Apple Calendar, Reminders',
        title: 'Add your accounts',
      };
    case 'create':
      return {
        intro: `Describe an event the way you would say it. Solunivo reads the words on ${here} and drafts it — dashed until you save. Change it in the same field: “at 1 instead”, “make it Thursday”.`,
        subtitle: 'Describe an event; a draft lands on the calendar',
        title: 'Create with AI',
      };
    case 'search':
      return {
        intro: `Ask in a sentence. Solunivo turns the words into filters you can see and edit — on ${here}.`,
        subtitle: `Ask in a sentence — “${LESSON_SEARCH_PHRASE}”`,
        title: 'Search with AI',
      };
    case 'alerts':
      return {
        intro: `Solunivo schedules alerts on ${here} itself. Nothing goes through a server, and the times come from each event.`,
        subtitle: `Event and birthday reminders on ${here}`,
        title: 'Alerts',
      };
    case 'contacts':
      return {
        intro:
          'Two things get better with your contacts: inviting people by name, and birthdays on the calendar.',
        subtitle: 'Invite by name, birthdays on the calendar',
        title: `Contacts on ${here}`,
      };
    case 'zones':
      return {
        intro:
          'Travelling, or working with people elsewhere? Add up to three zones. They stack beside the hours, so 9:00 here reads as midnight there at a glance.',
        subtitle: 'Up to three, stacked beside the hours',
        title: 'Time zones',
      };
    case 'otherDevice':
      return {
        intro: `Carry this setup over as a file: export it here, send it to ${other} (AirDrop works), and import it there under Settings › Settings File. It never holds passwords or tokens; each Google account signs in once there.`,
        subtitle: 'Carry this setup over as a file',
        title: `Set up ${other}`,
      };
  }
};
