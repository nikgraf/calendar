import { type NativeStackNavigationProp, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEditorHost } from '../src/ui/EditorHost.tsx';
import { EditorSheetHeight, editorDetentIndex, editorSheetHeight } from '../src/ui/editorSheet.ts';

/**
 * The editor as a form sheet over the tabs (`_layout.tsx`): half height
 * for a new item, so the calendar behind shows its drafts and takes taps,
 * full for an existing one; the grabber moves between them, and so does
 * a drag on the form, which raises a half sheet before it scrolls. The
 * host owns what it shows (`EditorHost`): a non-collapsable header and
 * the form's scroll view, the two things react-native-screens lays a
 * sheet out as. A swipe down dismisses it, which is Cancel, as the page
 * sheet's was. The route follows the detent the sheet stands at (a drag,
 * the grabber) and hands its height down (`EditorSheetHeight`): the
 * thread under the quick-add field takes a share of it. The keyboard
 * lifts a half sheet without changing its detent, so the height stays the
 * half one while it is up, which is about the room left above it.
 */
export default function EditorRoute() {
  const host = useEditorHost();
  const { onEditorDismissed, onEditorShown } = host;
  useEffect(() => {
    onEditorShown();
    return () => onEditorDismissed();
  }, [onEditorDismissed, onEditorShown]);
  const { detent } = useLocalSearchParams<{ detent?: string }>();
  const [detentIndex, setDetentIndex] = useState(() => editorDetentIndex(detent));
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  useEffect(
    () => navigation.addListener('sheetDetentChange', (event) => setDetentIndex(event.data.index)),
    [navigation],
  );
  const { height } = useWindowDimensions();
  const { top } = useSafeAreaInsets();
  return (
    <EditorSheetHeight value={editorSheetHeight(detentIndex, height, top)}>
      {host.renderEditor()}
    </EditorSheetHeight>
  );
}
