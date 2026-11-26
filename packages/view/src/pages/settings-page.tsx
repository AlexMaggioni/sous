import type { ReactNode } from "react";
import { useOverview, useSettings } from "../api/queries.ts";
import { HARNESS_NAME } from "../lists/catalog-rows.ts";
import { setThemePref, useThemePref } from "../shell/prefs.ts";
import { ShortcutList } from "../shell/shortcuts-dialog.tsx";
import type { ThemePref } from "../theme.ts";
import { Button } from "../ui/button.tsx";
import { CommandBox } from "../ui/copy.tsx";
import { Facts, Path } from "../ui/facts.tsx";
import { Refusal } from "../ui/refusal.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { LoadingRows } from "../ui/skeleton.tsx";
import { Page } from "./page.tsx";

// Settings: what sous serve reads, as it reads it, and the theme of this page. Read only. The
// config changes in config.json and the accounts with `sous account`.

/** What each key of config.json does, from the guide. A key sous adds later shows without a line. */
const CONFIG_KEYS: Record<string, string> = {
  maxAgents: "Agents running at once, across all runs. Others wait in a queue.",
  defaultPlace: "Where a run works when its workflow names no place: worktree, folder or none.",
  defaultModel: "The model of a step that names none.",
  defaultHarness: "Claude Code or Codex, for a step that names neither.",
  rulesyncGlobal: "The global rulesync folder, read after the project's.",
  notify: "On macOS, a notice when a run asks something, ends or pauses.",
  keepDays: "The service removes runs older than this. Unset keeps them all.",
  retries: "Tries again for an agent step that fails and sets no retries of its own.",
  budgetTokens: "The tokens each go of a run may spend, unless the run gives its own budget.",
};

const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

function Part({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium">{title}</h2>
      {note && <p className="mt-0.5 max-w-[42em] text-muted">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ThemePart() {
  const theme = useThemePref();
  return (
    <Part title="Theme" note="This browser keeps it. System follows the light or dark mode of your computer.">
      <Segmented<ThemePref>
        label="Theme"
        value={theme}
        onChange={setThemePref}
        options={[
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />
    </Part>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  const overview = useOverview().data;

  if (settings.isPending || settings.isError) {
    return (
      <Page title="Settings">
        <div className="mt-8">
          {settings.isPending ? <LoadingRows label="Loading the settings" rows={6} /> : <Refusal error={settings.error} action={<Button onClick={() => settings.refetch()}>Try again</Button>} />}
        </div>
        <ThemePart />
      </Page>
    );
  }

  const { home, config, service, accounts } = settings.data;
  const keys = [...new Set([...Object.keys(CONFIG_KEYS), ...Object.keys(config)])];
  return (
    <Page title="Settings">
      <p className="mt-1 max-w-[42em] text-md text-muted">What sous serve reads, as it reads it. This page changes nothing here but its own theme.</p>

      <Part title="sous">
        <Facts
          layout="row"
          items={[
            { label: "Home", value: <Path path={home} /> },
            ...(overview ? [{ label: "Version", value: overview.version }] : []),
            ...(overview ? [{ label: "Project", value: overview.project.name, sub: overview.projects.length > 1 ? `${overview.projects.length} projects known` : undefined }] : []),
            { label: "Service", value: service.running ? "Running" : "Off", sub: service.running && service.pid ? `pid ${service.pid}` : undefined },
          ]}
        />
        {!service.running && (
          <div className="mt-4 max-w-[42em]">
            <p className="mb-2 text-muted">The service starts schedules when they are due, resumes runs paused at a usage limit, and removes old runs. It is off.</p>
            <CommandBox command="sous daemon start" />
          </div>
        )}
      </Part>

      <Part title="Config" note="From config.json in the home, with the defaults sous fills in.">
        <dl className="max-w-[720px] border-t border-line">
          {keys.map((key) => (
            <div key={key} className="grid grid-cols-[180px_minmax(0,1fr)] gap-x-4 border-b border-line py-2 max-[699px]:grid-cols-1">
              <dt className="font-mono text-xs leading-5">{key}</dt>
              <dd className="min-w-0">
                <span className={key in config ? "[overflow-wrap:anywhere]" : "text-muted"}>{key in config ? show(config[key]) : "Not set"}</span>
                {CONFIG_KEYS[key] && <span className="block text-xs text-muted">{CONFIG_KEYS[key]}</span>}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-3">
          <Path path={`${home}/config.json`} />
        </div>
      </Part>

      <Part title="Accounts" note={<>The accounts each program runs as. <code>sous account use</code> switches them.</>}>
        {accounts.length ? (
          <ul className="max-w-[720px] border-t border-line">
            {accounts.map((a) => (
              <li key={`${a.program}:${a.name}`} className="flex items-center gap-3 border-b border-line py-2">
                <span className="w-28 flex-none text-muted">{HARNESS_NAME[a.program]}</span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{a.name}</span>
                {a.current && <span className="flex-none text-xs text-muted">In use</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">No accounts yet. Each program runs as you are logged in to it.</p>
        )}
      </Part>

      <ThemePart />

      <Part title="Keyboard shortcuts" note="Letter keys wait while you type in a field. ? shows this list from any page.">
        <div className="max-w-[560px]">
          <ShortcutList />
        </div>
      </Part>
    </Page>
  );
}
