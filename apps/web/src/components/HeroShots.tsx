import desktopDark from '../screenshots/desktop-dark.webp';
import desktopLight from '../screenshots/desktop-light.webp';
import iphoneDark from '../screenshots/iphone-dark.webp';
import iphoneLight from '../screenshots/iphone-light.webp';
import { ThemePicture } from './ThemePicture.tsx';

/**
 * The real apps: the Mac's week view with the iPhone's day view over its
 * corner. Captured from the fixture-driven builds (docs/distribution.md →
 * Website), one file per color scheme.
 */
export function HeroShots() {
  return (
    <div className="hero-shots">
      <div className="hero-mac">
        <ThemePicture
          alt="The Mac app in week view: a week of events in four calendar colors, tasks and reminders in the all-day lane, Google and Apple calendars side by side in the sidebar, and an Up next card"
          dark={desktopDark}
          fetchPriority="high"
          height={1473}
          light={desktopLight}
          width={2400}
        />
      </div>
      <div className="hero-phone">
        <ThemePicture
          alt="The iPhone app in day view: the week strip, two tasks in the all-day lane and the day's events"
          dark={iphoneDark}
          height={1957}
          light={iphoneLight}
          width={900}
        />
      </div>
    </div>
  );
}
