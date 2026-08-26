import { SpecialistTimeoutError } from "./errors";

export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = work(controller.signal);
  void running.catch(() => undefined);
  try {
    return await Promise.race([
      running,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new SpecialistTimeoutError(`specialist exceeded ${deadlineMs}ms`));
        }, deadlineMs);
      }),
    ]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new SpecialistTimeoutError(`specialist exceeded ${deadlineMs}ms`);
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
