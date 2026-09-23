// Integration tests for the three shared heavy resources the project daemon
// broker owns (MCP servers, the mnemopi embed worker, the shared Chromium):
// each case drives a real in-process broker over its unix socket with real
// broker clients, so a regression that re-attaches resource ownership to the
// client process (or to a machine-global scope) is what makes the assertion
// red — not a fake. Real timers are required: cross-process spawn, the unix-
// socket RPC, and process exit are all OS-level. The broker is awaited via its
// own run() promise (its resolution IS the shutdown signal), never by polling.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonRpcResult,
} from "../../src/launch/protocol";
import { sharedBrowserDaemonName } from "../../src/tools/browser/shared-daemon";

/**
 * Minimal MCP stdio server: answers the broker's `initialize` handshake plus a
 * single `poke` tool whose call payload reports the server's own pid, and
 * appends that pid to `MCP_PID_FILE` on every startup so a test can count
 * server spawns (two lines means a second, unshared process was created).
 */
function fakeMcpServerScript(): string {
	const script = `
import * as fs from "node:fs";
if (process.env.MCP_PID_FILE) fs.appendFileSync(process.env.MCP_PID_FILE, String(process.pid) + "\\n");
function reply(message, result) {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\\n");
		if (newline < 0) return;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!line.trim()) continue;
		const message = JSON.parse(line);
		if (message.method === "initialize") {
			reply(message, {
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "fake-mcp", version: "1" },
			});
		} else if (message.method === "tools/list") {
			reply(message, {
				tools: [{ name: "poke", description: "sleep", inputSchema: { type: "object" } }],
			});
		} else if (message.method === "tools/call") {
			const ms = Math.min(Number(message.params?.arguments?.ms ?? 10), 60_000);
			setTimeout(() => {
				reply(message, { content: [{ type: "text", text: "ok " + process.pid }], isError: false });
			}, ms);
		} else if (message.id !== undefined) {
			reply(message, {});
		}
	}
});
`;
	return script;
}

function stdioMcpConfig(pidFile: string, cwd: string): Record<string, unknown> {
	return {
		type: "stdio",
		command: process.execPath,
		args: ["-e", fakeMcpServerScript()],
		env: { MCP_PID_FILE: pidFile },
		cwd,
		// Hermetic fast handshake so a wedged fake server cannot stall the test.
		timeout: 10_000,
	};
}
function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** Start one in-process broker for a scope; resolves when that broker shuts down. */
function startBroker(projectDir: string, runtimeDir: string, idleGraceMs: number): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = String(idleGraceMs);
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

/** Ask the broker to stop and wait for its run() promise (shutdown signal). */
async function stopBroker(client: DaemonBrokerClient, broker: Promise<void>): Promise<void> {
	await client.request({ op: "shutdown" });
	await broker;
}

/** Narrow a broker RPC result to the union member matching the sent operation. */
function resultOf<T extends DaemonRpcResult["op"]>(
	value: DaemonRpcResult,
	_op: T,
): Extract<DaemonRpcResult, { op: T }> {
	return value as Extract<DaemonRpcResult, { op: T }>;
}

