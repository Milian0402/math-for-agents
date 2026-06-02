import { createServer } from "./http.js";
import { assertWebRuntimeConfig } from "./config.js";

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

assertWebRuntimeConfig();

const server = createServer();

server.listen(port, host, () => {
  console.log(`math-for-agents listening on http://${host}:${port}`);
});
