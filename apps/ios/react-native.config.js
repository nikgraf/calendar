/**
 * llama.rn (a model run inside the app, for the measurement page under
 * Settings › Advanced) is linked into the development variant only. The
 * production app has no use for it yet, and without the pod its binary
 * carries no llama.cpp; the page finds no runtime there, is not listed,
 * and fetches nothing if it is opened by its link. Same switch as
 * `app.config.js`.
 */
module.exports = {
  dependencies:
    process.env.APP_VARIANT === 'development' ? {} : { 'llama.rn': { platforms: { ios: null } } },
};
