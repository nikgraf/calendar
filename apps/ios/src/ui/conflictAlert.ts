import type { ConflictChoice, ParkedOpSummary } from '@calendar/core';
import { conflictChoiceLabels, describeConflict, Temporal } from '@calendar/core';
import { Alert } from 'react-native';

/**
 * The keep-mine / take-theirs question for a parked 412, as a native
 * alert: the event, what differs ("Time: yours … · Google's …"), and the
 * two choices plus Later. The banner and the Settings queue row share it.
 */
export const askConflict = (
  op: ParkedOpSummary,
  resolve: (params: { readonly choice: ConflictChoice; readonly opId: string }) => unknown,
): void => {
  const { changes, headline } = describeConflict(op, Temporal.Now.timeZoneId());
  const labels = conflictChoiceLabels(op);
  const detail = changes
    .map((change) => `${change.label}\nYours: ${change.mine}\nGoogle's: ${change.theirs}`)
    .join('\n\n');
  Alert.alert(headline, detail || undefined, [
    { style: 'cancel', text: 'Later' },
    { onPress: () => void resolve({ choice: 'theirs', opId: op.id }), text: labels.theirs },
    { onPress: () => void resolve({ choice: 'mine', opId: op.id }), text: labels.mine },
  ]);
};
