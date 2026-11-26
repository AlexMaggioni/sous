import { Link } from "@tanstack/react-router";
import { Monitor, Moon, PanelLeft, Settings, Sun } from "lucide-react";
import { SECTIONS, sectionOf } from "../sections.ts";
import { nextThemePref, type ThemePref } from "../theme.ts";
import { Tip } from "../ui/tooltip.tsx";
import { setThemePref, useThemePref } from "./prefs.ts";
import { useSidebarContext } from "./use-sidebar.ts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const THEME_LABEL: Record<ThemePref, string> = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };

const railButton =
  "relative grid size-9 flex-none place-items-center rounded-md text-icon transition-[background-color,color,scale] motion-safe:active:scale-[0.94] hover:bg-hover hover:text-fg aria-[current=page]:bg-selected aria-[current=page]:text-fg max-[699px]:size-10";

/** The rail's copper count, at the top right of the Runs icon. The link's name says it in words. */
function Badge({ count }: { count: number }) {
  return (
    <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 h-4 min-w-4 rounded-full bg-needs px-1 text-center text-xs leading-4 font-medium text-on-ink tabular-nums">
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Hides and shows the list column, as ⌘B or Ctrl+B does. It opens the list over the page under 1100px. */
function SidebarToggle() {
  const { open, toggle } = useSidebarContext();
  const label = `${open ? "Hide" : "Show"} sidebar`;
  return (
    <Tip side="right" text={<>{label}<span className="ml-2 opacity-70">{isMac ? "⌘B" : "Ctrl+B"}</span></>}>
      <button type="button" aria-label={label} aria-keyshortcuts={isMac ? "Meta+B" : "Control+B"} aria-expanded={open} onClick={toggle} className={`${railButton} min-[700px]:mb-2`}>
        <PanelLeft size={18} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </Tip>
  );
}

/**
 * The rail: the sidebar button, one icon per section, with the count of runs that need the person
 * on Runs, then settings and the theme at the bottom. A top bar under 700px. It sits above the list
 * column, which slides out from behind it.
 */
export function Rail({ pathname, needs }: { pathname: string; needs: number }) {
  const current = sectionOf(pathname);
  const theme = useThemePref();
  const ThemeIcon = THEME_ICON[theme];

  return (
    <nav
      aria-label="Sections"
      className="relative z-40 flex flex-none items-center gap-1 bg-rail px-2 py-2 max-[699px]:h-12 max-[699px]:justify-between max-[699px]:border-b max-[699px]:border-line max-[699px]:px-1 max-[699px]:py-1 min-[700px]:w-[var(--rail)] min-[700px]:flex-col"
    >
      <SidebarToggle />
      {SECTIONS.map((s) => {
        const count = s.id === "runs" ? needs : 0;
        return (
          <Tip
            key={s.id}
            side="right"
            text={
              <>
                {s.label}
                <span className="ml-2 opacity-70">g {s.key}</span>
              </>
            }
          >
            <Link to={s.path} aria-label={count ? `${s.label}, ${count === 1 ? "1 needs you" : `${count} need you`}` : s.label} aria-current={current?.id === s.id ? "page" : undefined} className={railButton}>
              <s.icon size={18} strokeWidth={1.5} aria-hidden="true" />
              {count > 0 && <Badge count={count} />}
            </Link>
          </Tip>
        );
      })}
      <div className="flex-1 max-[699px]:hidden" />
      <Tip text="Settings" side="right">
        <Link to="/settings" aria-label="Settings" aria-current={pathname === "/settings" ? "page" : undefined} className={railButton}>
          <Settings size={18} strokeWidth={1.5} aria-hidden="true" />
        </Link>
      </Tip>
      <Tip text={`${THEME_LABEL[theme]}. Press to change.`} side="right">
        <button type="button" aria-label={THEME_LABEL[theme]} className={railButton} onClick={() => setThemePref(nextThemePref(theme))}>
          <ThemeIcon size={18} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </Tip>
    </nav>
  );
}
