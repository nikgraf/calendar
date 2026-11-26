# Privacy Policy

_Last updated: 2026-11-26_

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
  are never in that database: on iOS they are stored in the Keychain, and
  on the Mac they are encrypted with a key kept in the macOS Keychain.
- **Goes to Google** as the changes you make: a new or edited event
  or task is written back to your own Google account. If you pick a place
  for an event's location, its coordinates are saved in that event's
  private fields in your Google Calendar so your other devices can show
  the map. If you open Google Maps directions, the event's address or
  coordinates are passed to Google Maps, including for events from Apple
  Calendar.
- **Goes to Apple** only when you use a feature that needs it: place
  search and maps use Apple Maps, and changes to Apple Calendar or
  Reminders items are saved through the system's own calendar and
  reminders stores, which sync them with the account that holds them
  (iCloud, or an Outlook, Exchange or CalDAV account you added there).
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
- **Stays on your device, too:** the Assistant reads what you type or say
  with a model of its own that runs on your iPhone or Mac, and find a time
  reads its sentence with it too; for search sentences, dictation, reading
  events out of a pasted text or a shared screenshot, and find a time until
  the Assistant's model is downloaded, the app uses Apple's on-device
  models and text recognition by default. Dictation also reads each phrase
  with Parakeet, a speech model that runs on your device, once you
  downloaded it; it listens for the names of the people and places in your
  calendar and contacts, which it reads there and never sends anywhere.
  Your voice and images never leave the device for this, and the text is
  sent only to a model server you choose on the Mac (next point).
- **Assistant sessions stay on your device, if you keep them.** Off
  unless you switch on Keep Assistant Sessions (iOS: Settings ›
  Advanced › Diagnostics; Mac: Settings › AI Model). Then the app keeps
  your last 200 conversations with the Assistant in a file on the
  device: what you typed or dictated as the speech recognisers read it,
  what the model was shown (the item as it stood, its guests' addresses
  and short notes included) and what it answered, the places and
  contacts it found, and what you saved, changed by hand or left, with
  the app's and the model's version. No audio. The file goes nowhere
  unless you export it, and it holds the names, addresses and places in
  it; Delete All removes it.
- **The Assistant's model is downloaded once.** The app asks before it
  downloads it (about 800 MB; on the iPhone over Wi-Fi unless you allow
  mobile data) from GitHub, which sees the request for the file, not your
  data. Nothing you say is sent anywhere to use it.
- **Parakeet is downloaded once, if you want it.** The app asks before it
  downloads it (about 700 MB; on the iPhone over Wi-Fi unless you allow
  mobile data) from Hugging Face, which sees the requests for the files,
  not your data. Settings › Dictation switches it off or deletes it.
- **Goes to a model server you choose (Mac only).** Under Settings → AI
  Model you can pick Ollama or any OpenAI-compatible server instead of
  Apple's models for search and capture, and for find a time until the
  Assistant's model is downloaded. That server then receives what those
  features work on: the sentence you type, the text read from a paste or
  a screenshot, today's date and your time zone, and, for a search, the
  names of your calendars and lists. It is off your Mac only if you point
  it there. The Assistant never uses it. Dictation and text recognition
  themselves stay on the device either way.
- **Goes where you send it.** Settings can be exported as a file, and the
  Mac can keep a settings file in your home folder. That file lists your
  connected accounts' email addresses and calendar names, never passwords
  or sign-in tokens.

We do not run analytics, crash reporting or advertising, and we do not
sell, share or transfer your data to anyone. We have no servers that
could receive it. App updates for iOS are downloaded from Expo's update
service, the Assistant's model from GitHub and Parakeet from Hugging
Face; each sees only the request for the file, not your data.

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
