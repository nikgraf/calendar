import { SegmentedControl } from './ui/SegmentedControl.tsx';
import { type PrivacyChoice, usePrivacy } from './usePrivacy.ts';

/** Screen-sharing privacy control backed by the main-process window state. */
export function PrivacySection() {
  const privacy = usePrivacy();
  if (!privacy) {
    return null;
  }

  const { active, choose, minutesLeft } = privacy;
  const paused = active === 'pause10m';
  const options: ReadonlyArray<{ label: string; value: PrivacyChoice }> = [
    { label: 'Hidden', value: 'hidden' },
    {
      label: paused ? `Visible · ${minutesLeft} min left` : 'Visible for 10 min',
      value: 'pause10m',
    },
    { label: 'Always visible', value: 'visible' },
  ];

  return (
    <section className="rounded-popover bg-surface-subtle p-4">
      <h2 className="font-medium">Privacy</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        Hide Solunivo&rsquo;s windows from screen sharing and recordings. They stay visible on your
        own display.
      </p>
      <SegmentedControl
        className="mt-3 w-full"
        grow
        label="Screen-sharing visibility"
        onChange={choose}
        options={options.map((option) => ({ label: option.label, value: option.value }))}
        size="sm"
        value={active}
      />
    </section>
  );
}
