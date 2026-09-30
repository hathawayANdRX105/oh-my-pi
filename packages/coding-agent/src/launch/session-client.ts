import { createDaemonBrokerClient, type DaemonBrokerClient } from "./client";
import type {
	SessionAttachRequest,
	SessionAttachResponse,
	SessionCancelResponse,
	SessionCommandResponse,
	SessionDetachResponse,
	SessionEvent,
	SessionOperation,
	SessionOperationResult,
	SessionPromptResponse,
	SessionResumeResponse,
} from "./session-protocol";

export interface SessionClientOptions {
	readonly projectDir: string;
	readonly runtimeDir?: string;
	readonly idleGraceMs?: number;
}

export interface SessionClientHandlers {
	readonly onEvent?: (event: SessionEvent) => void;
	readonly onError?: (error: Error) => void;
}

export class SessionHostClient {
	readonly #options: SessionClientOptions;
	readonly #handlers: SessionClientHandlers;
	#broker: DaemonBrokerClient | undefined;
	#unsubscribe: (() => void) | undefined;
	#sessionId: string | undefined;
	#ownerId: string | undefined;
	#since = 0;

	constructor(options: SessionClientOptions, handlers: SessionClientHandlers = {}) {
		this.#options = options;
		this.#handlers = handlers;
	}

	async connect(): Promise<void> {
		if (this.#broker) return;
		this.#broker = await createDaemonBrokerClient(this.#options.projectDir, {
			runtimeDir: this.#options.runtimeDir,
			idleGraceMs: this.#options.idleGraceMs,
		});
		this.#unsubscribe = this.#broker.onSessionEvent(event => {
			this.#since = event.seq;
			this.#handlers.onEvent?.(event);
		});
	}

	async attach(request: SessionAttachRequest): Promise<SessionAttachResponse> {
		const result = await this.#request({ op: "attach", request });
		if (!result.ok || result.op !== "attach") throw sessionFailure(result);
		this.#sessionId = result.response.sessionId;
		this.#ownerId = result.response.ownerId;
		this.#since = result.response.since;
		return result.response;
	}

	async resume(sessionId = this.#sessionId, since = this.#since): Promise<SessionResumeResponse> {
		if (!sessionId) throw new Error("No session is attached");
		const result = await this.#request({ op: "resume", request: { sessionId, since } });
		if (!result.ok || result.op !== "resume") throw sessionFailure(result);
		this.#since = result.response.since;
		return result.response;
	}

	async prompt(text: string, cwd?: string): Promise<SessionPromptResponse> {
		const ownerId = this.#requireOwner();
		const result = await this.#request({ op: "prompt", request: { text, ownerId, cwd } });
		if (!result.ok || result.op !== "prompt") throw sessionFailure(result);
		return result.response;
	}

	async command(command: string, args?: Readonly<Record<string, unknown>>): Promise<SessionCommandResponse> {
		const ownerId = this.#requireOwner();
		const result = await this.#request({ op: "command", request: { command, ownerId, args } });
		if (!result.ok || result.op !== "command") throw sessionFailure(result);
		return result.response;
	}

	async approve(id: string, approved: boolean): Promise<void> {
		const ownerId = this.#requireOwner();
		const result = await this.#request({ op: "approve", request: { id, approved, ownerId } });
		if (!result.ok || result.op !== "approve") throw sessionFailure(result);
	}

	async cancel(reason?: string): Promise<SessionCancelResponse> {
		const ownerId = this.#requireOwner();
		const result = await this.#request({ op: "cancel", request: { ownerId, reason } });
		if (!result.ok || result.op !== "cancel") throw sessionFailure(result);
		return result.response;
	}

	async detach(): Promise<SessionDetachResponse> {
		const ownerId = this.#requireOwner();
		const result = await this.#request({ op: "detach", request: { ownerId } });
		if (!result.ok || result.op !== "detach") throw sessionFailure(result);
		this.#sessionId = undefined;
		this.#ownerId = undefined;
		return result.response;
	}

	disconnect(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#broker?.close();
		this.#broker = undefined;
	}

	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	get ownerId(): string | undefined {
		return this.#ownerId;
	}

	async #request(operation: SessionOperation): Promise<SessionOperationResult> {
		if (!this.#broker) await this.connect();
		const broker = this.#broker;
		if (!broker) throw new Error("Session broker is unavailable");
		const result = await broker.request({ op: "session", request: operation });
		if (result.op !== "session") throw new Error(`Unexpected broker result: ${result.op}`);
		return result.result;
	}
	#requireOwner(): string {
		if (!this.#ownerId) throw new Error("No session owner is attached");
		return this.#ownerId;
	}
}

function sessionFailure(result: SessionOperationResult): Error {
	return new Error(result.ok ? `Unexpected session result: ${result.op}` : `${result.error}: ${result.message}`);
}
