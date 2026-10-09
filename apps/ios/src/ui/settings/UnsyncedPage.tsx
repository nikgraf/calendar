import {
  pendingOpLabel,
  useGuardedMutations,
  usePendingOps,
  useTimeZones,
} from '@calendar/app-state';
import { isParkedOp } from '@calendar/core';
import { askConflict } from '../conflictAlert.ts';
import { useTheme } from '../theme.ts';
import {
  CapsuleButton,
  Footer,
  LeadingSymbol,
  Row,
  Section,
  SettingsPage,
  SwipeRow,
} from './GroupedList.tsx';

/**
 * The changes still waiting for Google. A conflict (Google changed the
 * item too) is resolved from its row; anything else can be discarded with
 * a swipe. The calendar's unsynced badge opens this page directly.
 */
export function UnsyncedPage() {
  const { colors } = useTheme();
  const pendingOps = usePendingOps();
  const guarded = useGuardedMutations();
  const { primary: timeZone } = useTimeZones();

  return (
    <SettingsPage testID="settings-page-unsynced">
      {pendingOps.length > 0 ? (
        <Section
          footer="These changes are saved on this iPhone and go to Google as soon as it accepts them. Swipe left on one to discard it."
          header="Waiting for Google"
        >
          {pendingOps.map((op) => {
            const label = pendingOpLabel(op);
            return isParkedOp(op) ? (
              <Row
                accessory={
                  <CapsuleButton
                    label="Resolve…"
                    onPress={() => askConflict(op, guarded.resolveConflict, timeZone)}
                    testID={`pending-resolve-${op.id}`}
                  />
                }
                key={op.id}
                leading={
                  <LeadingSymbol color={colors.warning} name="exclamationmark.triangle.fill" />
                }
                subtitle={label.retry ?? undefined}
                subtitleTone="warning"
                testID={`pending-op-${op.id}`}
                title={label.text}
              />
            ) : (
              <SwipeRow
                action={() => void guarded.discardPendingOp({ opId: op.id })}
                actionLabel="Discard"
                actionTestID={`pending-discard-${op.id}`}
                key={op.id}
                leading={<LeadingSymbol color={colors['text-secondary']} name="clock" />}
                subtitle={label.retry ?? 'Waiting to sync'}
                testID={`pending-op-${op.id}`}
                title={label.text}
              />
            );
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
