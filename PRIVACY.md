# Privacy Policy

_Last updated: 2026-10-10_

Solunivo is a calendar and task app for macOS and iOS. It has no server
of its own: the app talks directly from your device to Google and Apple,
and nothing you do in it is sent to us.

## What the app accesses

When you connect a Google account, Solunivo asks for access to:

- **Google Calendar** — your calendar list and events, to show, create,
  edit, move and delete them, and to create a calendar when you set up a
  calendar mirror (below).
- **Google Tasks** — your task lists and tasks, to show and edit them.
- **Google Contacts** (read-only) — names, email addresses and birthdays
  of your contacts and "other contacts", to suggest guests when you
  invite someone and to show birthdays.
- **Your Google profile** (name, email address, picture) — to label the
  connected account.

On your device, and only when you allow it, Solunivo can also use Apple
Calendar, Apple Reminders and your address book, for the same purposes.

## Where your data goes

- **Stays on your device.** Events, tasks and contacts are cached in a
  local database on your device so the app works offline. Sign-in tokens
  are stored in the system keychain (macOS Keychain / iOS Keychain), never
  in that database.
- **Goes to Google** only as the changes you make: a new or edited event
  or task is written back to your own Google account. If you pick a place
  for an event's location, its coordinates are saved in that event's
  private fields in your Google Calendar so your other devices can show
  the map.
- **Goes to Apple** only when you use a feature that needs it: place
  search and maps use Apple Maps, and changes to Apple Calendar or
  Reminders items are saved through the system's own calendar and
  reminders stores.
- **Goes to other software on your Mac** only if you set it up: under
  Settings → Agents you can let an AI agent running on the same Mac read
  or change your calendars and tasks through Solunivo. Nothing is shared
  until you create an agent, and each agent only gets the calendars and
  lists you grant it. What an agent does with what it reads is up to that
  agent and its provider.
- **Goes where you point a calendar mirror.** Under Settings → Mirrors
  you can have events from your calendars and lists copied into one
  calendar you share, reduced to what you choose (just "Busy", or the
  title and place). Those copies are written into your own Google
  calendar or Apple calendar by the app on your device, and Google data
  can end up in an Apple calendar this way, or the other way round. The
  copies carry an opaque marker so the app can find them again; it names
  nothing about the original.
- **Stays on your device, too:** quick-add parsing, find-a-time
  suggestions, dictation, and reading events out of a pasted text or a
  shared screenshot use Apple's on-device models and text recognition;
  your text, voice and images are not sent anywhere for this.
- **Goes where you send it.** Settings can be exported as a file, and the
  Mac can keep a settings file in your home folder. That file lists your
  connected accounts' email addresses and calendar names, never passwords
  or sign-in tokens.

We do not run analytics, crash reporting or advertising, and we do not
sell, share or transfer your data to anyone. We have no servers that
could receive it. App updates for iOS are downloaded from Expo's update
service, which sees only the request for the update, not your data.

## Google API data

Solunivo's use and transfer of information received from Google APIs
adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. Google data is used only to
provide the calendar, task and contact features described above.

## Removing your data

Disconnecting an account in the app's settings deletes its cached data
and tokens from the device. Deleting the app removes everything it
stored. You can also revoke Solunivo's access to your Google account at
any time at <https://myaccount.google.com/permissions>.

## Contact

Questions: naisho.calendar.dev@gmail.com
