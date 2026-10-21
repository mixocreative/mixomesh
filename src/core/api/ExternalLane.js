// ExternalLane: ONE serial lane for work that arrives from outside the window, shared by
// launch batches (LaunchRequests) and automation requests (ApiDispatcher). A launch batch
// parked in its unsaved-changes dialog holds the lane, so an API import cannot report
// success into a scene the user is about to replace (cia F-06).

/** @returns {{ run: <T>(task: () => Promise<T>) => Promise<T> }} */
export function createExternalLane() {
  let tail = Promise.resolve();
  return {
    run(task) {
      const p = tail.then(task, task);
      tail = p.then(() => undefined, () => undefined);
      return p;
    },
  };
}

/** The app's lane: the real LaunchRequests and automation dispatcher both use it. */
export const externalLane = createExternalLane();
