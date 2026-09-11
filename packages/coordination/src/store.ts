import type { CoordinationJournal, CoordinationSnapshot, CoordinationStore } from "./types.js";
import { copy, name, validateSnapshot } from "./validation.js";

export class InMemoryCoordinationStore implements CoordinationStore {
  private readonly snapshots = new Map<string, CoordinationSnapshot>();
  private readonly writers = new Set<string>();

  async acquire(id: string): Promise<CoordinationJournal> {
    name(id, "coordination id");
    if (this.writers.has(id)) throw new Error(`Coordination already has a writer: ${id}`);
    this.writers.add(id);
    let closed = false;
    const check = () => { if (closed) throw new Error("Coordination journal is closed"); };
    return {
      read: async () => { check(); const state = this.snapshots.get(id); return state === undefined ? undefined : copy(state); },
      commit: async (snapshot, expectedRevision) => {
        check(); validateSnapshot(snapshot, id);
        if ((this.snapshots.get(id)?.revision ?? 0) !== expectedRevision || snapshot.revision !== expectedRevision + 1) throw new Error("Coordination revision conflict");
        this.snapshots.set(id, copy(snapshot));
      },
      close: async () => { if (!closed) { closed = true; this.writers.delete(id); } },
    };
  }
}
