/**
 * llama.rn (a model run inside the app, for the measurement page under
 * Settings › Advanced) is linked into the development variant only. The
 * production app has no use for it yet, and without the pod its binary
 * and its native fingerprint stay as they were; the page finds no runtime
 * there and does not show. Same switch as `app.config.js`.
 */
module.exports = {
  dependencies:
    process.env.APP_VARIANT === 'development' ? {} : { 'llama.rn': { platforms: { ios: null } } },
};
