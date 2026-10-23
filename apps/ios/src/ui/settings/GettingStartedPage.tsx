import { useOnboarding, useTimeZones, useUpdateOnboarding } from '@calendar/app-state';
import {
  DEFAULT_ONBOARDING_STATE,
  LESSON_IDS,
  lessonCopy,
  lessonProgress,
  Temporal,
} from '@calendar/core';
import { useEditorHost } from '../EditorHost.tsx';
import {
  ActionRow,
  Chevron,
  Footer,
  Glyph,
  Row,
  Section,
  SettingsPage,
  SwitchRow,
} from '../GroupedList.tsx';
import { openLesson } from '../lessons.ts';
import { useTheme } from '../theme.ts';

/**
 * Settings › Getting Started: whether the card shows at the top of the
 * Calendar tab, every lesson (ticked when tried or skipped) to open again,
 * and Start Over, which clears the ticks and brings the card back.
 */
export function GettingStartedPage() {
  const { colors } = useTheme();
  const host = useEditorHost();
  const zones = useTimeZones();
  const timeZone = zones.loaded ? zones.primary : Temporal.Now.timeZoneId();
  const state = useOnboarding() ?? DEFAULT_ONBOARDING_STATE;
  const update = useUpdateOnboarding();
  const progress = lessonProgress(state);
  return (
    <SettingsPage testID="settings-page-getting-started">
      <Section footer="The Getting started card at the top of the Calendar tab. It leaves by itself when every lesson is done; off hides it now. The lessons stay here either way.">
        <SwitchRow
          // On with every lesson ticked: a card with nothing left would not
          // show, so it starts over.
          onValueChange={(on) =>
            void update(
              !on
                ? { card: 'hidden' }
                : progress.done >= progress.total
                  ? { reset: 'lessons' }
                  : { card: 'expanded' },
            )
          }
          switchTestID="getting-started-show"
          title="Show in Calendar"
          value={state.card !== 'hidden' && progress.done < progress.total}
        />
      </Section>
      <Section
        footer="Open any lesson again, any time. A tick means you tried or skipped it."
        header={`Lessons · ${String(progress.done)} of ${String(progress.total)} done`}
      >
        {LESSON_IDS.map((id) => {
          const ticked = state.lessons[id] !== undefined;
          return (
            <Row
              accessibilityLabel={`${lessonCopy(id, 'iphone').title}${ticked ? ', done' : ''}`}
              accessory={<Chevron />}
              key={id}
              leading={
                ticked ? (
                  <Glyph
                    name="checkmark.circle.fill"
                    size={22}
                    tintColor={colors.primary}
                    weight="medium"
                  />
                ) : (
                  <Glyph name="circle" size={22} tintColor={colors['border-strong']} />
                )
              }
              onPress={() => openLesson(id, host, { from: 'settings', timeZone })}
              testID={`getting-started-lesson-${id}${ticked ? '-done' : ''}`}
              title={lessonCopy(id, 'iphone').title}
            />
          );
        })}
      </Section>
      <Section>
        <ActionRow
          onPress={() => void update({ reset: 'lessons' })}
          testID="getting-started-start-over"
          title="Start Over"
        />
      </Section>
      <Footer>Clears the ticks and shows the card again. Nothing else changes.</Footer>
    </SettingsPage>
  );
}