describe("shared heavy workers (project daemon broker)", () => {
	it("second client attaches to the running mcp server", async () => {
		using tempDir = TempDir.createSync("@omp-shared-mcp-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const pidFile = path.join(tempDir.path(), "mcp-pids.txt");
		await fs.mkdir(projectDir);

		const clientA = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 30_000 });
		const clientB = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 30_000 });
		const broker = startBroker(projectDir, runtimeDir, 30_000);
		const previousTitle = process.title;
		const config = stdioMcpConfig(pidFile, projectDir);
		try {
			const ensureA = resultOf(await clientA.request({ op: "mcp-ensure", server: "fake", config }), "mcp-ensure");
			expect(ensureA.op).toBe("mcp-ensure");
			// The first ensure starts the shared server; a regression that lets
			// every client spawn its own server would still pass this line but
			// break the pid-file count and the attached flag below.
			expect(ensureA.attached).toBe(false);
			expect(ensureA.serverInfo).toEqual({ name: "fake-mcp", version: "1" });
			const callA = resultOf(
				await clientA.request({
					op: "mcp-request",
					server: "fake",
					method: "tools/call",
					params: { name: "poke", arguments: { ms: 10 } },
				}),
				"mcp-request",
			);
			expect(callA.result).toMatchObject({ isError: false });

			const ensureB = resultOf(await clientB.request({ op: "mcp-ensure", server: "fake", config }), "mcp-ensure");
			// Red if the second client spawned its own process instead of
			// attaching to the broker-owned one.
			expect(ensureB.attached).toBe(true);
			expect(ensureB.serverInfo).toEqual(ensureA.serverInfo);
			const callB = resultOf(
				await clientB.request({
					op: "mcp-request",
					server: "fake",
					method: "tools/call",
					params: { name: "poke", arguments: { ms: 10 } },
				}),
				"mcp-request",
			);
			// Both calls reach the same subprocess: identical pid in the payload.
			const pidOf = (result: unknown): string =>
				String((result as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text);
			expect(pidOf(callA)).toBe(pidOf(callB));

			// Exactly one server process started for the whole project.
			const pids = (await fs.readFile(pidFile, "utf8")).trim().split("\n").filter(Boolean);
			expect(pids).toHaveLength(1);
		} finally {
			await stopBroker(clientA, broker);
			clientA.close();
			clientB.close();
			process.title = previousTitle;
		}
	}, 30_000);

	it("embed survives the first client exiting", async () => {
		using tempDir = TempDir.createSync("@omp-shared-embed-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const clientA = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 30_000 });
		const clientB = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 30_000 });
		const broker = startBroker(projectDir, runtimeDir, 30_000);
		const previousTitle = process.title;
		const model = "fast-bge-base-en-v1.5";
		try {
			const initA = resultOf(await clientA.request({ op: "embed-init", model }), "embed-init");
			expect(initA.op).toBe("embed-init");
			// The broker must have a live worker to hand out; a missing pid
			// means the worker never started in this environment.
			expect(initA.pid).toBeTypeOf("number");

			// First client goes away. A regression tying the worker to a
			// client's process/socket lifecycle would leave clientB with a
			// dead (or freshly re-spawned) worker — a different pid.
			clientA.close();

			const initB = resultOf(await clientB.request({ op: "embed-init", model }), "embed-init");
			expect(initB.pid).toBe(initA.pid);

			// When the model actually loads, the surviving worker serves the
			// second client for real; without a loadable model both clients
			// see the same stable "unavailable" state instead of a crash.
			if (initB.ready) {
				const embedded = resultOf(await clientB.request({ op: "embed", model, texts: ["hello world"] }), "embed");
				expect(embedded.op).toBe("embed");
				expect(Array.isArray(embedded.vectors)).toBe(true);
				expect(embedded.vectors.length).toBeGreaterThan(0);
				expect(embedded.vectors[0].every(value => Number.isFinite(value))).toBe(true);
			}
		} finally {
			await stopBroker(clientB, broker);
			clientB.close();
			process.title = previousTitle;
		}
	}, 120_000);

	it("two projects do not share a browser", async () => {
		using rootA = TempDir.createSync("@omp-shared-browser-a-");
		using rootB = TempDir.createSync("@omp-shared-browser-b-");
		const projectA = path.join(rootA.path(), "project");
		const runtimeA = path.join(rootA.path(), "runtime");
		const projectB = path.join(rootB.path(), "project");
		const runtimeB = path.join(rootB.path(), "runtime");
		await fs.mkdir(projectA);
		await fs.mkdir(projectB);

		const browserName = sharedBrowserDaemonName(true);
		const browserSpec = (cwd: string) => ({
			name: browserName,
			// The shared daemon's real spec is a Chromium launch; a no-op
			// stand-in under the same name is enough to prove scope isolation.
			application: process.execPath,
			args: ["-e", "setTimeout(() => {}, 60_000)"],
			env: {} as Record<string, string>,
			cwd,
			pty: false,
			restart: "no" as const,
			persist: false,
			detached: false,
		});

		const clientA = await createDaemonBrokerClient(projectA, { runtimeDir: runtimeA, idleGraceMs: 30_000 });
		const clientB = await createDaemonBrokerClient(projectB, { runtimeDir: runtimeB, idleGraceMs: 30_000 });
		const brokerA = startBroker(projectA, runtimeA, 30_000);
		const brokerB = startBroker(projectB, runtimeB, 30_000);
		const previousTitle = process.title;
		try {
			const started = await clientA.request({ op: "start", spec: browserSpec(projectA) });
			expect(started.op).toBe("start");

			const listA = resultOf(await clientA.request({ op: "list" }), "list");
			expect(listA.daemons.some(daemon => daemon.name === browserName)).toBe(true);

			// Red if scoping ever becomes machine-global: project B's broker
			// would see project A's shared browser daemon.
			const listB = resultOf(await clientB.request({ op: "list" }), "list");
			expect(listB.daemons.some(daemon => daemon.name === browserName)).toBe(false);
		} finally {
			await stopBroker(clientA, brokerA);
			await stopBroker(clientB, brokerB);
			clientA.close();
			clientB.close();
			process.title = previousTitle;
		}
	}, 30_000);

	it("in-flight call fails retryably when the broker dies", async () => {
		using tempDir = TempDir.createSync("@omp-shared-dead-broker-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const pidFile = path.join(tempDir.path(), "mcp-pids.txt");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 30_000 });
		const config = stdioMcpConfig(pidFile, projectDir);
		let liveBroker: Promise<void> | null = startBroker(projectDir, runtimeDir, 30_000);
		const stopLive = async (): Promise<void> => {
			if (!liveBroker) return;
			const generation = liveBroker;
			liveBroker = null;
			await stopBroker(client, generation);
		};
		const previousTitle = process.title;
		try {
			await client.request({ op: "mcp-ensure", server: "fake", config });
			// A call that will still be running when the broker dies. Capture the
			// rejection synchronously: between the call and the broker death no
			// handler may be attached, or the runtime reports it unhandled.
			const failurePromise = client
				.request({
					op: "mcp-request",
					server: "fake",
					method: "tools/call",
					params: { name: "poke", arguments: { ms: 30_000 } },
				})
				.then(
					() => null as unknown,
					(error: unknown) => error,
				);
			await stopLive();

			// Red if broker death hangs the call (until the RPC timer) or
			// swallows it into an empty result: the in-flight request must
			// reject fast with a stable connection-lost error.
			const settledAt = Date.now();
			const failure = await failurePromise;
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toContain("closed");
			expect(Date.now() - settledAt).toBeLessThan(5_000);

			// Later requests reconnect: a fresh broker takes the same scope,
			// the same client lazily re-binds, and re-ensure re-spawns the
			// server — no retry state left stuck on the dead broker.
			liveBroker = startBroker(projectDir, runtimeDir, 30_000);
			const reEnsure = resultOf(await client.request({ op: "mcp-ensure", server: "fake", config }), "mcp-ensure");
			expect(reEnsure.attached).toBe(false);
			const call = resultOf(
				await client.request({
					op: "mcp-request",
					server: "fake",
					method: "tools/call",
					params: { name: "poke", arguments: { ms: 10 } },
				}),
				"mcp-request",
			);
			expect(call.result).toMatchObject({ isError: false });
		} finally {
			await stopLive();
			client.close();
			process.title = previousTitle;
		}
	}, 30_000);
});
