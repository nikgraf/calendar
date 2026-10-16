import type { ModelAvailability } from '@calendar/ai';

/**
 * What the quick-add notice and Diagnostics say about Apple's on-device
 * model — one wording for both, so a screenshot of either names the same
 * cause. Each answer says what the user can do, or that there is nothing
 * to do, and never more than iOS reported: 'not-ready' may be a download,
 * but iOS does not say so.
 */
export const availabilityGuidance = (
  availability: ModelAvailability,
  iosVersion: string,
): string => {
  if (availability.checkError !== undefined) {
    return "Solunivo couldn't find out from iOS whether Apple Intelligence can run. Check again in a moment.";
  }
  switch (availability.status) {
    case 'ready':
      return 'Apple Intelligence is ready: quick add can read phrases.';
    case 'disabled':
      return (
        'Quick add needs Apple Intelligence. Turn it on in Settings → Apple Intelligence & Siri. ' +
        "If it is already on, Siri's language has to match the iPhone's."
      );
    case 'not-ready':
      return (
        "Apple Intelligence is on, but its model isn't ready yet — it may still be downloading or " +
        'preparing, or be briefly unavailable. Quick add appears here once iOS reports it ready.'
      );
    case 'unsupported':
      return availability.nativeReason === 'osTooOld'
        ? `Quick add needs Apple Intelligence, which needs iOS 26 or later. This iPhone runs iOS ${iosVersion}.`
        : availability.nativeReason === 'deviceNotEligible'
          ? "Quick add needs Apple Intelligence, which this iPhone doesn't support."
          : "iOS reports that this iPhone can't run Apple Intelligence, which quick add needs.";
    case 'missing-module':
      return "This build of Solunivo doesn't include Apple Intelligence support, so quick add can't run in it.";
    case 'unavailable':
      return availability.reasonsUnavailable
        ? "iOS reports Apple Intelligence as unavailable, but this build of Solunivo can't read why. A newer build shows the reason."
        : 'iOS reports Apple Intelligence as unavailable without a reason Solunivo recognizes. This is often temporary.';
  }
};

/** "12:06:34 PM": seconds included, so two checks a few seconds apart read as two. */
export const formatCheckTime = (epochMs: number, timeZone?: string): string =>
  new Date(epochMs).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  });

/**
 * The line under Check Again once it answered — there whether or not the
 * answer changed, so a tap is never met with nothing.
 */
export const checkResultLine = (
  check: { readonly at: number; readonly availability: ModelAvailability },
  timeZone?: string,
): string => {
  const time = formatCheckTime(check.at, timeZone);
  if (check.availability.checkError !== undefined) {
    return `Couldn't check availability · ${time}`;
  }
  return check.availability.status === 'ready'
    ? `Available · Checked at ${time}`
    : `Still unavailable · Checked at ${time}`;
};

/** What iOS said about the reason, for the technical details. */
const nativeReasonText = (availability: ModelAvailability): string =>
  availability.nativeReason ??
  (availability.reasonsUnavailable
    ? 'not readable in this build'
    : availability.checkError === undefined
      ? 'none'
      : 'no answer');

/**
 * The technical details, one "Label: value" line each, as selectable text
 * a user can copy into a bug report: the normalized status, the reason as
 * iOS named it, the check's failure when it failed, and when it ran.
 */
export const availabilityDetails = (
  availability: ModelAvailability,
  checkedAt: number | null,
  timeZone?: string,
): string =>
  [
    `Status: ${availability.status}`,
    `Native reason: ${nativeReasonText(availability)}`,
    ...(availability.checkError === undefined ? [] : [`Check error: ${availability.checkError}`]),
    ...(checkedAt === null ? [] : [`Checked at: ${formatCheckTime(checkedAt, timeZone)}`]),
  ].join('\n');
