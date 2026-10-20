import { ADAPTERS } from "./adapters/index.js";
import { runCrew } from "./crew.js";
import { capturePayload, isDebugOn } from "./debug.js";
import { decide, projectRoot, runChecks } from "./engine.js";
import { loadConfig, log, pruneOldState } from "./state.js";
import { rec, TOOLS } from "./types.js";
const readStdin = async () => {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
};
const isTool = (value) => TOOLS.includes(value);
// `claude-mods-hook check [dir]`: the checks /ship and /checks run, outside any hook.
const runChecksCommand = (dir) => {
    const failure = runChecks(loadConfig(), projectRoot(dir));
    process.stdout.write(failure === undefined ? '✓ checks pass\n' : `checks fail\n${failure}\n`);
    return failure === undefined ? 0 : 1;
};
const runHook = async (tool, event) => {
    const adapter = ADAPTERS[tool];
    const raw = await readStdin();
    const payload = rec(raw.trim() === '' ? {} : JSON.parse(raw));
    const now = new Date();
    const config = loadConfig();
    if (isDebugOn(config))
        capturePayload(tool, event, payload, now);
    pruneOldState(now.getTime());
    const verdict = await decide(tool, adapter.capabilities, config, adapter.parse(event, payload), now);
    const reply = adapter.emit(event, verdict);
    if (reply.stdout !== '')
        process.stdout.write(reply.stdout);
    if (reply.stderr !== '')
        process.stderr.write(reply.stderr);
    return reply.exitCode;
};
const main = async () => {
    const [first, second] = process.argv.slice(2);
    if (first === 'check')
        return runChecksCommand(second ?? process.cwd());
    if (first === 'crew')
        return runCrew(process.argv.slice(3), process.cwd(), line => console.log(line));
    if (!isTool(first) || second === undefined) {
        process.stderr.write(`usage: claude-mods-hook <${TOOLS.join('|')}> <event> | check [dir] | crew <command> ...\n`);
        return 0;
    }
    try {
        return await runHook(first, second);
    }
    catch (error) {
        // A broken hook must never wedge the agent: log it and let the action through.
        log(`${first} ${second} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        return 0;
    }
};
process.exitCode = await main();
