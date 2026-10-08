import {
  type MirrorDraft,
  newMirrorDraft,
  useMirrors,
  useTimeZoneSettings,
} from '@calendar/app-state';
import { describeMirrorStatus, MIRROR_COPY, Temporal } from '@calendar/core';
import { useState } from 'react';
import { useTheme } from '../theme.ts';
import {
  ActionRow,
  Footer,
  IconTile,
  NavRow,
  PageHero,
  Section,
  SettingsPage,
} from './GroupedList.tsx';
import { MirrorEditSheet } from './MirrorEditSheet.tsx';

/**
 * Calendar mirrors on this iPhone: what a mirror is, one row per mirror
 * with what it is doing here (each opens its page), and adding one in the
 * editor sheet.
 */
export function MirrorsPage() {
  const { colors } = useTheme();
  const mirrors = useMirrors();
  const timeZone = useTimeZoneSettings()?.primary ?? Temporal.Now.timeZoneId();
  const [editing, setEditing] = useState<MirrorDraft | null>(null);

  return (
    <SettingsPage testID="settings-page-mirrors">
      <PageHero
        icon={
          <IconTile color={colors['event-mint-edge']} name="rectangle.on.rectangle" size={56} />
        }
        subtitle={MIRROR_COPY.intro}
        title="Mirrors"
      />
      <Section
        footer={
          <>
            <Footer>{MIRROR_COPY.hidden}</Footer>
            <Footer>{MIRROR_COPY.freshness}</Footer>
            <Footer>{MIRROR_COPY.devices}</Footer>
          </>
        }
        testID="mirrors"
      >
        {mirrors.map((view) => (
          <NavRow
            href={{ params: { id: view.definition.id }, pathname: '/settings/mirror' }}
            key={view.definition.id}
            subtitle={describeMirrorStatus(view.status)}
            subtitleTone={view.status.state === 'paused' ? 'warning' : 'secondary'}
            testID={`mirror-row-${view.definition.id}`}
            title={view.definition.name}
            value={view.enabled ? 'On' : 'Off'}
          />
        ))}
        <ActionRow
          onPress={() => setEditing(newMirrorDraft(timeZone))}
          testID="mirror-add"
          title="Add Mirror…"
        />
      </Section>
      {editing ? (
        <MirrorEditSheet
          initial={editing}
          key={editing.id}
          mirrors={mirrors}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SettingsPage>
  );
}
