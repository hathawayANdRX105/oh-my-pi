import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
import { EventBus } from "../utils/event-bus";
import { Settings } from "../config/settings";
import { IrcBus } from "../irc/bus";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import { resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { runInSessionRuntime, type SessionRuntimeContext } from "../session/runtime-context";
import {
	parseSessionOperation,
	type SessionApproveRequest,
	type SessionAttachRequest,
	type SessionAttachResponse,
	type SessionCancelRequest,
	type SessionCommandRequest,
	type SessionDetachRequest,
	type SessionError,
	type SessionErrorCode,
	type SessionEvent,
	type SessionOperation,
	type SessionOperationResult,
	type SessionPromptRequest,
	type SessionResumeRequest,
	type SessionResumeResponse,
} from "./session-protocol";

export interface SessionTransport {
	readonly destroyed?: boolean;
	write(data: string): void;
}

export interface SessionRuntime {
	readonly sessionId: string;
	prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<boolean>;
	abort(options?: { reason?: string; goalReason?: "interrupted" | "internal" }): Promise<void>;
	waitForIdle(): Promise<void>;
	subscribe(listener: (event: unknown) => void): () => void;
	dispose(): Promise<void>;
	respondToApproval?(id: string, approved: boolean): Promise<void>;
}

export interface SessionFactoryInput {
	readonly cwd: string;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly agentRegistry: AgentRegistry;
	readonly agentLifecycleManager: AgentLifecycleManager;
	readonly ircBus: IrcBus;
	readonly eventBus: EventBus;
	readonly subagentEventBus: EventBus;
}

export type SessionFactory = (input: SessionFactoryInput) => Promise<SessionRuntime>;

export interface SessionHostOptions {
	readonly projectDir: string;
	readonly runtimeDir: string;
	readonly agentDir?: string;
	readonly idleExitMs?: number;
	readonly eventRingSize?: number;
	readonly createSession?: SessionFactory;
	readonly resolveSessionPath?: (sessionId: string, cwd: string) => Promise<string | undefined>;
}

interface ClientBinding {
	readonly clientId: string;
	readonly ownerId: string;
	readonly slotId: string;
	readonly transport: SessionTransport;
	isObserver: boolean;
}

interface SessionSlot {
	readonly slotId: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly cwd: string;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly registry: AgentRegistry;
	readonly lifecycle: AgentLifecycleManager;
	readonly ircBus: IrcBus;
	readonly eventBus: EventBus;
	readonly subagentEventBus: EventBus;
	readonly runtime: SessionRuntime;
	readonly clients: Set<string>;
	readonly events: SessionEvent[];
	turnOwner?: string;
	turnId?: string;
	turnPromise?: Promise<void>;
	unsubscribe: () => void;
	disposing?: Promise<void>;
}

const DEFAULT_EVENT_RING_SIZE = 4096;

export class SessionHost {
	readonly #slots = new Map<string, SessionSlot>();
	readonly #clients = new Map<SessionTransport, ClientBinding>();
	readonly #eventRingSize: number;
	readonly #createSession: SessionFactory;
	readonly #resolveSessionPath: (sessionId: string, cwd: string) => Promise<string | undefined>;
	#eventSeq = 0;

	constructor(private readonly options: SessionHostOptions) {
		this.#eventRingSize = options.eventRingSize ?? DEFAULT_EVENT_RING_SIZE;
		this.#createSession = options.createSession ?? createDefaultSessionRuntime;
		this.#resolveSessionPath = options.resolveSessionPath ?? resolveSessionPath;
	}

	get slotCount(): number {
		return this.#slots.size;
	}

	get clientCount(): number {
		return this.#clients.size;
	}

	get idleExitMs(): number {
		return this.options.idleExitMs ?? 600_000;
	}

	get hasActiveWork(): boolean {
		return this.#slots.size > 0 || this.#clients.size > 0;
	}

	async handleOperation(
		transport: SessionTransport,
		rawOperation: SessionOperation | unknown,
	): Promise<SessionOperationResult> {
		let operation: SessionOperation;
		try {
			operation =
				typeof rawOperation === "object" &&
				rawOperation !== null &&
				"op" in rawOperation &&
				"request" in rawOperation
					? parseSessionOperation(rawOperation)
					: parseSessionOperation(rawOperation);
		} catch (error) {
			return this.#error("internal_error", error instanceof Error ? error.message : String(error));
		}

		if (operation.op === "attach") return this.#attach(transport, operation.request);
		const binding = this.#clients.get(transport);
		if (!binding) return this.#error("session_not_found", "Session client is not attached");
		const slot =
			this.#slots.get(binding.slotId) ??
			[...this.#slots.values()].find(candidate => candidate.slotId === binding.slotId);
		if (!slot) return this.#error("session_not_found", "Session slot is no longer loaded");
		switch (operation.op) {
			case "resume":
				return this.#resume(slot, operation.request);
			case "prompt":
				return this.#prompt(slot, binding, operation.request);
			case "command":
				return this.#command(slot, binding, operation.request);
			case "approve":
				return this.#approve(slot, binding, operation.request);
			case "cancel":
				return this.#cancel(slot, binding, operation.request);
			case "detach":
				return this.#detach(slot, binding, operation.request);
		}
	}

	disconnect(transport: SessionTransport): void {
		const binding = this.#clients.get(transport);
		if (!binding) return;
		this.#clients.delete(transport);
		const slot =
			this.#slots.get(binding.slotId) ??
			[...this.#slots.values()].find(candidate => candidate.slotId === binding.slotId);
		if (!slot) return;
		slot.clients.delete(binding.clientId);
		if (slot.clients.size === 0 && !slot.turnPromise) void this.#disposeSlot(slot);
	}

	async shutdown(): Promise<void> {
		const slots = [...this.#slots.values()];
		this.#clients.clear();
		await Promise.all(slots.map(slot => this.#disposeSlot(slot)));
	}

	async #attach(transport: SessionTransport, request: SessionAttachRequest): Promise<SessionOperationResult> {
		if (this.#clients.has(transport)) return this.#error("internal_error", "Connection is already attached");
		const cwd = path.resolve(request.cwd);
		const requestedId = request.sessionId?.trim();
		const existing = requestedId ? this.#slots.get(requestedId) : undefined;
		if (existing) return this.#attachExisting(transport, existing, request.since ?? 0);

		let manager: SessionManager;
		let history: readonly unknown[] = [];
		if (request.resume) {
			if (!requestedId) return this.#error("journal_missing", "A session id is required for resume");
			const sessionPath = await this.#resolveSessionPath(requestedId, cwd);
			if (!sessionPath) return this.#error("journal_missing", `Session ${requestedId} was not found`);
			try {
				manager = await SessionManager.open(sessionPath, undefined, undefined, {
					initialCwd: cwd,
					suppressBreadcrumb: true,
					throwIfMissing: true,
				});
			} catch (error) {
				return this.#error("journal_missing", error instanceof Error ? error.message : String(error));
			}
			history = manager.getEntries();
		} else {
			manager = SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, this.options.agentDir));
			await manager.ensureOnDisk();
		}

		const settings = await Settings.loadIsolated({ cwd, agentDir: this.options.agentDir });
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const ircBus = new IrcBus(registry, lifecycle);
		const eventBus = new EventBus();
		const subagentEventBus = new EventBus();
		const sessionId = manager.getSessionId();
		const context: SessionRuntimeContext = {
			agentRegistry: registry,
			agentLifecycleManager: lifecycle,
			ircBus,
			eventBus,
			subagentEventBus,
			settings,
			sessionManager: manager,
		};
		let runtime: SessionRuntime;
		try {
			runtime = await runInSessionRuntime(context, () =>
				this.#createSession({
					cwd,
					sessionManager: manager,
					settings,
					agentRegistry: registry,
					agentLifecycleManager: lifecycle,
					ircBus,
					eventBus,
					subagentEventBus,
				}),
			);
		} catch (error) {
			await manager.close().catch(() => undefined);
			return this.#error("internal_error", error instanceof Error ? error.message : String(error));
		}
		if (runtime.sessionId !== sessionId) {
			await runtime.dispose().catch(() => undefined);
			await manager.close().catch(() => undefined);
			return this.#error("internal_error", "Session runtime identity mismatch");
		}

		const slotId = randomUUID();
		const slot: SessionSlot = {
			slotId,
			sessionId,
			sessionFile: manager.getSessionFile() ?? "",
			cwd,
			sessionManager: manager,
			settings,
			registry,
			lifecycle,
			ircBus,
			eventBus,
			subagentEventBus,
			runtime,
			clients: new Set(),
			events: [],
			unsubscribe: () => undefined,
		};
		slot.unsubscribe = runtime.subscribe(event => {
			runInSessionRuntime(context, () => this.#publish(slot, "rpc", event));
		});
		this.#slots.set(slot.sessionId, slot);
		this.#attachClient(transport, slot, request.since ?? 0);
		return {
			ok: true,
			op: "attach",
			response: this.#attachResponse(slot, transport, history),
		};
	}

	#attachExisting(transport: SessionTransport, slot: SessionSlot, since: number): SessionOperationResult {
		if (since > 0 && (slot.events.length === 0 || since < (slot.events[0]?.seq ?? this.#eventSeq) - 1)) {
			return this.#error("needs_full_reattach", "Requested event cursor is outside the in-memory ring");
		}
		const history = slot.sessionManager.getEntries();
		this.#attachClient(transport, slot, since);
		return { ok: true, op: "attach", response: this.#attachResponse(slot, transport, history) };
	}

	#attachClient(transport: SessionTransport, slot: SessionSlot, since: number): void {
		const clientId = randomUUID();
		const binding: ClientBinding = {
			clientId,
			ownerId: clientId,
			slotId: slot.slotId,
			transport,
			isObserver: slot.turnOwner !== undefined,
		};
		slot.clients.add(clientId);
		this.#clients.set(transport, binding);
		if (since > 0) {
			for (const event of slot.events) {
				if (event.seq > since) this.#sendEvent(transport, event);
			}
		}
	}

	#attachResponse(slot: SessionSlot, transport: SessionTransport, history: readonly unknown[]): SessionAttachResponse {
		const binding = this.#clients.get(transport);
		if (!binding) throw new Error("Session client disappeared during attach");
		return {
			sessionId: slot.sessionId,
			slotId: slot.slotId,
			clientId: binding.clientId,
			ownerId: binding.ownerId,
			since: slot.events.at(-1)?.seq ?? 0,
			events: slot.events,
			history,
			isObserver: binding.isObserver,
		};
	}

	#resume(slot: SessionSlot, request: SessionResumeRequest): SessionOperationResult {
		if (request.sessionId !== slot.sessionId)
			return this.#error("session_not_found", "Session id does not match the attached slot");
		const oldest = slot.events[0]?.seq ?? slot.events.length + 1;
		if (request.since > 0 && oldest > 1 && request.since < oldest - 1) {
			return this.#error("needs_full_reattach", "Requested event cursor is outside the in-memory ring");
		}
		const response: SessionResumeResponse = {
			sessionId: slot.sessionId,
			since: slot.events.at(-1)?.seq ?? 0,
			events: slot.events.filter(event => event.seq > request.since),
			history: slot.sessionManager.getEntries(),
			isObserver: false,
		};
		return { ok: true, op: "resume", response };
	}

	#prompt(slot: SessionSlot, binding: ClientBinding, request: SessionPromptRequest): SessionOperationResult {
		if (request.ownerId !== binding.ownerId) return this.#error("not_owner", "Only the turn owner may prompt");
		if (slot.turnPromise) {
			return this.#error(
				slot.turnOwner === binding.ownerId ? "turn_busy" : "not_owner",
				"A turn is already running",
			);
		}
		const turnId = randomUUID();
		slot.turnOwner = binding.ownerId;
		slot.turnId = turnId;
		slot.turnPromise = this.#runTurn(slot, request.text).finally(() => {
			slot.turnPromise = undefined;
			slot.turnOwner = undefined;
			slot.turnId = undefined;
			if (slot.clients.size === 0) void this.#disposeSlot(slot);
		});
		return {
			ok: true,
			op: "prompt",
			response: { accepted: true, turnId, turnOwner: binding.ownerId, since: slot.events.at(-1)?.seq ?? 0 },
		};
	}

	#command(slot: SessionSlot, binding: ClientBinding, request: SessionCommandRequest): SessionOperationResult {
		if (request.ownerId !== binding.ownerId) return this.#error("not_owner", "Only the turn owner may send commands");
		if (slot.turnPromise) return this.#error("turn_busy", "A turn is already running");
		const command = request.command.startsWith("/") ? request.command : `/${request.command}`;
		const turnId = randomUUID();
		slot.turnOwner = binding.ownerId;
		slot.turnId = turnId;
		slot.turnPromise = this.#runTurn(slot, command).finally(() => {
			slot.turnPromise = undefined;
			slot.turnOwner = undefined;
			slot.turnId = undefined;
			if (slot.clients.size === 0) void this.#disposeSlot(slot);
		});
		return {
			ok: true,
			op: "command",
			response: { accepted: true, handled: true, since: slot.events.at(-1)?.seq ?? 0 },
		};
	}

	async #runTurn(slot: SessionSlot, text: string): Promise<void> {
		try {
			await slot.runtime.prompt(text, { expandPromptTemplates: true });
		} catch (error) {
			this.#publish(slot, "error", { message: error instanceof Error ? error.message : String(error) });
		}
	}

	#approve(slot: SessionSlot, binding: ClientBinding, request: SessionApproveRequest): SessionOperationResult {
		if (request.ownerId !== binding.ownerId) return this.#error("not_owner", "Only the turn owner may approve");
		if (!slot.runtime.respondToApproval) return this.#error("turn_not_found", "No approval is pending for this turn");
		void slot.runtime
			.respondToApproval(request.id, request.approved)
			.catch(error => this.#publish(slot, "error", { message: String(error) }));
		return { ok: true, op: "approve", response: { success: true } };
	}

	async #cancel(
		slot: SessionSlot,
		binding: ClientBinding,
		request: SessionCancelRequest,
	): Promise<SessionOperationResult> {
		if (request.ownerId !== binding.ownerId) return this.#error("not_owner", "Only the turn owner may cancel");
		if (!slot.turnPromise) return this.#error("turn_not_found", "No active turn to cancel");
		const turnId = slot.turnId;
		await slot.runtime.abort({ reason: request.reason ?? "user interrupt" });
		await slot.turnPromise.catch(() => undefined);
		return { ok: true, op: "cancel", response: { success: true, turnId } };
	}

	#detach(slot: SessionSlot, binding: ClientBinding, request: SessionDetachRequest): SessionOperationResult {
		if (request.ownerId !== binding.ownerId) return this.#error("not_owner", "Only the attached client may detach");
		slot.clients.delete(binding.clientId);
		this.#clients.delete(binding.transport);
		if (slot.clients.size === 0 && !slot.turnPromise) void this.#disposeSlot(slot);
		return { ok: true, op: "detach", response: { success: true } };
	}

	#publish(slot: SessionSlot, type: SessionEvent["type"], data: unknown): void {
		const event: SessionEvent = { seq: ++this.#eventSeq, type, data, timestamp: Date.now() };
		slot.events.push(event);
		if (slot.events.length > this.#eventRingSize) slot.events.shift();
		for (const clientId of slot.clients) {
			const binding = [...this.#clients.values()].find(candidate => candidate.clientId === clientId);
			if (binding) this.#sendEvent(binding.transport, event);
		}
	}

	#sendEvent(transport: SessionTransport, event: SessionEvent): void {
		if (transport.destroyed) return;
		transport.write(`${JSON.stringify({ event: "session-event", notification: { op: "event", event } })}\n`);
	}

	async #disposeSlot(slot: SessionSlot): Promise<void> {
		if (slot.disposing) return slot.disposing;
		slot.disposing = (async () => {
			slot.unsubscribe();
			await slot.runtime.abort({ reason: "session slot detached" }).catch(() => undefined);
			await slot.runtime.waitForIdle().catch(() => undefined);
			await slot.sessionManager
				.flush()
				.catch(error => logger.warn("Session slot flush failed", { error: String(error) }));
			await slot.runtime
				.dispose()
				.catch(error => logger.warn("Session slot dispose failed", { error: String(error) }));
			await slot.sessionManager
				.close()
				.catch(error => logger.warn("Session slot close failed", { error: String(error) }));
			this.#slots.delete(slot.sessionId);
		})();
		return slot.disposing;
	}

	#error(error: SessionErrorCode, message: string): SessionError {
		return { ok: false, error, message };
	}
}

async function createDefaultSessionRuntime(input: SessionFactoryInput): Promise<SessionRuntime> {
	const result = await createAgentSession({
		cwd: input.cwd,
		sessionManager: input.sessionManager,
		settings: input.settings,
		agentRegistry: input.agentRegistry,
		agentLifecycleManager: input.agentLifecycleManager,
		eventBus: input.eventBus,
		subagentEventBus: input.subagentEventBus,
		agentId: MAIN_AGENT_ID,
	});
	const session = result.session;
	return {
		sessionId: input.sessionManager.getSessionId(),
		prompt: (text, options) => session.prompt(text, options),
		abort: options => session.abort(options),
		waitForIdle: () => session.waitForIdle(),
		subscribe: listener => session.subscribe(listener),
		dispose: () => session.dispose(),
	};
}

async function resolveSessionPath(sessionId: string, cwd: string): Promise<string | undefined> {
	if (path.extname(sessionId) === ".jsonl") {
		try {
			return (await Bun.file(path.resolve(sessionId)).exists()) ? path.resolve(sessionId) : undefined;
		} catch {
			return undefined;
		}
	}
	const match = await resolveResumableSession(sessionId, cwd);
	return match?.session.path;
}
