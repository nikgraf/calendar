import lockupDark from '../../../../brand/logos/lockup-horizontal-dark.svg';
import lockupLight from '../../../../brand/logos/lockup-horizontal-light.svg';
import { AiDemo } from '../components/AiDemo.tsx';
import { DownloadActions } from '../components/DownloadActions.tsx';
import { HeroShots } from '../components/HeroShots.tsx';
import {
  AppleIcon,
  CakeIcon,
  CloudOffIcon,
  GlobeIcon,
  GoogleIcon,
  LayersIcon,
} from '../components/icons.tsx';
import { Sources } from '../components/Sources.tsx';
import { ThemePicture } from '../components/ThemePicture.tsx';
import { releases } from '../links.ts';

const container = 'mx-auto max-w-[1200px] px-6 sm:px-8';
const h2 = 'm-0 text-[clamp(30px,3.2vw,40px)] leading-[1.15] font-semibold tracking-[-0.02em]';
const eyebrow = 'm-0 text-[13px] font-medium tracking-[0.08em] text-ink-secondary uppercase';
const lead = 'm-0 text-[17px] text-ink-secondary text-pretty';
const inlineLink =
  'text-ink underline decoration-hairline-strong underline-offset-[3px] hover:decoration-ink';

const features = [
  {
    body: 'Apple Calendar, Reminders and Contacts built in: your iCloud calendars beside Google’s, Reminders lists in the task lane, birthdays and guest suggestions from your address book.',
    icon: AppleIcon,
    title: 'Apple, first class',
  },
  {
    body: 'Google Calendar, Tasks and Contacts, all of it: every calendar you can see, task lists with subtasks and their order, guest suggestions from your contacts.',
    icon: GoogleIcon,
    title: 'Google, first class',
  },
  {
    body: (
      <>
        Outlook, Exchange and CalDAV accounts that Apple Calendar syncs show up beside the rest, and
        you edit their events here; invitations stay in Apple Calendar. Native Outlook and JMAP
        support are{' '}
        <a className={inlineLink} href="#roadmap">
          on the roadmap
        </a>
        .
      </>
    ),
    icon: LayersIcon,
    title: 'Outlook and CalDAV, too',
  },
  {
    body: 'Edit on a plane. Changes queue on the device and sync when you’re back online. If something changed on the server meanwhile, you choose which version stays.',
    icon: CloudOffIcon,
    title: 'Works offline, syncs later',
  },
  {
    body: 'Add the zones your team works in and read every event in each of them, stacked in the gutter. Finding a time across a remote team stops being arithmetic.',
    icon: GlobeIcon,
    title: 'Built for more than one time zone',
  },
  {
    body: 'Several alerts per birthday, each at its own lead time and hour: a week ahead to find a gift for some people, the morning of for others. Set per person.',
    icon: CakeIcon,
    title: 'Birthday reminders that fit each person',
  },
];

/** Planned, from the platform and account items in todo.md. */
const roadmap = [
  {
    items: [
      {
        body: 'Outlook.com and Microsoft 365 calendars signed in directly, with no Apple Calendar in between, so they can come to every platform.',
        title: 'Native Microsoft Outlook',
      },
      {
        body: 'Calendars over JMAP, the modern open protocol, synced directly instead of through a CalDAV account.',
        title: 'Native JMAP',
      },
    ],
    title: 'More accounts, natively',
  },
  {
    items: [
      { body: 'The phone app on Android.', title: 'Android' },
      { body: 'The desktop app on Windows.', title: 'Windows' },
      { body: 'The desktop app on Linux.', title: 'Linux' },
    ],
    title: 'More platforms',
  },
];

const aiPoints = [
  {
    body: 'The place and the people come along: “at Nobu, invite jane@example.com” becomes a location and a guest.',
    title: 'One sentence, the whole event',
  },
  {
    body: 'Say what to change and it changes: “remind me 30 minutes before”, “make it 8”, “move it to Friday”.',
    title: 'Follow up in plain words',
  },
  {
    body: 'Paste an email on the Mac or share a screenshot on the iPhone, and the events in it become drafts you review.',
    title: 'From an email or a screenshot',
  },
];

const privacyPoints = [
  {
    body: 'Events, tasks and contacts are cached on the device so the app works offline. Sign-in tokens are protected by the system keychain.',
    title: 'Local first',
  },
  {
    body: 'The Mac window stays out of screen sharing and recordings unless you turn that off in Settings.',
    title: 'Hidden from screen shares',
  },
  {
    body: "Quick add, find a time, dictation and capture run on Apple's on-device models. Nothing is uploaded for them unless you point the Mac at a model server you choose.",
    title: 'AI on the device',
  },
];

