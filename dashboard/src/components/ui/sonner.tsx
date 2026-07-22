import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * Lane B Toaster — bottom-right, paper-elev surface with hairline rule and
 * 4px radius. No bold colored borders for success/error/warn; callers compose
 * with a leading Phosphor icon + ink color text inside the toast body.
 *
 * Theme follows the active next-themes value so toasts match the rest of the
 * chrome in light/dark/system.
 */
const Toaster = (props: ToasterProps) => {
  const { theme = "system" } = useTheme()
  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position="bottom-right"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-surface-elev group-[.toaster]:text-text group-[.toaster]:border group-[.toaster]:border-rule group-[.toaster]:rounded-[4px]",
          description: "group-[.toast]:text-text-muted",
          actionButton:
            "group-[.toast]:bg-accent group-[.toast]:text-white group-[.toast]:rounded-[4px]",
          cancelButton:
            "group-[.toast]:bg-transparent group-[.toast]:text-text-muted",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
