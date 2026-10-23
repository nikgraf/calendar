import { Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyOnboardingChange,
  canonicalOnboardingState,
  cardVisible,
  DEFAULT_ONBOARDING_STATE,
  LESSON_COUNT,
  LESSON_IDS,
  lessonCopy,
  lessonPosition,
  lessonProgress,
  lessonRows,
  nextLesson,
  OnboardingState,
  setupNeeded,
  withLessonMark,
  withLessonsReset,
} from './onboarding.ts';

const decode = Schema.decodeUnknownOption(OnboardingState);
const accepts = (value: unknown) => decode(value)._tag === 'Some';

const allDone: OnboardingState = {
  card: 'expanded',
  lessons: Object.fromEntries(LESSON_IDS.map((id) => [id, 'done' as const])),
  setup: 'done',
};

describe('OnboardingState schema', () => {
  it('accepts the default, a partial lesson map and both setup outcomes', () => {
    expect(accepts(DEFAULT_ONBOARDING_STATE)).toBe(true);
    expect(accepts({ card: 'collapsed', lessons: { create: 'done', zones: 'skipped' } })).toBe(
      true,
    );
    expect(accepts({ card: 'hidden', lessons: {}, setup: 'skipped' })).toBe(true);
  });

  it('rejects an unknown card state or mark', () => {
    expect(accepts({ card: 'open', lessons: {} })).toBe(false);
    expect(accepts({ card: 'expanded', lessons: { create: 'seen' } })).toBe(false);
    expect(accepts({ card: 'expanded', lessons: {}, setup: 'later' })).toBe(false);
  });
});

describe('canonicalOnboardingState', () => {
  it('keeps only the marks that are set, in card order, and the setup only when set', () => {
    expect(
      canonicalOnboardingState({
        card: 'expanded',
        lessons: { alerts: undefined, create: 'skipped', zones: 'done' },
      }),
    ).toEqual({ card: 'expanded', lessons: { create: 'skipped', zones: 'done' } });
    expect(Object.keys(canonicalOnboardingState(allDone).lessons)).toEqual([...LESSON_IDS]);
    expect(canonicalOnboardingState(allDone).setup).toBe('done');
  });
});

describe('progress and visibility', () => {
  it('counts every mark as progress, tried or skipped', () => {
    expect(lessonProgress(DEFAULT_ONBOARDING_STATE)).toEqual({ done: 0, total: LESSON_COUNT });
    expect(
      lessonProgress({ card: 'expanded', lessons: { create: 'done', search: 'skipped' } }),
    ).toEqual({ done: 2, total: LESSON_COUNT });
  });

  it('shows the card until it is hidden or every lesson is ticked', () => {
    expect(cardVisible(DEFAULT_ONBOARDING_STATE)).toBe(true);
    expect(cardVisible({ ...DEFAULT_ONBOARDING_STATE, card: 'collapsed' })).toBe(true);
    expect(cardVisible({ ...DEFAULT_ONBOARDING_STATE, card: 'hidden' })).toBe(false);
    expect(cardVisible(allDone)).toBe(false);
  });

  it('needs the setup only while nothing is connected and it never ran', () => {
    expect(setupNeeded(DEFAULT_ONBOARDING_STATE, 0)).toBe(true);
    expect(setupNeeded(DEFAULT_ONBOARDING_STATE, 1)).toBe(false);
    expect(setupNeeded({ ...DEFAULT_ONBOARDING_STATE, setup: 'skipped' }, 0)).toBe(false);
    expect(setupNeeded({ ...DEFAULT_ONBOARDING_STATE, setup: 'done' }, 0)).toBe(false);
  });

  it('names the next open lesson in card order, and its position', () => {
    expect(nextLesson(DEFAULT_ONBOARDING_STATE)).toBe('create');
    expect(nextLesson({ card: 'expanded', lessons: { create: 'done', search: 'skipped' } })).toBe(
      'alerts',
    );
    expect(nextLesson(allDone)).toBeUndefined();
    expect(lessonPosition('create')).toBe(1);
    expect(lessonPosition('otherDevice')).toBe(LESSON_COUNT);
  });
});

