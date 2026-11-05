import desktopDark from '../screenshots/desktop-dark.webp?url';
import desktopLight from '../screenshots/desktop-light.webp?url';
import iphoneDark from '../screenshots/iphone-dark.webp?url';
import iphoneLight from '../screenshots/iphone-light.webp?url';
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
          alt="Mac week view with school pickup at 3:15 on Monday, Wednesday, and Friday, plus work meetings and a Saturday reminder to water the flowers"
          dark={desktopDark}
          fetchPriority="high"
          height={1500}
          light={desktopLight}
          width={2400}
        />
      </div>
      <div className="hero-phone">
        <ThemePicture
          alt="iPhone day view for Wednesday, with user interviews in the morning, a dentist appointment, and school pickup at 3:15"
          dark={iphoneDark}
          height={1957}
          light={iphoneLight}
          width={900}
        />
      </div>
    </div>
  );
}
