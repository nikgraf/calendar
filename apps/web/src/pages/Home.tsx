import lockupDark from '../../../../brand/logos/lockup-horizontal-dark.svg';
import { ButtonLink } from '../components/Button.tsx';
import {
  BellIcon,
  CalendarIcon,
  CheckCircleIcon,
  GlobeIcon,
  PeopleIcon,
  RepeatIcon,
} from '../components/icons.tsx';
import { Sources } from '../components/Sources.tsx';
import { links, releases } from '../links.ts';
import { EditorPanel } from '../mockups/EditorPanel.tsx';
import { MacWindow } from '../mockups/MacWindow.tsx';
import { PhoneDay } from '../mockups/PhoneDay.tsx';

const container = 'mx-auto max-w-[1200px] px-6 sm:px-8';
const h2 = 'm-0 text-[clamp(30px,3.2vw,40px)] leading-[1.15] font-semibold tracking-[-0.02em]';
const eyebrow = 'm-0 text-[13px] font-medium tracking-[0.08em] text-ink-secondary uppercase';
const lead = 'm-0 text-[17px] text-ink-secondary text-pretty';

const features = [
  {
    body: 'Plus 2 Days and an Agenda on the iPhone. Drag to move or resize; the event follows your finger or pointer one to one.',
    icon: CalendarIcon,
    title: 'Day, Week, Month',
  },
  {
    body: 'Google Tasks and Apple Reminders in the task lane and on the Tasks tab. Convert a task to an event or back; move either between accounts.',
    icon: CheckCircleIcon,
    title: 'Tasks beside events',
  },
  {
    body: 'Stacked in the gutter with the city on top. Pick a primary zone and it stands in for the device zone while you travel.',
    icon: GlobeIcon,
    title: 'Up to three time zones',
  },
  {
    body: 'This event, this and following, or the whole series. Weekday sets and monthly ordinals, with an end date or count.',
    icon: RepeatIcon,
    title: 'Recurring, edited properly',
  },
  {
    body: 'Invite from your address book and Google contacts. Birthdays appear as chips with a reminder you set per person.',
    icon: PeopleIcon,
    title: 'People and birthdays',
  },
  {
    body: "Local notifications for events and birthdays. Search by date, kind and people. Changes queue offline and sync when you're back.",
    icon: BellIcon,
    title: 'Alerts, search, offline',
  },
];

const iphonePoints = [
  { body: 'Share a screenshot; the events in it become drafts.', title: 'Share sheet capture' },
  { body: 'Alerts stay right even when the app is closed.', title: 'Background refresh' },
  { body: 'Lists next to Google Tasks, each with its own form.', title: 'Apple Reminders' },
  { body: 'Guests and birthdays from your address book.', title: 'Contacts on this iPhone' },
];

