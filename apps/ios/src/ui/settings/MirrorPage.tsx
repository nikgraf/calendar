import {
  draftOf,
  type MirrorDraft,
  refLabel,
  useBackendMutations,
  useMirrors,
} from '@calendar/app-state';
import {
  describeMirrorStatus,
  MIRROR_COPY,
  MIRROR_PRESET_COPY,
  mirrorPresetOf,
} from '@calendar/core';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import {
  ActionRow,
  Chevron,
  Footer,
  Row,
  Section,
  SettingsPage,
  SwitchRow,
} from './GroupedList.tsx';
import { MirrorEditSheet } from './MirrorEditSheet.tsx';

/**
 * One mirror: its switch on this iPhone, a run on demand and what it is
 * doing, a summary of what it copies, and Delete. Every field is changed
 * in the editor sheet, which previews the copies and saves the whole
 * mirror at once; a tap on any summary row opens it.
 */
export function MirrorPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const mirrors = useMirrors();
  const mutations = useBackendMutations();
  const [editing, setEditing] = useState<MirrorDraft | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const view = mirrors.find((candidate) => candidate.definition.id === id);

  if (!view) {
    return (
      <SettingsPage testID="settings-page-mirror">
        <Footer>This mirror is no longer on this iPhone.</Footer>
      </SettingsPage>
    );
  }
  const definition = view.definition;
  const preset = MIRROR_PRESET_COPY[mirrorPresetOf(definition)];
  const run = (task: Promise<unknown>) =>
    void task.then(
      () => setFailure(null),
      (error: unknown) => setFailure(String(error)),
    );
  const edit = () => setEditing(draftOf(definition));
  // Back to the list once it is gone; a failure keeps the page up and says so.
  const remove = (removeCopies: boolean) =>
    void mutations.deleteMirror({ id: definition.id, removeCopies }).then(
      () => router.back(),
      (error: unknown) => setFailure(String(error)),
    );
  const confirmDelete = () =>
    Alert.alert(
      `Delete “${definition.name}”?`,
      'If another device still runs this mirror, it will copy the events again — delete it there too.',
      [
        { style: 'cancel', text: 'Cancel' },
        { onPress: () => remove(false), text: 'Keep the copies' },
        { onPress: () => remove(true), style: 'destructive', text: 'Delete and remove copies' },
      ],
    );

  return (
    <SettingsPage testID="settings-page-mirror">
      <Stack.Screen options={{ title: definition.name }} />
      <Section
        footer={
          <>
            <Footer testID={`mirror-status-${definition.id}`}>
              {describeMirrorStatus(view.status)}
            </Footer>
            {failure ? (
              <Footer testID="mirror-failed" tone="danger">
                {failure}
              </Footer>
            ) : null}
          </>
        }
      >
        <SwitchRow
          onValueChange={(enabled) =>
            run(mutations.setMirrorEnabled({ enabled, id: definition.id }))
          }
          switchTestID={`mirror-enabled-${definition.id}`}
          title="Run on This iPhone"
          value={view.enabled}
        />
        {/* Runs every mirror, as the sync engine does; there is no per-mirror run. */}
        <ActionRow
          disabled={view.status.state === 'off'}
          onPress={() => run(mutations.runMirrorsNow(undefined))}
          testID={`mirror-run-${definition.id}`}
          title="Run Now"
        />
      </Section>

      <Section footer={`${preset.description} ${MIRROR_COPY.window(definition.monthsAhead)}`}>
        <Row
          accessory={<Chevron />}
          onPress={edit}
          title="Copy From"
          value={definition.sources.map(refLabel).join(', ')}
        />
        <Row
          accessory={<Chevron />}
          onPress={edit}
          title="Copy Into"
          value={refLabel(definition.destination)}
        />
        <Row accessory={<Chevron />} onPress={edit} title="What Others See" value={preset.title} />
        <Row
          accessory={<Chevron />}
          onPress={edit}
          title="Months Ahead"
          value={String(definition.monthsAhead)}
        />
      </Section>

      <Section>
        <ActionRow onPress={edit} testID={`mirror-edit-${definition.id}`} title="Edit Mirror…" />
      </Section>
      <Section>
        <ActionRow
          onPress={confirmDelete}
          testID={`mirror-delete-${definition.id}`}
          title="Delete Mirror…"
          tone="destructive"
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
