// Maestro has no sleep, and GraalJS here has no timers: spin for SECONDS
// (default 2). An optional wait for a never-visible element is no
// substitute — it returned after ~0.5 s, not its timeout (a "72 s" wait
// measured 19.8 s on the first local run).
const seconds = Number(typeof SECONDS === 'undefined' ? '2' : SECONDS);
const until = Date.now() + seconds * 1000;
while (Date.now() < until) {
  // spin
}