export function HomePage() {
  return (
    <>
      <section
        className={`${container} flex flex-wrap items-center gap-x-16 gap-y-12 pt-16 pb-20 sm:pt-20`}
      >
        {/* Beside the screenshots once both fit (from about 1070 px wide), above them below that. */}
        <div className="flex max-w-[760px] min-w-0 flex-[1_1_380px] flex-col gap-6">
          <h1 className="m-0 text-[clamp(40px,4vw,52px)] leading-[1.04] font-semibold tracking-[-0.03em] text-balance">
            A modern calendar with AI built in.
          </h1>
          <p className="m-0 max-w-[640px] text-lg text-ink-secondary text-pretty">
            Describe an event the way you’d say it, place and people included, and it’s on your
            calendar. Google and Apple calendars, tasks and reminders in one app, on Mac and iPhone.
          </p>
          <DownloadActions />
          <Sources />
        </div>
        <div className="min-w-0 flex-[1.6_1_560px]">
          <HeroShots />
        </div>
      </section>

      <section className="border-y border-hairline bg-surface-subtle" id="ai">
        <div className={`${container} flex flex-wrap items-center gap-x-20 gap-y-12 py-24`}>
          <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-6">
            <p className={eyebrow}>On-device AI</p>
            <h2 className={`${h2} text-balance`}>Say it once. It’s on the calendar.</h2>
            <p className={lead}>
              Type or dictate a sentence and Solunivo turns it into an event with the time, the
              place and the guests. Every word is read by a model on your device, so nothing you
              type leaves it.
            </p>
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {aiPoints.map((point) => (
                <li className="flex flex-col gap-0.5" key={point.title}>
                  <strong className="font-semibold">{point.title}</strong>
                  <span className="text-[15px] text-ink-secondary">{point.body}</span>
                </li>
              ))}
            </ul>
            <p className="m-0 text-sm text-ink-secondary">
              On the device by default. On the Mac you can point the AI at a model server of your
              own instead.
            </p>
          </div>
          <div className="flex min-w-0 flex-[1_1_380px] justify-center">
            <AiDemo />
          </div>
        </div>
      </section>

      <section className={`${container} flex flex-col gap-10 py-24`} id="features">
        <div className="flex max-w-[640px] flex-col gap-3">
          <h2 className={h2}>The parts other calendars leave out.</h2>
          <p className={lead}>
            Day, week and month, drag to move, repeats and alerts: all there. These are the parts
            you don’t get elsewhere.
          </p>
        </div>
        <ul className="features m-0 grid list-none gap-4 p-0">
          {features.map((feature) => (
            <li
              className="flex flex-col gap-3 rounded-popover border border-hairline bg-surface p-6"
              key={feature.title}
            >
              <feature.icon className="text-ink" />
              <h3 className="m-0 text-lg font-semibold">{feature.title}</h3>
              <p className="m-0 text-[15px] text-ink-secondary">{feature.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="border-y border-hairline bg-surface-subtle" id="privacy">
        <div className={`${container} flex flex-col gap-10 py-24`}>
          <div className="flex max-w-[640px] flex-col gap-3">
            <h2 className={h2}>Your data goes to Google and Apple. Not to us.</h2>
            <p className={lead}>
              Solunivo has no server. It signs in from your device, caches what it needs locally,
              and writes your changes back to your own accounts.
            </p>
          </div>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-x-10 gap-y-8 p-0">
            {privacyPoints.map((point) => (
              <li className="flex flex-col gap-2 border-t-2 border-primary pt-4" key={point.title}>
                <strong className="font-semibold">{point.title}</strong>
                <span className="text-[15px] text-ink-secondary">{point.body}</span>
              </li>
            ))}
          </ul>
          <a
            className="self-start font-medium underline decoration-hairline-strong underline-offset-[3px] hover:decoration-ink"
            href="/privacy"
          >
            Read the privacy policy
          </a>
        </div>
      </section>

      <section className={`${container} flex flex-col gap-10 py-24`} id="roadmap">
        <div className="flex max-w-[640px] flex-col gap-3">
          <h2 className={h2}>On the roadmap.</h2>
          <p className={lead}>Planned, in no particular order and without dates.</p>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-10">
          {roadmap.map((group) => (
            <div className="flex flex-col gap-4" key={group.title}>
              <h3 className="m-0 text-lg font-semibold">{group.title}</h3>
              <ul className="m-0 flex list-none flex-col gap-4 p-0">
                {group.items.map((item) => (
                  <li
                    className="flex flex-col gap-1 border-t border-dashed border-hairline-strong pt-4"
                    key={item.title}
                  >
                    <strong className="font-semibold">{item.title}</strong>
                    <span className="text-[15px] text-ink-secondary">{item.body}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="m-0 text-sm text-ink-secondary">
          On a new platform, the AI features depend on the on-device models it offers.
        </p>
      </section>

      <section className="bg-primary text-on-primary" id="download">
        <div className={`${container} flex flex-wrap items-center justify-between gap-8 py-20`}>
          <div className="flex min-w-0 flex-col gap-2.5">
            {/* The band inverts with the scheme, so its lockup swaps the other way. */}
            <ThemePicture
              alt=""
              className="block h-9 w-auto self-start"
              dark={lockupLight}
              height={36}
              light={lockupDark}
              loading="lazy"
              width={161}
            />
            <h2 className="m-0 text-[clamp(26px,2.8vw,34px)] leading-[1.15] font-semibold tracking-[-0.02em]">
              Get Solunivo for macOS and iPhone
            </h2>
            <p className="m-0 text-on-primary/70">
              The AI features need Apple Intelligence, or a model server of your own on the Mac.
              Everything else works without them.
            </p>
          </div>
          {releases.mac || releases.iphone ? (
            <DownloadActions tone="inverted" />
          ) : (
            <p className="m-0 max-w-[360px] rounded-control border border-on-primary/40 px-5 py-3 text-on-primary">
              Solunivo is in private testing on macOS and iPhone. Public downloads will be here.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
