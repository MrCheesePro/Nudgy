#!/usr/bin/env node
/**
 * Dev harness for Nudgy's Rich Presence socket — and a worked example of what a real
 * client (a VS Code extension, a browser extension, a build script) has to do.
 *
 *   node scripts/rpc-test-client.mjs "Writing Lab Report" Productivity
 *
 * Holds the connection open and re-sends every 20 seconds. Presence expires 60 seconds
 * after the last message, so a client that stops talking stops claiming the foreground.
 * Ctrl-C clears the presence and disconnects.
 */

import net from "node:net";
import process from "node:process";

const SOCKET_PATH = "/tmp/nudgy-rpc.sock";
const PIPE_PATH = "\\\\.\\pipe\\nudgy-rpc";
const HEARTBEAT_MS = 20_000;

const activity = process.argv[2] ?? "Writing Lab Report";
const category = process.argv[3] ?? "Productivity";
const clientId = process.argv[4] ?? "nudgy-test-client";

const target = process.platform === "win32" ? PIPE_PATH : SOCKET_PATH;
const startedAt = Math.floor(Date.now() / 1000);

const socket = net.createConnection(target, () => {
  console.log(`connected to ${target}`);
  send();
  setInterval(send, HEARTBEAT_MS);
});

function send() {
  const payload = {
    client_id: clientId,
    activity,
    category,
    started_at: startedAt,
  };
  socket.write(`${JSON.stringify(payload)}\n`);
  console.log(`sent: ${activity} (${category})`);
}

socket.on("error", (error) => {
  console.error(`socket error: ${error.message}`);
  console.error("Is Nudgy running? The listener starts with the app.");
  process.exit(1);
});

socket.on("close", () => {
  console.log("disconnected");
  process.exit(0);
});

process.on("SIGINT", () => {
  socket.write(`${JSON.stringify({ client_id: clientId, activity: "", clear: true })}\n`);
  socket.end();
});
