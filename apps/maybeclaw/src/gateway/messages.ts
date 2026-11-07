import { randomUUID } from "node:crypto";
import { channelTextPages } from "@sortedyuan/gateway/delivery";
import type { GatewayRepository } from "../gateway-repository.js";
import type { GatewayStore } from "../gateway-store.js";
import {
  digest,
  type GatewayDelivery,
  type GatewayMessage,
  type GatewaySession,
  type GatewayTask,
} from "../gateway-types.js";

export function recordGatewayMessage(
  store: GatewayStore,
  repository: GatewayRepository,
  session: GatewaySession,
  data: Omit<GatewayMessage, "id" | "sessionId" | "seq" | "createdAt">,
  deliver: boolean,
  changed: () => void,
): GatewayMessage {
  return store.transaction(() => {
    const current = store.get<GatewaySession>("sessions", session.id);
    if (!current) throw new Error("会话已被删除。");
    session = current;
    const seq = (store.get<{ seq: number }>("sequences", session.id)?.seq ?? 0) + 1;
    const message: GatewayMessage = { ...data, id: randomUUID(), sessionId: session.id, seq, createdAt: Date.now() };
    store.put("sequences", session.id, { seq });
    store.put("messages", message.id, message);
    if (session.entry && deliver) {
      const title = `${session.name} · ${data.agentId ?? (data.actor?.kind === "operator" ? "服务管理员" : "MaybeClaw")}`;
      const unsupported = [
        ...new Set(
          (data.content ?? [])
            .filter((part) => ["audio", "file", "resource"].includes(part.type))
            .map((part) => part.type),
        ),
      ];
      const body = unsupported.length
        ? `${data.text}\n\n当前渠道无法发送以下附件类型：${unsupported.join("、")}。完整内容已保存在会话历史中。`
        : data.text;
      const pages = channelTextPages(body, 3000);
      const task = data.taskId ? store.get<GatewayTask>("tasks", data.taskId) : undefined;
      const graph = task ? store.get<{ messageId: string }>("graphs", task.graphId) : undefined;
      const original = graph ? store.get<GatewayMessage>("messages", graph.messageId) : undefined;
      let after: string | undefined;
      for (const [index, page] of pages.entries()) {
        const id = digest({ message: message.id, part: index });
        const delivery: GatewayDelivery = {
          id,
          sessionId: session.id,
          messageId: message.id,
          entry: session.entry,
          text: `${title}\n${page}`,
          status: "pending",
          ...(after ? { after } : {}),
          ...(original?.sourceMessageId ? { replyTo: original.sourceMessageId } : {}),
        };
        repository.enqueueDelivery(delivery);
        after = id;
      }
      for (const [index, part] of (data.content ?? []).entries())
        if (part.type === "image") {
          const id = digest({ message: message.id, image: index });
          repository.enqueueDelivery({
            id,
            sessionId: session.id,
            messageId: message.id,
            entry: session.entry,
            text: title,
            image: part,
            status: "pending",
            ...(after ? { after } : {}),
            ...(original?.sourceMessageId ? { replyTo: original.sourceMessageId } : {}),
          });
          after = id;
        }
    }
    store.put("sessions", session.id, { ...session, updatedAt: message.createdAt });
    changed();
    return message;
  });
}
