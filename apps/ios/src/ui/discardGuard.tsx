import { DISCARD_ANSWERS } from '@calendar/app-state';
import { usePreventRemove } from 'expo-router';
import { useRef } from 'react';
import { ActionSheetIOS } from 'react-native';

/**
 * The question before an editor that holds something closes: an action
 * sheet (HIG → Sheets, as Calendar asks it). Resolves whether to discard.
 * Not anchored to Cancel: React Native passes an anchor on to UIKit on
 * the iPad only (on an iPhone under iOS 26 it would leave the sheet
 * behind it interactive), and this app is the iPhone's.
 */
const askDiscard = (message: string): Promise<boolean> =>
  new Promise((resolve) => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        cancelButtonIndex: 1,
        destructiveButtonIndex: 0,
        message,
        options: [DISCARD_ANSWERS.discard, DISCARD_ANSWERS.keep],
      },
      (index) => resolve(index === 0),
    );
  });

/**
 * A swipe down on the editor's sheet while `guard` holds: the sheet
 * springs back rather than leaving (expo-router's prevent-remove sets
 * the sheet's `isModalInPresentation`) and `onAttempt` asks. The route's
 * editor renders it, since the hook needs the route's screen around it;
 * the birthday's page sheet has nothing to discard.
 */
export function SwipeGuard({
  guard,
  onAttempt,
}: {
  readonly guard: boolean;
  readonly onAttempt: () => void;
}) {
  usePreventRemove(guard, onAttempt);
  return null;
}

/**
 * The editor's ways out while it holds something (`unsaved`, or words in
 * the Assistant's field): Cancel asks before it cancels, and a swipe down
 * springs back and asks before the sheet closes — the detail Edit came
 * from too, as a swipe always closes the whole sheet. Not once the host
 * has moved on (`open` false): its own close (Save, Delete, a share) is
 * no swipe, and must not be held.
 */
export const useDiscard = ({
  held,
  onCancel,
  onClose,
  open,
  question,
  unsaved,
}: {
  readonly held: boolean;
  readonly onCancel: () => void;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly question: string;
  readonly unsaved: boolean;
}) => {
  const holds = unsaved || held;
  // One question at a time: a second tap while the sheet asks is no second question.
  const asking = useRef(false);
  const ask = async (then: () => void) => {
    if (asking.current) {
      return;
    }
    asking.current = true;
    try {
      if (await askDiscard(question)) {
        then();
      }
    } finally {
      asking.current = false;
    }
  };
  return {
    cancel: () => {
      if (holds) {
        void ask(onCancel);
      } else {
        onCancel();
      }
    },
    guard: holds && open,
    swipe: () => void ask(onClose),
  };
};
