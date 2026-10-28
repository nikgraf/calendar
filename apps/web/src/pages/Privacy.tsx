import privacyHtml from '../../../../PRIVACY.md';

/** PRIVACY.md from the repo root, rendered at build time. */
export function PrivacyPage() {
  return (
    <article
      className="prose mx-auto max-w-[760px] px-6 py-16 sm:px-8 sm:py-20"
      dangerouslySetInnerHTML={{ __html: privacyHtml }}
    />
  );
}
