export type SessionOperationName = "attach" | "resume" | "prompt" | "command" | "approve" | "cancel" | "detach";

export interface SessionAttachment {
	readonly name: string;
	readonly path: string;
	readonly mimeType?: string;
}

export interface SessionAttachRequest {
	readonly sessionId?: string;
	readonly resume?: boolean;
	readonly cwd: string;
	readonly since?: number;
}

export interface SessionResumeRequest {
	readonly sessionId: string;
	readonly since: number;
}

export interface SessionPromptRequest {
	readonly text: string;
	readonly ownerId: string;
	readonly cwd?: string;
	readonly attachments?: readonly SessionAttachment[];
}

export interface SessionCommandRequest {
	readonly command: string;
	readonly ownerId: string;
	readonly args?: Readonly<Record<string, unknown>>;
}

export interface SessionApproveRequest {
	readonly id: string;
	readonly approved: boolean;
	readonly ownerId: string;
}

export interface SessionCancelRequest {
	readonly ownerId: string;
	readonly reason?: string;
}

export interface SessionDetachRequest {
	readonly ownerId: string;
}

export interface SessionAttachResponse {
	readonly sessionId: string;
	readonly slotId: string;
	readonly clientId: string;
	readonly ownerId: string;
	readonly since: number;
	readonly events: readonly SessionEvent[];
	readonly history: readonly unknown[];
	readonly isObserver: boolean;
}

export interface SessionResumeResponse {
	readonly sessionId: string;
	readonly since: number;
	readonly events: readonly SessionEvent[];
	readonly history: readonly unknown[];
	readonly isObserver: boolean;
}

export interface SessionPromptResponse {
	readonly accepted: boolean;
	readonly turnId: string;
	readonly turnOwner: string;
	readonly since: number;
}

export interface SessionCommandResponse {
	readonly accepted: boolean;
	readonly handled: boolean;
	readonly since: number;
}

export interface SessionApproveResponse {
	readonly success: boolean;
}

export interface SessionCancelResponse {
	readonly success: boolean;
	readonly turnId?: string;
}

export interface SessionDetachResponse {
	readonly success: boolean;
}

export interface SessionAttach {
	readonly op: "attach";
	readonly request: SessionAttachRequest;
}
export interface SessionResume {
	readonly op: "resume";
	readonly request: SessionResumeRequest;
}
export interface SessionPrompt {
	readonly op: "prompt";
	readonly request: SessionPromptRequest;
}
export interface SessionCommand {
	readonly op: "command";
	readonly request: SessionCommandRequest;
}
export interface SessionApprove {
	readonly op: "approve";
	readonly request: SessionApproveRequest;
}
export interface SessionCancel {
	readonly op: "cancel";
	readonly request: SessionCancelRequest;
}
export interface SessionDetach {
	readonly op: "detach";
	readonly request: SessionDetachRequest;
}

export type SessionOperation =
	| SessionAttach
	| SessionResume
	| SessionPrompt
	| SessionCommand
	| SessionApprove
	| SessionCancel
	| SessionDetach;

export type SessionResponse =
	| { readonly op: "attach"; readonly response: SessionAttachResponse }
	| { readonly op: "resume"; readonly response: SessionResumeResponse }
	| { readonly op: "prompt"; readonly response: SessionPromptResponse }
	| { readonly op: "command"; readonly response: SessionCommandResponse }
	| { readonly op: "approve"; readonly response: SessionApproveResponse }
	| { readonly op: "cancel"; readonly response: SessionCancelResponse }
	| { readonly op: "detach"; readonly response: SessionDetachResponse };

export type SessionErrorCode =
	| "session_not_found"
	| "journal_missing"
	| "not_owner"
	| "turn_busy"
	| "turn_not_found"
	| "invalid_cwd"
	| "needs_full_reattach"
	| "invalid_since"
	| "internal_error";

export interface SessionError {
	readonly ok: false;
	readonly op?: SessionOperationName;
	readonly error: SessionErrorCode;
	readonly message: string;
}

export type SessionOperationResult = ({ readonly ok: true } & SessionResponse) | SessionError;

export type SessionEventType = "rpc" | "system" | "error" | "snapshot";

/** A serialized AgentSession event. The host keeps the payload opaque to the viewer. */
export interface SessionEvent {
	readonly seq: number;
	readonly type: SessionEventType;
	readonly data: unknown;
	readonly timestamp: number;
}

export interface SessionEventNotification {
	readonly event: "session-event";
	readonly notification: {
		readonly op: "event";
		readonly event: SessionEvent;
	};
}

export function isSessionError(value: SessionOperationResult): value is SessionError {
	return value.ok === false;
}

export function parseSessionOperation(value: unknown): SessionOperation {
	if (!isRecord(value) || typeof value.op !== "string" || !isRecord(value.request)) {
		throw new Error("Invalid session operation");
	}
	const request = value.request;
	switch (value.op) {
		case "attach":
			return {
				op: "attach",
				request: {
					sessionId: optionalString(request.sessionId, "sessionId"),
					resume: optionalBoolean(request.resume, "resume"),
					cwd: stringValue(request.cwd, "cwd"),
					since: optionalNonNegativeInteger(request.since, "since") ?? 0,
				},
			};
		case "resume":
			return {
				op: "resume",
				request: {
					sessionId: stringValue(request.sessionId, "sessionId"),
					since: nonNegativeInteger(request.since, "since"),
				},
			};
		case "prompt":
			return {
				op: "prompt",
				request: {
					text: stringValue(request.text, "text"),
					ownerId: stringValue(request.ownerId, "ownerId"),
					cwd: optionalString(request.cwd, "cwd"),
					attachments: optionalAttachments(request.attachments),
				},
			};
		case "command":
			return {
				op: "command",
				request: {
					command: stringValue(request.command, "command"),
					ownerId: stringValue(request.ownerId, "ownerId"),
					args: optionalRecord(request.args, "args"),
				},
			};
		case "approve":
			return {
				op: "approve",
				request: {
					id: stringValue(request.id, "id"),
					approved: booleanValue(request.approved, "approved"),
					ownerId: stringValue(request.ownerId, "ownerId"),
				},
			};
		case "cancel":
			return {
				op: "cancel",
				request: {
					ownerId: stringValue(request.ownerId, "ownerId"),
					reason: optionalString(request.reason, "reason"),
				},
			};
		case "detach":
			return { op: "detach", request: { ownerId: stringValue(request.ownerId, "ownerId") } };
		default:
			throw new Error(`Unknown session operation: ${value.op}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}
function optionalString(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : stringValue(value, label);
}
function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
	return value;
}
function optionalBoolean(value: unknown, label: string): boolean | undefined {
	return value === undefined ? undefined : booleanValue(value, label);
}
function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`${label} must be a non-negative integer`);
	return value;
}
function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
	return value === undefined ? undefined : nonNegativeInteger(value, label);
}
function optionalRecord(value: unknown, label: string): Readonly<Record<string, unknown>> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}
function optionalAttachments(value: unknown): readonly SessionAttachment[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("attachments must be an array");
	return value.map((item, index) => {
		if (!isRecord(item)) throw new Error(`attachments[${index}] must be an object`);
		return {
			name: stringValue(item.name, `attachments[${index}].name`),
			path: stringValue(item.path, `attachments[${index}].path`),
			mimeType: optionalString(item.mimeType, `attachments[${index}].mimeType`),
		};
	});
}
