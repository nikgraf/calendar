import { ACKNOWLEDGEMENTS, LICENCES } from './acknowledgements.ts';
import { LICENCE_TEXTS } from './licenceTexts.ts';

/**
 * THIRD_PARTY_NOTICES.md as `scripts/third-party-notices.ts` writes it: each
 * acknowledgement with its creator, what was changed and its copyright
 * line, then every licence's text once.
 */
export const thirdPartyNotices = (): string => {
  const used = [...new Set(ACKNOWLEDGEMENTS.map((entry) => entry.licence))].sort();
  const entries = ACKNOWLEDGEMENTS.map((entry) =>
    [
      `## ${entry.name}`,
      '',
      `By ${entry.by}. ${entry.what} <${entry.url}>`,
      ...(entry.changes === undefined ? [] : ['', `Changes: ${entry.changes}`]),
      ...(entry.copyright === undefined ? [] : ['', entry.copyright]),
      '',
      `Licence: ${LICENCES[entry.licence].name} (${entry.licence}), <${LICENCES[entry.licence].url}>`,
    ].join('\n'),
  );
  const texts = used.map((id) =>
    [`## ${LICENCES[id].name} (${id})`, '', '```text', LICENCE_TEXTS[id], '```'].join('\n'),
  );
  return [
    '# Third-party notices',
    '',
    'Solunivo ships or downloads the models, libraries and typeface below. Each is',
    'listed with who made it, what was changed and its licence; the licence texts',
    'follow. Written by `node scripts/third-party-notices.ts` from',
    '`packages/core/src/acknowledgements.ts`, which the apps show too (iOS:',
    'Settings › Acknowledgements; Mac: Solunivo › About Solunivo).',
    '',
    ...entries.flatMap((entry) => [entry, '']),
    '# Licence texts',
    '',
    ...texts.flatMap((text) => [text, '']),
  ].join('\n');
};
