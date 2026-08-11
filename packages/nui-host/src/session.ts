import { resetNodeLifecycle } from "./lifecycle";
import { resetSessionV1, runV1 } from "./protocol";
import { resetWindowTitle } from "./title";
import { NexaHostError } from "./errors";

/** Close the current JS/native owner scope and start an empty Host session. */
export function resetSession(): void {
  let cleanupError: unknown;
  try {
    resetNodeLifecycle();
  } catch (error) {
    cleanupError = error;
  }

  const result = resetSessionV1();
  resetWindowTitle();
  if (!result.ok) {
    throw new NexaHostError(result.error);
  }
  if (cleanupError !== undefined) throw cleanupError;
}

/** Run the current owner and preserve structured native errors. */
export function run(title: string): void {
  try {
    const result = runV1(title);
    if (!result.ok) {
      throw new NexaHostError(result.error);
    }
  } finally {
    resetNodeLifecycle();
    resetWindowTitle();
  }
}
