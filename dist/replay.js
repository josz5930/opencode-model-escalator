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
function isUserRole(role) {
    return role === 'user';
}
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
export function getLastUserPayload(messages) {
    if (!Array.isArray(messages) || messages.length === 0)
        return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg === null || typeof msg !== 'object')
            continue;
        const info = msg.info;
        if (info === null || typeof info !== 'object')
            continue;
        if (!isUserRole(info.role))
            continue;
        const id = info.id;
        if (typeof id !== 'string' || id.length === 0)
            continue;
        const parts = msg.parts;
        if (!Array.isArray(parts) || parts.length === 0)
            continue;
        const payload = {
            parts: parts,
            messageID: id,
        };
        if (typeof info.agent === 'string' && info.agent.length > 0) {
            payload.agent = info.agent;
        }
        return payload;
    }
    return null;
}
//# sourceMappingURL=replay.js.map