describe('marks', () => {
  it('ticks a lesson, and a try is never downgraded to a skip', () => {
    const skipped = withLessonMark(DEFAULT_ONBOARDING_STATE, 'alerts', 'skipped');
    expect(skipped.lessons.alerts).toBe('skipped');
    const done = withLessonMark(skipped, 'alerts', 'done');
    expect(done.lessons.alerts).toBe('done');
    expect(withLessonMark(done, 'alerts', 'skipped')).toBe(done);
  });

  it('Start Over clears the ticks and shows the card again, keeping the setup outcome', () => {
    expect(withLessonsReset({ ...allDone, card: 'hidden' })).toEqual({
      card: 'expanded',
      lessons: {},
      setup: 'done',
    });
  });
});

describe('applyOnboardingChange', () => {
  const stored: OnboardingState = {
    card: 'collapsed',
    lessons: { create: 'done', zones: 'skipped' },
    setup: 'skipped',
  };

  it('changes only what it names, keeping the marks and the outcome', () => {
    expect(applyOnboardingChange(stored, { card: 'hidden' })).toEqual({
      ...stored,
      card: 'hidden',
    });
    expect(applyOnboardingChange(stored, { setup: 'done' })).toEqual({ ...stored, setup: 'done' });
    expect(applyOnboardingChange(stored, { lesson: { id: 'alerts', mark: 'skipped' } })).toEqual({
      ...stored,
      lessons: { ...stored.lessons, alerts: 'skipped' },
    });
  });

  it('never downgrades a try to a skip', () => {
    expect(applyOnboardingChange(stored, { lesson: { id: 'create', mark: 'skipped' } })).toBe(
      stored,
    );
  });

  it('two changes made from the same read both land, in either order', () => {
    const first = { lesson: { id: 'alerts', mark: 'skipped' } } as const;
    const second = { lesson: { id: 'search', mark: 'done' } } as const;
    const expected = {
      ...stored,
      lessons: { ...stored.lessons, alerts: 'skipped', search: 'done' },
    };
    expect(applyOnboardingChange(applyOnboardingChange(stored, first), second)).toEqual(expected);
    expect(applyOnboardingChange(applyOnboardingChange(stored, second), first)).toEqual(expected);
  });

  it('resets: Start Over keeps the outcome, all is a fresh install', () => {
    expect(applyOnboardingChange(stored, { reset: 'lessons' })).toEqual({
      card: 'expanded',
      lessons: {},
      setup: 'skipped',
    });
    expect(applyOnboardingChange(stored, { reset: 'all' })).toEqual(DEFAULT_ONBOARDING_STATE);
  });
});

describe('lessonRows', () => {
  it('leads with "Add your accounts" while nothing is connected', () => {
    expect(lessonRows(DEFAULT_ONBOARDING_STATE, { accountCount: 0 }).map((row) => row.id)).toEqual([
      'accounts',
      ...LESSON_IDS,
    ]);
    const rows = lessonRows({ card: 'expanded', lessons: { search: 'done' } }, { accountCount: 2 });
    expect(rows.map((row) => row.id)).toEqual([...LESSON_IDS]);
    expect(rows.find((row) => row.id === 'search')?.mark).toBe('done');
    expect(rows.find((row) => row.id === 'create')?.mark).toBeUndefined();
  });
});

describe('lessonCopy', () => {
  it('names the device the lesson runs on, and the other one for the copy', () => {
    expect(lessonCopy('contacts', 'iphone').title).toBe('Contacts on this iPhone');
    expect(lessonCopy('contacts', 'mac').title).toBe('Contacts on this Mac');
    expect(lessonCopy('otherDevice', 'iphone').title).toBe('Set up your Mac');
    expect(lessonCopy('otherDevice', 'mac').title).toBe('Set up your iPhone');
    for (const id of [...LESSON_IDS, 'accounts' as const]) {
      const copy = lessonCopy(id, 'mac');
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.subtitle.length).toBeGreaterThan(0);
      expect(copy.intro.length).toBeGreaterThan(0);
    }
  });
});
