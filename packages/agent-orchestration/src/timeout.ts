import { SpecialistTimeoutError } from "./errors";

function swallowLater(work: Promise<unknown>): void {
  void work.then(
    () => undefined,
    () => undefined,
  );
}

export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  parent?: AbortSignal,
): Promise<T> {
  if (parent?.aborted || deadlineMs <= 0) {
    throw new SpecialistTimeoutError(`specialist exceeded ${deadlineMs}ms`);
  }
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, deadlineMs);
  const running = work(controller.signal);
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (apply: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        apply();
      };
      const onAbort = () => {
        swallowLater(running);
        finish(() => reject(new SpecialistTimeoutError(`specialist exceeded ${deadlineMs}ms`)));
      };
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });
      running.then(
        (value) => finish(() => resolve(value)),
        (error) =>
          finish(() => {
            if (controller.signal.aborted) {
              reject(new SpecialistTimeoutError(`specialist exceeded ${deadlineMs}ms`));
              return;
            }
            reject(error);
          }),
      );
    });
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}
