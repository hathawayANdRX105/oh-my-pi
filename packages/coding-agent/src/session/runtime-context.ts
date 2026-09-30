import { AsyncLocalStorage } from "node:async_hooks";
import type { EventBus } from "../utils/event-bus";
import type { Settings } from "../config/settings";
import type { IrcBus } from "../irc/bus";
import type { AgentLifecycleManager } from "../registry/agent-lifecycle";
import type { AgentRegistry } from "../registry/agent-registry";
import type { SessionManager } from "./session-manager";

export interface SessionRuntimeContext {
	readonly agentRegistry: AgentRegistry;
	readonly agentLifecycleManager: AgentLifecycleManager;
	readonly ircBus: IrcBus;
	readonly eventBus: EventBus;
	readonly subagentEventBus: EventBus;
	readonly settings: Settings;
	readonly sessionManager: SessionManager;
}

const activeRuntime = new AsyncLocalStorage<SessionRuntimeContext>();

export function currentSessionRuntimeContext(): SessionRuntimeContext | undefined {
	return activeRuntime.getStore();
}

export function runInSessionRuntime<T>(context: SessionRuntimeContext, callback: () => T): T {
	return activeRuntime.run(context, callback);
}
