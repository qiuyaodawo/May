/**
 * A failure-tolerant FIFO serializer for application state transitions.
 *
 * A rejected operation rejects its caller but never poisons later operations.
 */
export class AsyncStateSerializer {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new Error("State serializer is closed"));
    }
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Stop accepting work and wait for all already accepted operations. */
  async close(): Promise<void> {
    this.accepting = false;
    await this.tail;
  }

  /** Wait for accepted operations without preventing future work. */
  idle(): Promise<void> {
    return this.tail;
  }
}
