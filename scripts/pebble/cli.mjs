#!/usr/bin/env node
// Entry point for `npm run pebble:doctor|setup|start|stop`.
import { doctor } from "./doctor.mjs";
import { setup } from "./setup.mjs";
import { start } from "./start.mjs";
import { stop } from "./stop.mjs";
import { realSystem } from "./system.mjs";

const [command, ...args] = process.argv.slice(2);
const sys = realSystem();
const commands = {
  doctor: () => doctor(sys, { verify: args.includes("--verify") }),
  setup: () => setup(sys),
  start: () => start(sys),
  stop: () => stop(sys),
};

if (!(command in commands)) {
  console.error("Usage: node scripts/pebble/cli.mjs doctor [--verify] | setup | start | stop");
  process.exit(2);
}
try {
  process.exitCode = await commands[command]();
} catch (error) {
  console.error(`Pebble: ${error.message}`);
  process.exitCode = 1;
}
