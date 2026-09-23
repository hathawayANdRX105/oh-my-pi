import { logger } from "@oh-my-pi/pi-utils";
import { daemonClientForProject, type DaemonBrokerClient } from "../launch/client";
import type { DaemonRpcResult } from "../launch/protocol";
import { getProjectDir, isCompiledBinary, workerHostEntry } from "@oh-my-pi/pi-utils";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	inferenceWorkerEnv,
	logWorkerMessage,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
	type RefCountedWorkerHandle,
} from "../subprocess/worker-client";
import type { MnemopiEmbedModelId, MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "./embed-protocol";

/**
 * Parent-side handle for the mnemopi embeddings subprocess. The runtime
 * implementation is a Bun child process so `onnxruntime-node`'s NAPI
 * constructor + finalizer never run inside the main agent address space —
 * those destructors segfault Bun on Windows when mnemopi's local embedding
 * provider loads fastembed in the main process (issue #3031; the mnemopi
 * sibling of the tiny-model fix from #1606 / #1607).
 */
export type MnemopiEmbedWorkerHandle = RefCountedWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound> & {
	readonly pid?: number;
};

type PendingRequest =
	| { kind: "init"; model: MnemopiEmbedModelId; resolve: (ok: boolean) => void }
	| { kind: "embed"; model: MnemopiEmbedModelId; resolve: (vectors: number[][] | Error) => void };

/**
 * Hidden subcommand on the main CLI that boots the mnemopi embeddings worker
 * in the spawned subprocess. Kept in sync with the dispatch in `cli.ts`.
 */
export const MNEMOPI_EMBED_WORKER_ARG = "__omp_worker_mnemopi_embed";

/**
 * Spawn the mnemopi embeddings worker as a subprocess. Exported for tests and
 * the smoke probe; production callers go through {@link spawnMnemopiEmbedWorker}.
 * The child inherits the parent env — fastembed honours `HF_HUB_*`,
 * `HTTPS_PROXY`, etc., and our `loadFastembed()` reads the same `OMP_*`
 * runtime-install knobs the parent uses.
 */
export function createMnemopiEmbedSubprocess(): SpawnedSubprocess<MnemopiEmbedWorkerOutbound> {
	return createWorkerSubprocess<MnemopiEmbedWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(MNEMOPI_EMBED_WORKER_ARG),
		env: inferenceWorkerEnv(),
		exitLabel: "mnemopi embed subprocess",
	});
}

