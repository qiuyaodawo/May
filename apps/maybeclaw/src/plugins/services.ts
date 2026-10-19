import { defineService } from "@sortedyuan/plugin";
import type { ChannelIngress } from "@sortedyuan/plugin-delivery";
import type { WebApiHandler } from "@sortedyuan/plugin-web-api";
import type { GatewayHost } from "../gateway-host.js";

export const gatewayPluginServices = {
  ingress: defineService<ChannelIngress>({ id: "maybeclaw.channel-ingress", version: "1.0.0", scope: "host" }),
  host: defineService<GatewayHost>({ id: "maybeclaw.gateway-host", version: "1.0.0", scope: "host" }),
  webHandler: defineService<WebApiHandler>({ id: "maybeclaw.web-handler", version: "1.0.0", scope: "host" }),
};
