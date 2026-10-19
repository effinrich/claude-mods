export const TOOLS = ['codex', 'gemini', 'cursor', 'copilot'];
export const DEFAULT_CONFIG = {
    mods: { guardrails: true, compactionGuard: true, contextAudit: true },
    stopGate: true,
    draftSpecs: true,
    writingGate: true,
    allowImports: [],
    checkTimeoutMs: 10 * 60_000,
    debug: false,
};
export const ALLOW = { kind: 'allow' };
export const str = (value) => (typeof value === 'string' ? value : undefined);
export const rec = (value) => typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
