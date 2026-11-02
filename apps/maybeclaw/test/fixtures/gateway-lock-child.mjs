import { openSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { GatewayStore } from "../../dist/gateway-store.js";

process.on("message", message => {
  if (message !== "open") return;
  try {
    if (process.argv[3] === "legacy") {
      const file = openSync(join(process.argv[2], "host.lock"), "wx");
      writeFileSync(file, JSON.stringify({ pid: process.pid, hostname: hostname() }));
    } else {
      const store = GatewayStore.open(process.argv[2]);
      store.put("sessions", "saved", { text: "persisted" });
    }
    process.send({ opened: true });
  } catch (error) { process.send({ opened: false, error: error.message }); }
});
process.send({ ready: true });