const aiChips = ['Quick add', 'Find a time', 'Dictation', 'Paste an email', 'Share a screenshot'];

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
      <section className={`${container} flex flex-wrap items-center gap-12 pt-16 pb-16 sm:pt-20`}>
        <div className="flex min-w-0 flex-[1_1_400px] flex-col gap-6">
          <h1 className="m-0 text-[clamp(36px,3.4vw,48px)] leading-[1.05] font-semibold tracking-[-0.025em] text-pretty">
            Google and Apple calendars, tasks and reminders. One app.
          </h1>
          <p className="m-0 text-lg text-ink-secondary text-pretty">
            Solunivo puts Google Calendar, Google Tasks, Apple Calendar and Apple Reminders on one
            grid, on your Mac and your iPhone. No server in between.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <ButtonLink href={links.mac}>Download for Mac</ButtonLink>
            <ButtonLink href={links.iphone} variant="outline">
              Get it for iPhone
            </ButtonLink>
          </div>
          <Sources />
        </div>
        <div className="min-w-0 flex-[1_1_644px]">
          <MacWindow />
        </div>
      </section>

      <section className="border-y border-hairline bg-surface-subtle" id="features">
        <div className={`${container} flex flex-col gap-10 py-24`}>
          <div className="flex max-w-[640px] flex-col gap-3">
            <h2 className={h2}>A full calendar, not a viewer.</h2>
            <p className={lead}>
              Everything you’d do in Google Calendar or Apple Calendar, in one place, with the parts
              they each leave out.
            </p>
          </div>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4 p-0">
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
        </div>
      </section>

      <section
        className={`${container} flex flex-wrap items-center gap-x-20 gap-y-12 py-24`}
        id="iphone"
      >
        <div className="flex flex-[0_1_300px] justify-center">
          <PhoneDay />
        </div>
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-6">
          <p className={eyebrow}>iPhone</p>
          <h2 className={`${h2} text-balance`}>
            The same calendar in your pocket, your settings copied over with one scan.
          </h2>
          <p className={lead}>
            Day, 2 Days, Week, Month and Agenda. Swipe between days, drag with a long press, dictate
            an event hands-free. Open Settings on the Mac, show the code, scan it on the iPhone:
            your preferences come across and each account is ready for one sign-in, without a cloud
            in between.
          </p>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-x-6 gap-y-4 p-0 text-[15px] text-ink-secondary">
            {iphonePoints.map((point) => (
              <li className="flex flex-col gap-0.5" key={point.title}>
                <strong className="font-semibold text-ink">{point.title}</strong>
                {point.body}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-y border-hairline bg-surface-subtle" id="ai">
        <div className={`${container} flex flex-wrap items-center gap-x-20 gap-y-12 py-24`}>
          <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-6">
            <p className={eyebrow}>On-device AI</p>
            <h2 className={`${h2} text-balance`}>Describe it. Check it. Add it.</h2>
            <p className={lead}>
              Write “Lunch with Sarah tomorrow at 1” and the form fills in. Ask for “an hour next
              week with Jonas” and get free slots. Paste an email or share a screenshot and the
              events in it become drafts. Everything runs on Apple’s on-device models by default, so
              nothing you type, say or share leaves the device; on the Mac you can choose a model
              server of your own instead.
            </p>
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0 text-sm font-medium">
              {aiChips.map((chip) => (
                <li className="rounded-full border border-hairline bg-surface px-3 py-2" key={chip}>
                  {chip}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex min-w-0 flex-[0_1_360px] justify-center">
            <EditorPanel />
          </div>
        </div>
      </section>

      <section className={`${container} flex flex-col gap-10 py-24`} id="privacy">
        <div className="flex max-w-[640px] flex-col gap-3">
          <h2 className={h2}>Your data goes to Google and Apple. Not to us.</h2>
          <p className={lead}>
            Solunivo has no server. It signs in from your device, caches what it needs locally, and
            writes your changes back to your own accounts.
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
          href={links.privacy}
        >
          Read the privacy policy
        </a>
      </section>

      <section className="bg-primary text-on-primary" id="download">
        <div className={`${container} flex flex-wrap items-center justify-between gap-8 py-20`}>
          <div className="flex min-w-0 flex-col gap-2.5">
            {/* Lazy: React preloads every eager <img>, and this one sits at the page's foot. */}
            <img
              alt=""
              className="block h-9 w-auto self-start"
              height="36"
              loading="lazy"
              src={lockupDark}
            />
            <h2 className="m-0 text-[clamp(26px,2.8vw,34px)] leading-[1.15] font-semibold tracking-[-0.02em]">
              Get Solunivo for Mac and iPhone
            </h2>
            <p className="m-0 text-on-primary/70">
              The AI features need Apple Intelligence, or a model server of your own on the Mac.
              Everything else works without them.
            </p>
          </div>
          {releases.mac || releases.iphone ? (
            <div className="flex flex-wrap gap-3">
              {releases.mac ? (
                <ButtonLink href={releases.mac} variant="inverted">
                  Download for Mac
                </ButtonLink>
              ) : null}
              {releases.iphone ? (
                <ButtonLink href={releases.iphone} variant="invertedOutline">
                  Get it for iPhone
                </ButtonLink>
              ) : null}
            </div>
          ) : (
            <p className="m-0 max-w-[360px] rounded-control border border-on-primary/40 px-5 py-3 text-on-primary">
              Solunivo is in private testing on Mac and iPhone. Public downloads will be here.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
