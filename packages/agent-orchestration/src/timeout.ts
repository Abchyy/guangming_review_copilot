import { SpecialistTimeoutError } from "./errors";

export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  if (parent?.aborted || deadlineMs <= 0) {
    abort();
  } else {
    parent?.addEventListener("abort", abort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!controller.signal.aborted) {
    timer = setTimeout(abort, deadlineMs);
  }
  try {
    if (controller.signal.aborted) {
      throw new SpecialistTimeoutError(`specialist exceeded ${deadlineMs}ms`);
    }
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw error instanceof SpecialistTimeoutError
        ? error
        : new SpecialistTimeoutError(`specialist exceeded ${deadlineMs}ms`);
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    parent?.removeEventListener("abort", abort);
  }
}
