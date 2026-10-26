// Work that must not run twice at once for the same thing - two test builds
// by one student on one subject, or two starts of the same test (which could
// otherwise both find no open attempt and open two). Requests with the same
// key run one after the other; different keys run side by side.
//
// In memory, per server process: enough for the one instance this app runs
// on. With more than one instance, the same rule would need a lock in the
// database (docs/SECURITY_AUDIT.md).
const chains = new Map();

export function oneAtATime(key, work) {
  const before = chains.get(key) || Promise.resolve();
  const run = before.catch(() => {}).then(work);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
