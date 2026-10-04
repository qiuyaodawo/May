process.send({ type: "started", pid: process.pid });
setTimeout(() => process.exit(0), 120_000);
