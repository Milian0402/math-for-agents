import { assertWebRuntimeConfig } from "../server/config.js";
import { createServer } from "../server/http.js";

let server;
let configChecked = false;

export default async function handler(req, res) {
  if (!configChecked) {
    assertWebRuntimeConfig();
    configChecked = true;
  }

  if (!server) server = createServer();

  await new Promise((resolve, reject) => {
    res.once("finish", resolve);
    res.once("close", resolve);
    res.once("error", reject);
    server.emit("request", req, res);
  });
}
