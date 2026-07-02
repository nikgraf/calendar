// Hermes ships a minimal Intl whose resolvedOptions() lacks `calendar` and
// `numberingSystem`. @js-temporal/polyfill caches resolvedOptions().calendar in
// an internal slot and throws "Missing internal slot calendar-id" when it is
// undefined. Patch resolvedOptions to fill in the spec defaults; on complete
// Intl implementations (Node, Chromium) this is a no-op.
const probe = new Intl.DateTimeFormat().resolvedOptions();

if (!probe.calendar || !probe.numberingSystem) {
  const original = Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions = function resolvedOptions() {
    const resolved = original.call(this);
    resolved.calendar ??= 'gregory';
    resolved.numberingSystem ??= 'latn';
    return resolved;
  };
}
