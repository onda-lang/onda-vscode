const { spawn } = require("node:child_process");
const net = require("node:net");

const port = Number(process.argv[2]);
if (process.argv[3] === "--child") {
  process.on("SIGTERM", () => {});
  const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
    socket.write(`${process.pid}\n`);
  });
  socket.on("error", () => process.exit(1));
} else {
  // The descendant keeps no launcher pipes open: stdio closure does not mean
  // the process group has exited.
  spawn(process.execPath, [__filename, String(port), "--child"], { stdio: "ignore" });
}
