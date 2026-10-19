import { rec, str } from "../types.js";
import { absolute, firstString, json } from "./shared.js";
// https://cursor.com/docs/agent/hooks. The preToolUse `Write` input is not documented, so the likely
// field names are tried and an edit with no recognisable path is let through; afterFileEdit still records it.
const parse = (event, payload) => {
    const sessionId = str(payload.conversation_id) ?? str(payload.session_id) ?? 'default';
    const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
    const cwd = str(payload.cwd) ?? str(roots[0]) ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd();
    const base = { sessionId, cwd };
    switch (event) {
        case 'beforeShellExecution': {
            const command = str(payload.command);
            return command === undefined ? { kind: 'ignore' } : { ...base, kind: 'shell', command };
        }
        case 'preToolUse': {
            const input = rec(payload.tool_input);
            const tool = str(payload.tool_name);
            if (tool === 'Shell') {
                const command = str(input.command);
                return command === undefined ? { kind: 'ignore' } : { ...base, kind: 'shell', command };
            }
            if (tool !== 'Write' && tool !== 'Delete')
                return { kind: 'ignore' };
            const path = firstString(input, ['file_path', 'path', 'target_file', 'filePath']);
            if (path === undefined)
                return { kind: 'ignore' };
            const newText = firstString(input, ['contents', 'content', 'new_string', 'code_edit']) ?? '';
            const oldText = firstString(input, ['old_string']);
            return { ...base, kind: 'edit', edits: [{ path: absolute(path, cwd), newText, oldText }] };
        }
        case 'afterFileEdit': {
            const path = str(payload.file_path);
            return path === undefined ? { kind: 'ignore' } : { ...base, kind: 'edited', paths: [absolute(path, cwd)] };
        }
        case 'beforeSubmitPrompt':
            return { ...base, kind: 'prompt', text: str(payload.prompt) ?? '' };
        case 'stop':
            return { ...base, kind: 'stop', isRepeat: typeof payload.loop_count === 'number' && payload.loop_count > 0 };
        case 'preCompact':
            return { ...base, kind: 'precompact' };
        case 'sessionStart':
            return { ...base, kind: 'sessionStart', source: undefined };
        default:
            return { kind: 'ignore' };
    }
};
export const cursor = {
    capabilities: { promptContext: false },
    parse,
    // `{}` makes no decision, so Cursor's own approval flow still applies; an explicit allow would skip it.
    emit: (_event, verdict) => {
        switch (verdict.kind) {
            case 'deny':
                return json({ continue: true, permission: 'deny', user_message: verdict.reason.split('\n')[0], agent_message: verdict.reason });
            case 'continue':
                return json({ followup_message: verdict.reason });
            case 'context':
                return json({ additional_context: verdict.text });
            case 'notice':
            case 'allow':
                return json({});
        }
    },
};
