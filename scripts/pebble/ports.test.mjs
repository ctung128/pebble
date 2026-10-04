import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { canBind, classifyWebPort, classifyWorkerPort, parsePebbleHealth } from "./ports.mjs";
import { VERSION, health, serve } from "./testkit.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a compatible Pebble worker is recognised", async () => {
  const server = await serve({ healthBody: health() });
  try {
    const result = await classifyWorkerPort(server.port, { expectedVersion: VERSION });
    assert.equal(result.state, "pebble");
  } finally {
    await server.close();
  }
});

test("another version or provider is an incompatible Pebble worker", async () => {
  for (const body of [
    health({ workerVersion: "0.0.9" }),
    health({ providers: [{ id: "mock", kind: "mock", available: true, detail: null }] }),
  ]) {
    const server = await serve({ healthBody: body });
    try {
      const result = await classifyWorkerPort(server.port, { expectedVersion: VERSION });
      assert.equal(result.state, "pebble-incompatible");
    } finally {
      await server.close();
    }
  }
});

test("an unrelated HTTP server is another program", async () => {
  const server = await serve({ healthBody: '{"status":"ok"}', pageBody: "<title>Other</title>" });
  try {
    assert.equal(
      (await classifyWorkerPort(server.port, { expectedVersion: VERSION })).state,
      "other",
    );
    assert.equal((await classifyWebPort(server.port)).state, "other");
  } finally {
    await server.close();
  }
});

test("a silent TCP listener is another program", async () => {
  const sockets = [];
  const server = net.createServer((socket) => sockets.push(socket)); // never answers
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await classifyWorkerPort(server.address().port, { expectedVersion: VERSION });
    assert.equal(result.state, "other");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a listener on every address still counts as occupied", async () => {
  const server = net.createServer((socket) => socket.resume().end()); // reads, then hangs up
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  try {
    const result = await classifyWorkerPort(server.address().port, { expectedVersion: VERSION });
    assert.equal(result.state, "other");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a free port is free, including right after a closed connection", async () => {
  assert.equal(
    (await classifyWorkerPort(await freePort(), { expectedVersion: VERSION })).state,
    "free",
  );

  // Leave a connection from a stopped server behind (the server side closes first).
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => {
    const client = net.connect({ host: "127.0.0.1", port });
    client.on("close", resolve);
    client.on("error", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await canBind(port), true);
  assert.equal((await classifyWorkerPort(port, { expectedVersion: VERSION })).state, "free");
});

test("the Pebble app page is recognised on the web port", async () => {
  const server = await serve();
  try {
    assert.equal((await classifyWebPort(server.port)).state, "pebble");
  } finally {
    await server.close();
  }
});

test("health parsing accepts Pebble health only", () => {
  assert.ok(parsePebbleHealth(JSON.stringify(health())));
  assert.equal(parsePebbleHealth("not json"), null);
  assert.equal(parsePebbleHealth(JSON.stringify({ ...health(), schemaVersion: "2.0" })), null);
  assert.equal(parsePebbleHealth(JSON.stringify({ status: "ok" })), null);
});

test("an app served on IPv6 localhost only is seen on the web port", async () => {
  const server = http.createServer((request, response) => response.end("<title>Pebble</title>"));
  const listening = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(0, "::1", () => resolve(true));
  });
  if (!listening) return; // no IPv6 on this machine
  try {
    assert.equal((await classifyWebPort(server.address().port)).state, "pebble");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
