import { Button } from '../ui/Button.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { EyeIcon, EyeOffIcon } from '../ui/icons.tsx';
import { usePrivacy } from '../usePrivacy.ts';

const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

/**
 * Screen privacy, in the toolbar: macOS tells an app nothing when a
 * screenshot or recording starts, so the window says it is left out of
 * captures for as long as it is. One click shows it for 10 minutes, with
 * the time left on the button; a second click hides it again. Always
 * visible (Settings › General) draws nothing.
 */
export function PrivacyIndicator() {
  const privacy = usePrivacy();
  if (!privacy || privacy.active === 'visible') {
    return null;
  }
  if (privacy.active === 'pause10m') {
    const label = `Visible in screenshots and screen sharing for ${privacy.minutesLeft} more min — click to hide`;
    return (
      <Button
        aria-label={label}
        data-state="paused"
        data-testid="privacy-indicator"
        onClick={() => privacy.choose('hidden')}
        size="sm"
        style={noDrag}
        title={label}
      >
        <EyeIcon />
        {privacy.minutesLeft} min
      </Button>
    );
  }
  return (
    <IconButton
      data-state="hidden"
      data-testid="privacy-indicator"
      label="Hidden from screenshots and screen sharing — click to show for 10 min"
      onClick={() => privacy.choose('pause10m')}
      style={noDrag}
    >
      <EyeOffIcon />
    </IconButton>
  );
}
