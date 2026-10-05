import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModelOptions } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// `running` was broadcast on agent_start and `idle` only from the settle path's
// `emitAgentEndNotification`. A run that died before the loop settled — a
// dropped socket with no recovery branch to take — therefore never broadcast
// `idle`, and every listener (including `AgentRegistry.syncSessionStatus`,
// which mirrors the state into an agent's status) kept advertising a live run
// with nothing behind it. The TUI gates Esc on `isRetrying` / `isStreaming`,
// so the user was left staring at a running badge no keypress could clear.
//
// These tests pin the properties that make the badge escapable: a state is
// never broadcast twice, a live run is visible through `isRunActive` for the
// Esc fallback to read, and an abort always settles the state.
describe("AgentSession run state", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-run-state-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(responses: NonNullable<MockModelOptions["responses"]>): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: m => `${m.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": true }),
			modelRegistry,
		});
	}

	// Failure mode: `idle` is emitted from both the settle path and abort's
	// teardown. A registry-backed listener that treats each call as a fresh
	// transition would re-announce a settle it already saw.
	it("broadcasts each transition once", async () => {
		session = createSession([{ content: ["done"], stopReason: "stop" }]);
		const states: string[] = [];
		session.subscribeRunState(state => states.push(state));

		await session.prompt("say something");
		await session.waitForIdle();
		await session.abort();
		await session.abort();

		expect(states).toEqual(["running", "idle"]);
	});

	// Failure mode: the user presses Esc on a badge claiming a live run. If
	// abort leaves the last broadcast as `running`, the UI keeps rendering
	// "running" forever and every later Esc is a no-op.
	it("settles to idle when a run is aborted", async () => {
		session = createSession([{ content: ["partial answer"], stopReason: "stop" }]);
		const states: string[] = [];
		session.subscribeRunState(state => states.push(state));

		await session.prompt("say something");
		await session.waitForIdle();
		await session.abort();

		expect(states.at(0)).toBe("running");
		expect(states.at(-1)).toBe("idle");
		expect(session.isRunActive).toBe(false);
	});

	// Failure mode: the Esc fallback reads `isRunActive` instead of
	// `isStreaming`. It must be true exactly while a run is advertised, and
	// false once settled — otherwise Esc either cannot stop a live run or
	// hijacks a typed draft on an idle session.
	it("tracks whether a run is advertised", async () => {
		const gate = Promise.withResolvers<void>();
		// The first pull never resolves until the gate opens, so the run is
		// advertised while the model is still waiting on its first token.
		session = createSession(
			(async function* () {
				await gate.promise;
				yield { content: ["first"], stopReason: "stop" as const };
			})(),
		);

		expect(session.isRunActive).toBe(false);

		const advertised = Promise.withResolvers<void>();
		const states: string[] = [];
		session.subscribeRunState(state => {
			states.push(state);
			if (state === "running") advertised.resolve();
		});
		const live = session.prompt("say something");
		await advertised.promise;
		expect(session.isRunActive).toBe(true);

		gate.resolve();
		await live;
		await session.waitForIdle();
		expect(session.isRunActive).toBe(false);
		expect(states).toEqual(["running", "idle"]);
	});
});
