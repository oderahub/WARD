/**
 * Ward brand mark — transparent lockup (shield + arrow + wordmark),
 * theme-aware so it sits flush on the page with no plate behind it.
 *
 * Both assets are keyed off the original navy plate of
 * `design/logo/ward.png` and cropped tight to the artwork:
 *   - `/ward-on-light.png` — ink artwork, shown on the light (paper) theme
 *   - `/ward-on-dark.png`  — white artwork, shown on the dark (espresso) theme
 * The blue arrow is preserved in both. Native aspect ~3.4:1.
 */
interface Props {
  /** Pixel height. Width derives from native aspect (~3.4:1). */
  size?: number;
  className?: string;
}

export function Logo({ size = 32, className }: Props) {
  const style = { height: size, width: "auto" } as const;
  return (
    <>
      <img
        src="/ward-on-light.png"
        alt="Ward"
        style={style}
        className={`block dark:hidden ${className ?? ""}`}
      />
      <img
        src="/ward-on-dark.png"
        alt="Ward"
        aria-hidden
        style={style}
        className={`hidden dark:block ${className ?? ""}`}
      />
    </>
  );
}
