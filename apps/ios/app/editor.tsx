import { useEffect } from 'react';
import { useEditorHost } from '../src/ui/EditorHost.tsx';

/**
 * The editor as a page sheet over the tabs (`_layout.tsx`), at full
 * height. The host owns what it shows (`EditorHost`); this route only
 * says when it is up. A swipe down dismisses it, which is Cancel.
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
