import { createServer } from "./http.js";

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const server = createServer();

server.listen(port, host, () => {
  console.log(`math-for-agents listening on http://${host}:${port}`);
});
