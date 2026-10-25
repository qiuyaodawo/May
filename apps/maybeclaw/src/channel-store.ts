import { access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ChannelStore as DeliveryChannelStore } from "@sortedyuan/plugin-delivery";

export { inboxId, cursorId, validateChannelInput } from "@sortedyuan/plugin-delivery";
export type { ChannelInput, ChannelAttachment, ChannelDeliveryReceipt, InboxRecord, DeliveryRecord, ChannelRecord } from "@sortedyuan/plugin-delivery";
export type ChannelStore = DeliveryChannelStore;
export const ChannelStore = {
  inspect: (path: string) => DeliveryChannelStore.inspect(path),
  async open(path: string): Promise<DeliveryChannelStore> {
    if (basename(path) === "channels.jsonl") {
      for (const marker of ["gateway.format.json", "gateway.sqlite"]) {
        const migrated = await access(join(dirname(path), marker)).then(() => true, error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        });
        if (migrated) throw new Error("Legacy channel storage is read-only after Gateway migration");
      }
    }
    return DeliveryChannelStore.open(path);
  },
};
