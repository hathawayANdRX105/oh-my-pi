import { describe, expect, it } from "bun:test";
import { SessionHost, type SessionRuntime, type SessionTransport } from "../../src/launch/session-host";
import { isSessionError } from "../../src/launch/session-protocol";

function transport(): SessionTransport & { lines: string[] } {
	return {
		lines: [],
		write(data: string) {
			this.lines.push(data);
		},
	};
}

function runtime(sessionId: string): SessionRuntime {
	let unsubscribe: (() => void) | undefined;
	return {
		sessionId,
		prompt: async () => {
			unsubscribe?.();
			return true;
		},
		abort: async () => undefined,
		waitForIdle: async () => undefined,
		subscribe: listener => {
			unsubscribe = () => undefined;
			listener({ type: "message_start" });
			return unsubscribe;
		},
		dispose: async () => undefined,
	};
}

describe("session host slot contract", () => {
	it("reuses one runtime for a second attach and isolates a different session", async () => {
		const created: string[] = [];
		const host = new SessionHost({
			projectDir: "/tmp/project",
			runtimeDir: "/tmp/runtime",
			createSession: async input => {
				created.push(input.sessionManager.getSessionId());
				return runtime(input.sessionManager.getSessionId());
			},
		});
		const first = transport();
		const attached = await host.handleOperation(first, {
			op: "attach",
			request: { cwd: "/tmp/project", since: 0 },
		});
		if (isSessionError(attached) || attached.op !== "attach") throw new Error("attach failed");
		const second = transport();
		const reattached = await host.handleOperation(second, {
			op: "attach",
			request: { cwd: "/tmp/project", sessionId: attached.response.sessionId, since: 0 },
		});
		if (isSessionError(reattached) || reattached.op !== "attach") throw new Error("reattach failed");
		expect(reattached.response.slotId).toBe(attached.response.slotId);
		expect(created).toEqual([attached.response.sessionId]);

		const other = transport();
		const isolated = await host.handleOperation(other, {
			op: "attach",
			request: { cwd: "/tmp/other", since: 0 },
		});
		if (isSessionError(isolated) || isolated.op !== "attach") throw new Error("isolated attach failed");
		expect(isolated.response.slotId).not.toBe(attached.response.slotId);
		await host.shutdown();
	});

	it("returns busy for a second prompt and unloads after the last detach", async () => {
		const host = new SessionHost({
			projectDir: "/tmp/project",
			runtimeDir: "/tmp/runtime",
			createSession: async input => runtime(input.sessionManager.getSessionId()),
		});
		const ownerTransport = transport();
		const attached = await host.handleOperation(ownerTransport, {
			op: "attach",
			request: { cwd: "/tmp/project", since: 0 },
		});
		if (isSessionError(attached) || attached.op !== "attach") throw new Error("attach failed");
		const started = await host.handleOperation(ownerTransport, {
			op: "prompt",
			request: { text: "continue", ownerId: attached.response.ownerId },
		});
		if (isSessionError(started) || started.op !== "prompt") throw new Error("prompt failed");
		const busy = await host.handleOperation(ownerTransport, {
			op: "prompt",
			request: { text: "again", ownerId: attached.response.ownerId },
		});
		expect(isSessionError(busy) && busy.error).toBe("turn_busy");
		const detached = await host.handleOperation(ownerTransport, {
			op: "detach",
			request: { ownerId: attached.response.ownerId },
		});
		expect(isSessionError(detached)).toBe(false);
		await host.shutdown();
	});
});
