import { GatewayStore } from "../../dist/gateway-store.js";

process.on("message", (message) => {
  if (message !== "open") return;
  try {
    const store = GatewayStore.open(process.argv[2]);
    store.put("sessions", "saved", { text: "persisted" });
    process.send({ opened: true });
  } catch (error) {
    process.send({ opened: false, error: error.message });
  }
});
process.send({ ready: true });
