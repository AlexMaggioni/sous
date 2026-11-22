// `orc doctor`: the installed Claude Code and Codex that the steps run on, how orc found them, and
// whether orc talks to them. The talk check lists each program's models, which sends no prompt.
// `--live` runs one tiny step on each, which uses the account a little. Both run on the account
// orc uses for new runs.

import { checkPrograms, DEFAULT, describeAccount, folderText, homePaths, loadConfig } from "@orchestrator/engine";

export interface DoctorOptions {
  live?: boolean;
  /** With live, check this model only, such as codex/gpt-6.1-sol. */
  model?: string;
  json?: boolean;
  out?: (line: string) => void;
}

const SOURCE: Record<string, string> = {
  variable: "from its variable",
  config: "from config.json",
  path: "found on PATH",
  "usual folder": "found in a usual install folder",
};

export async function doctor(options: DoctorOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const paths = homePaths();
  const reports = await checkPrograms(paths, loadConfig(paths), { ...(options.live ? { live: true } : {}), ...(options.model ? { model: options.model } : {}) });

  const failed = reports.some((report) => report.problem || report.talks === false || report.live?.error);
  if (options.json) {
    out(JSON.stringify(reports, null, 2));
    return failed ? 1 : 0;
  }
  for (const report of reports) {
    out(`${report.name}${report.version ? ` ${report.version}` : ""}`);
    if (!report.path) {
      out(`  missing   ${report.problem}`);
      continue;
    }
    out(`  program   ${report.path}, ${SOURCE[report.source!] ?? report.source}`);
    for (const path of report.skipped) out(`  skipped   ${path}, a wrapper script`);
    for (const other of report.others) out(`  also      ${other.path}${other.version ? ` ${other.version}` : ""}, not used`);
    if (report.problem) {
      out(`  version   ${report.problem}`);
      continue;
    }
    const named = report.account !== DEFAULT;
    const account = `${describeAccount(report.program, { name: report.account, folder: report.folder })}${named ? `, settings in ${folderText(report.program, report.folder)}` : ""}`;
    out(`  account   ${account} (${report.program === "claude" ? "orc account lists the others" : `set ${report.variable} where orc starts to use another`})`);
    if (report.talks) {
      out(`  talks     yes`);
      if (report.models?.length) out(`  models    ${report.models.join(", ")}`);
    } else {
      out(`  talks     no: ${report.talkError}`);
    }
    if (report.live) out(report.live.error ? `  live      ${report.live.model} failed: ${report.live.error}` : `  live      ${report.live.model} answered "${report.live.answer}"`);
  }
  return failed ? 1 : 0;
}
