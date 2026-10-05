import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage, SyntheticToolResultDetails } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";

// Bun reports a response body cut off mid-stream as "The socket connection was
// closed unexpectedly" — the same failure the watchdog's stream stall, an
// HTTP/2 reset, and a premature close already are. Its wording was missing
// from the mid-stream pattern set, so it never reached
// `classifyResolvedInterruptedToolTurn` and a tool turn died on it even when
// every emitted call had returned, the case the stall branch has always
// resumed.
//
// These tests pin that a socket close is classified as the mid-stream
// transport failure it is.
const SOCKET_CLOSE =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const STREAM_STALL = "Anthropic stream stalled while waiting for the next event";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeMessage(content: AssistantMessage["content"], model: Model, errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function createHost(model: Model, modelRegistry: ModelRegistry, messages: AgentMessage[]): TurnRecoveryHost {
	const agentState = { messages };
	return {
		agent: {
			state: agentState,
			replaceMessages(next: AgentMessage[]) {
				agentState.messages = next;
			},
		} as never,
		sessionManager: { getLastModelChangeRole: () => undefined } as never,
		persistedAssistantEntryId: () => undefined,
		settings: Settings.isolated(),
		modelRegistry,
		configWarnings: [],
		model: () => model,
		contextFitsModel: () => true,
		textOutputCommitted: () => true,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		promptSequence: () => 0,
		sessionId: () => "socket-close-session",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async () => {},
		resolveActiveEditMode: () => "hashline",
		syncAfterModelChange: async () => {},
		resetCurrentResponsesProviderSession: async () => {},
		maybeAutoRedeemReset: async () => ({ restored: false }),
		runAutoCompaction: async () =>
			({ deferredHandoff: false, continuationScheduled: false }) as RecoveryCompactionResult,
		shakeForRequestBodyReadTimeout: async () => false,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};
}

function toolCall(id: string): AssistantMessage["content"][number] {
	return { type: "toolCall", id, name: "bash", arguments: { command: "ls" } };
}

function realResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function unexecutedResult(toolCallId: string): ToolResultMessage<SyntheticToolResultDetails> {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "Tool call was not executed." }],
		isError: true,
		details: { __synthetic: true, source: "assistant_stop_error", executed: false },
		timestamp: Date.now(),
	};
}

describe("TurnRecovery socket-close classification", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-socket-close-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"), {
			settings: Settings.isolated(),
		});
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function classifyFor(
		errorMessage: string,
		tail: AgentMessage[],
		content: AssistantMessage["content"] = [toolCall("call-1")],
	) {
		const assistant = makeMessage(content, model, errorMessage);
		const recovery = new TurnRecovery(createHost(model, modelRegistry, [assistant, ...tail]));
		return recovery.classifyResolvedInterruptedToolTurn(assistant);
	}

	// Every content shape the classifier can see, paired with every tail shape,
	// must classify a socket close exactly as it classifies a stream stall. The
	// classifier never inspects text, so a socket close also resumes a turn that
	// committed visible text beside the call — that is the text-only stall
	// branch's guarantee (the partial turn stays in context and is continued
	// from, never replayed) applied to one more content shape.
	const CONTENT_SHAPES: AssistantMessage["content"][] = [
		[toolCall("call-1")],
		[{ type: "text", text: "Reading the file" }, toolCall("call-1")],
		[{ type: "text", text: "Reading two files" }, toolCall("call-1"), toolCall("call-2")],
	];
	const TAIL_SHAPES: AgentMessage[][] = [
		[realResult("call-1")],
		[unexecutedResult("call-1")],
		[realResult("call-1"), realResult("call-2")],
	];

	// Failure mode: a socket close after the model emitted a call that already
	// returned. The stall branch resumes this exact shape, so refusing it here
	// left the run ending on a pinned error for a failure the session already
	// knows how to continue past.
	it("resumes a socket-closed tool turn whose call already returned", () => {
		expect(classifyFor(SOCKET_CLOSE, [realResult("call-1")])).toBe("stream-stall");
	});

	// Parity contract: socket close must classify exactly like the failure class
	// it belongs to, for every content and tail shape. A consumer that resumes a
	// stalled turn but pins a socket-closed one is the gap this pins shut, from
	// the consumer's side.
	it("classifies a socket close the same as a stream stall", () => {
		for (const content of CONTENT_SHAPES) {
			for (const tail of TAIL_SHAPES) {
				expect(classifyFor(SOCKET_CLOSE, tail, content)).toBe(classifyFor(STREAM_STALL, tail, content));
			}
		}
	});

	// Negative control: a call with no result anywhere is still unpaired — the
	// agent loop may owe it — so the turn must not continue.
	it("does not resume when a tool call is still unpaired", () => {
		expect(classifyFor(SOCKET_CLOSE, [])).toBeUndefined();
	});

	// Negative control: a 400 is the client's fault. Widening the transport
	// predicate must not turn a rejected request into a resumable turn.
	it("does not resume a non-transport provider rejection", () => {
		const assistant = makeMessage([toolCall("call-1")], model, "400 invalid request: messages must not be empty");
		const recovery = new TurnRecovery(createHost(model, modelRegistry, [assistant, unexecutedResult("call-1")]));

		expect(recovery.classifyResolvedInterruptedToolTurn(assistant)).toBeUndefined();
	});
});
