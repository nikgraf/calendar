/**
 * Public download links, empty while both apps are in private testing
 * (TestFlight and CI artifacts, see docs/distribution.md). Until one is
 * set, its calls to action lead to the download section, which says the
 * apps are in private testing instead of offering a button.
 */
export const releases: { readonly iphone?: string; readonly mac?: string } = {};

export const links = {
  download: '/#download',
  iphone: releases.iphone ?? '/#download',
  mac: releases.mac ?? '/#download',
  privacy: '/privacy',
} as const;
