import {
  pendingOpLabel,
  useGuardedMutations,
  usePendingOps,
  useTimeZones,
} from '@calendar/app-state';
import { describeConflict, isParkedOp, type PendingOpSummary } from '@calendar/core';
import { useState } from 'react';
import { askConflict } from '../conflictAlert.ts';
import { useTheme } from '../theme.ts';
import {
  ActionRow,
  DetailLines,
  type DetailLine,
  Footer,
  Glyph,
  LeadingSymbol,
  Row,
  Section,
  SettingsPage,
} from './GroupedList.tsx';

/** No snapshot to compare against: the change was queued by an earlier version. */
const NO_DETAILS = 'No details for this change.';
/** A snapshot, but nothing this list can show differs (a field it does not draw). */
const NO_DIFFERENCE = 'No visible difference.';

/**
 * What an expanded row shows: a parked change as "yours" and "Google's"
 * per field (the conflict alert's words), any other as before → after.
 */
const detailLines = (op: PendingOpSummary, timeZone: string): ReadonlyArray<DetailLine> =>
  isParkedOp(op)
    ? describeConflict(op, timeZone).changes.flatMap((change) => [
        { after: change.mine, before: null, label: `${change.label} (yours)` },
        { after: change.theirs, before: null, label: `${change.label} (Google’s)` },
      ])
    : (op.diff ?? []);

/**
 * The changes still waiting for Google. Tapping one opens what it does,
 * field by field, and the way to discard it — which puts the item back
 * as it was — or, for a conflict (Google changed the item too), the
 * choice between the two versions. The calendar's unsynced badge opens
 * Settings, where the list is the first row while there is one.
 */
export function UnsyncedPage() {
  const { colors } = useTheme();
  const pendingOps = usePendingOps();
  const guarded = useGuardedMutations();
  const { primary: timeZone } = useTimeZones();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <SettingsPage testID="settings-page-unsynced">
      {pendingOps.length > 0 ? (
        <Section
          footer="These changes are saved on this iPhone and go to Google as soon as it accepts them. Tap one to see what it does and to discard it."
          header="Waiting for Google"
        >
          {pendingOps.flatMap((op) => {
            const label = pendingOpLabel(op);
            const expanded = expandedId === op.id;
            const parked = isParkedOp(op);
            const row = (
              <Row
                accessibilityState={{ expanded }}
                accessory={
                  <Glyph
                    name={expanded ? 'chevron.up' : 'chevron.down'}
                    size={13}
                    tintColor={colors['border-strong']}
                    weight="semibold"
                  />
                }
                key={op.id}
                leading={
                  parked ? (
                    <LeadingSymbol color={colors.warning} name="exclamationmark.triangle.fill" />
                  ) : (
                    <LeadingSymbol color={colors['text-secondary']} name="clock" />
                  )
                }
                onPress={() => setExpandedId(expanded ? null : op.id)}
                subtitle={
                  label.reason
                    ? `${label.retry ?? 'Waiting to sync'}\n${label.reason}`
                    : (label.retry ?? 'Waiting to sync')
                }
                subtitleTone={parked ? 'warning' : 'secondary'}
                testID={`pending-op-${op.id}`}
                title={label.text}
              />
            );
            if (!expanded) {
              return [row];
            }
            return [
              row,
              <DetailLines
                emptyText={op.diff === undefined && !parked ? NO_DETAILS : NO_DIFFERENCE}
                key={`${op.id}-detail`}
                lines={detailLines(op, timeZone)}
                testID={`pending-op-change-${op.id}`}
              />,
              parked ? (
                <ActionRow
                  key={`${op.id}-resolve`}
                  onPress={() => askConflict(op, guarded.resolveConflict, timeZone)}
                  testID={`pending-resolve-${op.id}`}
                  title="Resolve…"
                />
              ) : (
                <ActionRow
                  key={`${op.id}-discard`}
                  onPress={() => {
                    setExpandedId(null);
                    void guarded.discardPendingOp({ opId: op.id });
                  }}
                  testID={`pending-discard-${op.id}`}
                  title="Discard Change"
                  tone="destructive"
                />
              ),
            ];
          })}
        </Section>
      ) : (
        <Footer testID="unsynced-empty">
          Nothing is waiting — every change has reached Google.
        </Footer>
      )}
    </SettingsPage>
  );
}
