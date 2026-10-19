const LIMITS = {
    originalTask: 4000,
    ask: 500,
    asks: 8,
    plan: 6000,
    todos: 30,
    files: 25,
};
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// The summary a compaction leaves opens the next transcript as a user message.
const SUMMARY_OPENING = /^This session is being continued from a previous conversation/;
const clip = (text, max) => text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} more characters]`;
const isTypedPrompt = (message) => message.role === 'user' &&
    message.text.trim() !== '' &&
    (message.toolResults ?? []).length === 0 &&
    !SUMMARY_OPENING.test(message.text);
const asString = (value) => typeof value === 'string' && value.trim() !== '' ? value : undefined;
const todoLine = (todo) => {
    if (typeof todo !== 'object' || todo === null)
        return undefined;
    const { content, subject, status } = todo;
    const label = asString(content) ?? asString(subject);
    if (label === undefined)
        return undefined;
    return `[${asString(status) ?? 'pending'}] ${label}`;
};
export const firstTypedPrompt = (messages) => messages.find(isTypedPrompt)?.text;
export const buildHandoff = (messages, knownOriginalTask) => {
    const prompts = messages.filter(isTypedPrompt).map(m => m.text);
    const toolUses = messages.flatMap(m => m.toolUses);
    const plan = toolUses
        .filter(use => use.tool === 'ExitPlanMode')
        .map(use => asString(use.input.plan))
        .filter((text) => text !== undefined)
        .at(-1);
    const lastTodoWrite = toolUses.filter(use => use.tool === 'TodoWrite').at(-1);
    const todos = Array.isArray(lastTodoWrite?.input.todos)
        ? lastTodoWrite.input.todos.map(todoLine).filter((line) => line !== undefined)
        : [];
    const touched = toolUses
        .filter(use => EDIT_TOOLS.has(use.tool) && use.isError !== true)
        .map(use => asString(use.input.file_path) ?? asString(use.input.notebook_path))
        .filter((path) => path !== undefined);
    return {
        originalTask: knownOriginalTask ?? prompts[0],
        recentAsks: prompts.slice(-LIMITS.asks).map(text => clip(text, LIMITS.ask)),
        plan,
        todos: todos.slice(0, LIMITS.todos),
        filesTouched: [...new Set(touched.reverse())].slice(0, LIMITS.files),
    };
};
export const renderHandoff = (handoff, savedAt, project) => {
    const sections = [
        `# Session handoff: ${project}`,
        `Saved ${savedAt.toISOString()} by compaction-guard. Load it in a fresh session with /handoff-load.`,
    ];
    const add = (title, body) => {
        if (body !== undefined && body.trim() !== '')
            sections.push(`## ${title}\n\n${body.trim()}`);
    };
    const list = (items) => items.length === 0 ? undefined : items.map(item => `- ${item.replace(/\n+/g, ' ')}`).join('\n');
    add('Original task', handoff.originalTask && clip(handoff.originalTask, LIMITS.originalTask));
    add('Plan', handoff.plan && clip(handoff.plan, LIMITS.plan));
    add('Todos', list(handoff.todos));
    add('Recent asks (oldest first)', list(handoff.recentAsks));
    add('Files touched (newest first)', list(handoff.filesTouched));
    return `${sections.join('\n\n')}\n`;
};
