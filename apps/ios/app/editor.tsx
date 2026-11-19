import { useEffect } from 'react';
import { useEditorHost } from '../src/ui/EditorHost.tsx';

/**
 * The editor as a page sheet over the tabs (`_layout.tsx`), at full
 * height, and the event detail that Edit turns into it in the same sheet.
 * The host owns what it shows (`EditorHost`); this route only says when
 * it is up. A swipe down dismisses it, which closes the detail and is
 * the editor's Cancel — of the whole sheet, the detail too.
 */
export default function EditorRoute() {
  const host = useEditorHost();
  const { onEditorDismissed, onEditorShown } = host;
  useEffect(() => {
    onEditorShown();
    return () => onEditorDismissed();
  }, [onEditorDismissed, onEditorShown]);
  return host.renderRoute();
}
