/**
 * Same-session replay payload extraction (TECHNICAL_SPECIFICATION.md §5).
 *
 * Closes the replay-payload portion of FR-5: on escalation the orchestrator
 * emits `replay(sessionID, model)`, and the adapter dispatches THE LAST REAL
 * USER MESSAGE back into the existing session under the new model. This module
 * is the pure function that finds and shapes that payload.
 *
 * Pure and SDK-free: it takes a loosely-typed message list (whatever the
 * adapter obtains from `session.messages()`) and returns a minimal payload, so
 * it stays unit-testable in isolation (NFR-1). It NEVER reaches for the current
 * clock, network, or `@opencode-ai/plugin`.
 */
/** One content part of a message. Shape is provider-defined; kept opaque. */
export type MessagePart = {
    type?: string;
    [key: string]: unknown;
};
/** The `info` envelope OpenCode attaches to each message. */
export type MessageInfo = {
    id?: unknown;
    role?: unknown;
    /** Optional agent/subagent the message ran under; echoed back on replay. */
    agent?: unknown;
    [key: string]: unknown;
};
/** One entry of a `session.messages()` result: `{ info, parts }`. */
export type SessionMessage = {
    info?: MessageInfo;
    parts?: unknown;
};
/** The minimal payload needed to replay the last user turn (FR-5, §5). */
export type UserPayload = {
    /** The user message's content parts, dispatched verbatim on replay. */
    parts: MessagePart[];
    /** The agent/subagent to preserve, when the original carried one. */
    agent?: string;
    /** The originating user message id (for provenance / de-dup). */
    messageID: string;
};
/**
 * Extract the payload of the LAST real user message from `messages`.
 *
 * Scans from the end and returns the first well-formed user message: one whose
 * `info.role === 'user'`, `info.id` is a non-empty string, and `parts` is a
 * non-empty array. Malformed trailing entries are skipped rather than fatal, so
 * a stray or partial record never blocks a legitimate earlier user turn.
 *
 * @returns the payload, or `null` when the input is not an array, is empty, or
 *          contains no well-formed user message.
 */
export declare function getLastUserPayload(messages: readonly SessionMessage[] | null | undefined): UserPayload | null;
