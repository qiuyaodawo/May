import { defineService } from "@sortedyuan/may/plugin";
import type { ChannelIngress } from "@sortedyuan/gateway/delivery";
import type { WebApiHandler } from "@sortedyuan/gateway/web-api";
import type { GatewayHost } from "../gateway-host.js";

export const gatewayPluginServices = {
  ingress: defineService<ChannelIngress>({ id: "maybeclaw.channel-ingress", version: "1.0.0", scope: "host" }),
  host: defineService<GatewayHost>({ id: "maybeclaw.gateway-host", version: "1.0.0", scope: "host" }),
  webHandler: defineService<WebApiHandler>({ id: "maybeclaw.web-handler", version: "1.0.0", scope: "host" }),
};
