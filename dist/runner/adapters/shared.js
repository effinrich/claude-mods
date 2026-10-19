import { isAbsolute, join } from 'node:path';
import { str } from "../types.js";
export const NOTHING = { stdout: '', stderr: '', exitCode: 0 };
export const json = (value) => ({ stdout: `${JSON.stringify(value)}\n`, stderr: '', exitCode: 0 });
export const absolute = (path, cwd) => (isAbsolute(path) ? path : join(cwd, path));
// First string field present, for tools whose argument names are not documented.
export const firstString = (record, keys) => {
    for (const key of keys) {
        const value = str(record[key]);
        if (value !== undefined)
            return value;
    }
    return undefined;
};
export const parseMaybeJson = (value) => {
    if (typeof value === 'object' && value !== null)
        return value;
    if (typeof value !== 'string')
        return {};
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    }
    catch {
        return {};
    }
};
