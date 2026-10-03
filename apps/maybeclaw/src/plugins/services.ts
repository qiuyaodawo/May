import { defineService } from "@may/plugin";
import type { ChannelIngress } from "@may/plugin-delivery";
import type { WebApiHandler } from "@may/plugin-web-api";
import type { GatewayHost } from "../gateway-host.js";

export const gatewayPluginServices = {
  ingress: defineService<ChannelIngress>({ id: "maybeclaw.channel-ingress", version: "1.0.0", scope: "host" }),
  host: defineService<GatewayHost>({ id: "maybeclaw.gateway-host", version: "1.0.0", scope: "host" }),
  webHandler: defineService<WebApiHandler>({ id: "maybeclaw.web-handler", version: "1.0.0", scope: "host" }),
};
