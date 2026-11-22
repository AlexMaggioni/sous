import type {ChildProcess, SpawnOptions} from "node:child_process";
import {spawn} from "node:child_process";

export function runCodexCli(codexPath: string | undefined, args: Array<string>): Promise<number> {
    const child = spawnCodexCli(codexPath, args);

    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code, signal) => {
            if (signal) {
                process.kill(process.pid, signal);
                return;
            }
            resolve(code ?? 1);
        });
    });
}

function spawnCodexCli(codexPath: string | undefined, args: Array<string>): ChildProcess {
    const options: SpawnOptions = {
        env: process.env,
        stdio: "inherit",
    };

    // No bundled Codex. Without CODEX_PATH, run the codex installed on PATH.
    return spawn(codexPath ?? "codex", args, {...options, shell: process.platform === "win32"});
}
