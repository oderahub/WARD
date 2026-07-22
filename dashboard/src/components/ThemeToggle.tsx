import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Desktop } from "@phosphor-icons/react";

import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * ThemeToggle — Lane B chrome control.
 *
 * Cycles light → dark → system → light. The icon reflects the current
 * RESOLVED appearance (Sun when dark is active, Moon when light is active,
 * Desktop when following system). next-themes persists the choice to
 * localStorage; no extra wiring needed.
 */
export default function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // next-themes only knows the resolved theme client-side; render an
  // icon-shaped placeholder during SSR/hydration to avoid layout shift.
  useEffect(() => setMounted(true), []);

  const next =
    theme === "light" ? "dark" : theme === "dark" ? "system" : "light";

  const label =
    theme === "light"
      ? "Dark mode"
      : theme === "dark"
      ? "Follow system"
      : "Light mode";

  const Icon = !mounted
    ? Sun
    : theme === "system"
    ? Desktop
    : resolvedTheme === "dark"
    ? Sun
    : Moon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={() => setTheme(next)}
          className="inline-flex h-7 w-7 items-center justify-center text-text-muted transition-colors hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Icon size={14} weight="regular" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
