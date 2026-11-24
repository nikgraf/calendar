// Writes THIRD_PARTY_NOTICES.md at the repository's root from the
// acknowledgements both apps show (packages/core/src/acknowledgements.ts)
// and their licence texts (licenceTexts.ts). Run after changing either:
//   node scripts/third-party-notices.ts
// scripts/thirdPartyNotices.test.ts fails while the file differs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { thirdPartyNotices } from '../packages/core/src/thirdPartyNotices.ts';

writeFileSync(join(import.meta.dirname, '..', 'THIRD_PARTY_NOTICES.md'), thirdPartyNotices());
