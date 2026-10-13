import { useEffect } from 'react';
import { useEditorHost } from '../src/ui/EditorHost.tsx';

/**
 * The editor as a form sheet over the tabs (`_layout.tsx`): half height
 * for a new item, so the calendar behind shows its drafts and takes taps,
 * full for an existing one; the grabber moves between them. The host owns
 * what it shows (`EditorHost`): a non-collapsable header and the form's
 * scroll view, the two things react-native-screens lays a sheet out as. A
 * swipe down dismisses it, which is Cancel, as the page sheet's was.
 */
export default function EditorRoute() {
  const host = useEditorHost();
  const { onEditorDismissed, onEditorShown } = host;
  useEffect(() => {
    onEditorShown();
    return () => onEditorDismissed();
  }, [onEditorDismissed, onEditorShown]);
  return host.renderEditor();
}