function wrapSubprocess(spawned: SpawnedSubprocess<MnemopiEmbedWorkerOutbound>): MnemopiEmbedWorkerHandle {
	const { proc } = spawned;
	// Embed keeps its own guarded `proc.send` (neutralizes only the synchronous
	// throw, not the async EPIPE rejection) rather than the shared `safeSend`
	// the other workers use — behaviour preserved verbatim.
	return {
		...createWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>(spawned, message => {
			try {
				proc.send(message);
			} catch (error) {
				logger.debug("mnemopi-embed: send to subprocess failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}),
		ref() {
			try {
				proc.ref();
			} catch {
				// Already gone.
			}
		},
		unref() {
			try {
				proc.unref();
			} catch {
				// Already gone.
			}
		},
		get pid() {
			return proc.pid;
		},
	};
}

function createUnavailableMnemopiEmbedWorker(error: unknown): MnemopiEmbedWorkerHandle {
	return {
		...createUnavailableWorker<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>(error),
		ref() {},
		unref() {},
	};
}

export function spawnMnemopiEmbedWorker(): MnemopiEmbedWorkerHandle {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createMnemopiEmbedSubprocess()),
		createUnavailableMnemopiEmbedWorker,
		"mnemopi embed worker spawn failed; local embeddings disabled",
	);
}

/**
 * Broker-routed embed worker handle: the `__omp_worker_mnemopi_embed`
 * subprocess is owned by the project daemon broker, so one worker serves
 * every omp process in the project and outlives any single client. Each
 * `send()` round-trips one `embed-init`/`embed` RPC; broker loss faults the
 * in-flight request with a stable per-request error, and broker-client
 * resolution failure is a hard worker error. The next send re-ensures the
 * broker — the shared `DaemonBrokerClient` re-spawns it on demand.
 */
export class BrokerMnemopiEmbedHandle implements MnemopiEmbedWorkerHandle {
	readonly #messageHandlers = new Set<(message: MnemopiEmbedWorkerOutbound) => void>();
	readonly #errorHandlers = new Set<(error: Error) => void>();
	#client: DaemonBrokerClient | null = null;
	readonly #projectDir: string;

	constructor(projectDir: string) {
		this.#projectDir = projectDir;
	}

	send(message: MnemopiEmbedWorkerInbound): void {
		void this.#route(message);
	}

	onMessage(handler: (message: MnemopiEmbedWorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => {
			this.#messageHandlers.delete(handler);
		};
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => {
			this.#errorHandlers.delete(handler);
		};
	}

	ref(): void {}

	unref(): void {}

	/** Drop local state only: the broker-owned worker outlives this client. */
	async terminate(): Promise<void> {
		this.#messageHandlers.clear();
		this.#errorHandlers.clear();
		this.#client = null;
	}

	async #route(message: MnemopiEmbedWorkerInbound): Promise<void> {
		if (message.type === "ping") {
			this.#emit({ type: "pong", id: message.id });
			return;
		}
		let client = this.#client;
		if (!client) {
			try {
				client = await daemonClientForProject(this.#projectDir);
			} catch (error) {
				for (const handler of this.#errorHandlers) handler(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			this.#client = client;
		}
		try {
			if (message.type === "init") {
				await client.request({ op: "embed-init", model: message.model, cacheDir: message.cacheDir });
				this.#emit({ type: "ready", id: message.id });
			} else {
				const result = (await client.request({
					op: "embed",
					model: message.model,
					cacheDir: message.cacheDir,
					texts: message.texts,
					batchSize: message.batchSize,
				})) as Extract<DaemonRpcResult, { op: "embed" }>;
			}
		} catch (error) {
			this.#emit({ type: "error", id: message.id, error: error instanceof Error ? error.message : String(error) });
		}
	}

	#emit(message: MnemopiEmbedWorkerOutbound): void {
		for (const handler of this.#messageHandlers) handler(message);
	}
}

/**
 * Create the broker-routed embed worker for one project directory. Exported
 * for tests that drive the shared-worker lifecycle directly.
 */
export function createBrokerMnemopiEmbedWorker(projectDir: string): MnemopiEmbedWorkerHandle {
	return new BrokerMnemopiEmbedHandle(projectDir);
}

/**
 * Spawn the mnemopi embed worker for this process. Hosts that can run the CLI
 * worker (compiled binary, or a process with a self-dispatching CLI entry)
 * route every request through the project-shared broker — one worker per
 * project, owned by the broker's idle-grace lifecycle. Hosts without a CLI
 * entry (bun test, SDK embedding) keep the per-process spawn.
 */
export function defaultMnemopiEmbedWorkerSpawn(): MnemopiEmbedWorkerHandle {
	if (isCompiledBinary() || workerHostEntry() !== null) {
		return createBrokerMnemopiEmbedWorker(getProjectDir());
	}
	return spawnMnemopiEmbedWorker();
}

/**
 * Per-model wrapper produced by {@link MnemopiEmbedClient.initialize}.
 * `embed()` round-trips one batch of texts through the worker subprocess and
 * yields the resulting vectors in a single asynchronous batch — fastembed's
 * own iterator was emitting batches that we collect on the child side anyway,
 * and serializing per-batch over IPC would not improve throughput.
 */
export interface MnemopiSubprocessEmbeddingModel {
	embed(texts: string[], batchSize?: number): AsyncIterable<number[][]>;
}

/**
 * Upper bound on a steady-state embed IPC round-trip. Initialization is
 * intentionally exempt: bundled installs may spend several minutes installing
 * fastembed and bootstrapping the model, and killing that worker can strand the
 * runtime install lock. Once initialization succeeds, a longer embed stall
 * means a hung native runtime (issue #4792) that would otherwise pin whatever
 * awaits the embed — a turn's memory recall or the headless shutdown
 * consolidation — indefinitely, leaving the process alive with an unreaped
 * `__omp_worker_mnemopi_embed` child (issue #7352). On expiry the embed fails
 * and the worker is SIGKILL-reaped so the next request respawns a fresh one.
 */
const EMBED_REQUEST_TIMEOUT_MS = 120_000;

/** Race marker for {@link MnemopiEmbedClient.#awaitRequest}. */
const REQUEST_TIMED_OUT = Symbol("mnemopi.embed.timedOut");

export class MnemopiEmbedClient {
	#worker: MnemopiEmbedWorkerHandle | null = null;
	#workerPid: number | undefined;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#nextRequestId = 0;
	#refed = false;
	#spawnWorker: () => MnemopiEmbedWorkerHandle;
	#requestTimeoutMs: number;

	constructor(
		spawnWorker: () => MnemopiEmbedWorkerHandle = spawnMnemopiEmbedWorker,
		requestTimeoutMs: number = EMBED_REQUEST_TIMEOUT_MS,
	) {
		this.#spawnWorker = spawnWorker;
		this.#requestTimeoutMs = requestTimeoutMs;
	}

	/** PID of the backing worker when the handle tracks one (spawned subprocess or broker-owned). */
	get pid(): number | undefined {
		return this.#workerPid;
	}

	/**
	 * Load the named fastembed model inside the subprocess. Resolves to a
	 * thin wrapper whose `embed()` round-trips through the same worker, or
	 * `null` when the worker cannot init the model (missing peer, native
	 * load failure, etc.). Multiple calls with the same model reuse the
	 * single in-flight worker; calling with a different model loads it on
	 * the child without restarting the process.
	 */
	async initialize(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
	): Promise<MnemopiSubprocessEmbeddingModel | null> {
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.#addPending(id, { kind: "init", model, resolve });
			try {
				worker.send({ type: "init", id, model, cacheDir });
				const ok = await promise;
				if (!ok) return null;
			} finally {
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("mnemopi-embed: init failed", {
				model,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		return { embed: (texts, batchSize) => this.#streamEmbed(model, cacheDir, texts, batchSize) };
	}

	async terminate(): Promise<void> {
		const worker = this.#worker;
		this.#worker = null;
		this.#workerPid = undefined;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		for (const pending of this.#pending.values()) {
			if (pending.kind === "init") pending.resolve(false);
			else pending.resolve(new Error("mnemopi embed worker terminated"));
		}
		this.#pending.clear();
		this.#refed = false;
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	async #embed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): Promise<number[][]> {
		const worker = this.#ensureWorker();
		const id = String(++this.#nextRequestId);
		const { promise, resolve } = Promise.withResolvers<number[][] | Error>();
		this.#addPending(id, { kind: "embed", model, resolve });
		try {
			// Carry the (model, cacheDir) the wrapper was bound to in every
			// embed message: dispose + respawn between two embeds on the same
			// `LocalEmbeddingModel` handle would otherwise hit a fresh
			// worker's "embed before init" guard. Worker `ensureLoaded` is
			// idempotent so steady-state embeds pay no extra cost.
			worker.send({ type: "embed", id, model, cacheDir, texts, batchSize });
			const result = await this.#awaitRequest(promise);
			if (result instanceof Error) throw result;
			return result;
		} finally {
			this.#deletePending(id);
		}
	}

	/**
	 * Await one steady-state embed reply, bounded by
	 * {@link EMBED_REQUEST_TIMEOUT_MS}. The timeout timer is `unref`'d so a
	 * pending request has only the worker reference keeping the parent event
	 * loop alive. On expiry the wedged worker is SIGKILL-reaped via
	 * {@link terminate} — faulting any other in-flight request and letting the
	 * next call respawn a fresh child — before the request rejects, so a hung
	 * native runtime cannot pin a turn's recall or shutdown consolidation
	 * forever (issue #7352).
	 */
	async #awaitRequest<T>(promise: Promise<T>): Promise<T> {
		const { promise: timedOut, resolve: fire } = Promise.withResolvers<typeof REQUEST_TIMED_OUT>();
		const timer = setTimeout(() => fire(REQUEST_TIMED_OUT), this.#requestTimeoutMs);
		timer.unref();
		try {
			const winner = await Promise.race([promise, timedOut]);
			if (winner === REQUEST_TIMED_OUT) {
				void this.terminate();
				throw new Error("mnemopi embed worker request timed out");
			}
			return winner;
		} finally {
			clearTimeout(timer);
		}
	}

	async *#streamEmbed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): AsyncIterable<number[][]> {
		const vectors = await this.#embed(model, cacheDir, texts, batchSize);
		// Mnemopi's `collectMatrix` re-batches via async iteration anyway; yield
		// a single batch carrying the full result so the caller's drain loop
		// behaves identically to the in-process fastembed iterator (one yield
		// per `embed()` call) without paying extra IPC round-trips.
		yield vectors;
	}

	#ensureWorker(): MnemopiEmbedWorkerHandle {
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#workerPid = worker.pid;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	/** Register a pending request and keep the worker referenced while work is in flight. */
	#addPending(id: string, request: PendingRequest): void {
		this.#pending.set(id, request);
		this.#syncWorkerRef();
	}

	/** Drop a pending request and unref the worker once nothing is in flight. */
	#deletePending(id: string): void {
		if (this.#pending.delete(id)) this.#syncWorkerRef();
	}

	/**
	 * The embeddings subprocess is spawned unref'd so an idle interactive or
	 * daemon session never blocks exit. Keep it referenced only while a request
	 * is pending so short-lived print-mode commands cannot exit before recall
	 * receives the worker response (issue #12067).
	 */
	#syncWorkerRef(): void {
		const worker = this.#worker;
		if (!worker) return;
		const shouldRef = this.#pending.size > 0;
		if (shouldRef === this.#refed) return;
		this.#refed = shouldRef;
		if (shouldRef) worker.ref();
		else worker.unref();
	}

	#handleMessage(message: MnemopiEmbedWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#deletePending(message.id);
		if (message.type === "ready") {
			if (pending.kind === "init") pending.resolve(true);
			return;
		}
		if (message.type === "vectors") {
			if (pending.kind === "embed") pending.resolve(message.vectors);
			return;
		}
		logger.debug("mnemopi-embed: worker returned error", { error: message.error });
		if (pending.kind === "init") pending.resolve(false);
		else pending.resolve(new Error(message.error));
	}

	#handleWorkerError(error: Error): void {
		logger.warn("mnemopi-embed: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			if (pending.kind === "init") pending.resolve(false);
			else pending.resolve(error);
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const mnemopiEmbedClient = new MnemopiEmbedClient(defaultMnemopiEmbedWorkerSpawn);

export async function shutdownMnemopiEmbedClient(): Promise<void> {
	await mnemopiEmbedClient.terminate();
}

export async function smokeTestMnemopiEmbedWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createMnemopiEmbedSubprocess()), "mnemopi embed worker", timeoutMs);
}
