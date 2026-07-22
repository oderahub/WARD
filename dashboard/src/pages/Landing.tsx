import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Desktop } from "@phosphor-icons/react";

/**
 * Landing — the front door at the bare site root. A single hero built around an
 * animated ASCII radar: the sweep pings five "contacts" (agent calls) as it
 * passes, clearing allowed selectors (green) and flagging denied ones (red).
 * That is the product thesis in one image — Sentry watching an agent and
 * admitting or rejecting each call.
 *
 * Themed off the app's own design tokens (--bg / --text / --accent / --success
 * / --danger), so it follows light (warm paper) and dark (espresso) exactly
 * like the rest of the dashboard. Deliberately provider-free otherwise: it
 * renders OUTSIDE the wallet / RPC / event-store tree (see main.tsx) so it
 * stays light and never triggers a wallet prompt. "Launch dashboard" navigates
 * into the app surface via the `app` query param.
 */

/** "View on GitHub" target. TODO(landing): point this at the real repository.
 *  There is no git remote configured in this workspace to infer it from. */
const GITHUB_URL = "https://github.com/Timidan/sentry-somnia";

/** The surfaces an integrator can reach Sentry through. Each links to the
 *  canonical "how do I use this" doc anchor (GitHub slug-rules: lowercased,
 *  spaces → hyphens, em-dash and punctuation stripped, leaving the surrounding
 *  hyphens — so a "## 20. CLI reference — every command" heading slugs as
 *  `20-cli-reference--every-command-and-flag`). */
const SURFACES: Array<{ label: string; href: string }> = [
  { label: "contracts",  href: `${GITHUB_URL}/blob/main/README.md#integrate-into-your-agent` },
  { label: "sdk",        href: `${GITHUB_URL}/blob/main/sdk/README.md` },
  { label: "react/vite", href: `${GITHUB_URL}/blob/main/sdk/README.md#react-sentry-somniareact` },
  { label: "cli",        href: `${GITHUB_URL}/blob/main/SKILL.md#20-cli-reference--every-command-and-flag` },
  { label: "tui",        href: `${GITHUB_URL}/blob/main/SKILL.md#23-operating-the-queue--tui--dashboard` },
  { label: "dashboard",  href: `${GITHUB_URL}/blob/main/README.md#using-the-dashboard` },
];

/** Official Sentry mark: a hexagonal gate with an arrow piercing it (a call
 *  passing the policy gate). Gate strokes inherit the text colour (so it themes
 *  light/dark); the arrow uses the app accent so the whole hero is one scheme.
 *  Geometry lifted from public/favicon.svg, minus the plate, so it scales crisp. */
function GateMark({ style }: { style?: CSSProperties }) {
  const arrow: CSSProperties = { stroke: "var(--accent)" };
  return (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" style={style} className="text-text" aria-hidden>
      <polygon
        points="32,8 54,20 54,44 32,56 10,44 10,20"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <rect x="29" y="22" width="6" height="20" fill="currentColor" rx="2" />
      <line x1="2" y1="32" x2="18" y2="32" style={arrow} strokeWidth="4" strokeDasharray="4 3" strokeLinecap="round" />
      <line x1="46" y1="32" x2="58" y2="32" style={arrow} strokeWidth="5" strokeLinecap="round" />
      <polygon points="62,32 56,28 56,36" style={{ fill: "var(--accent)" }} />
    </svg>
  );
}

/** Light → dark → system toggle. A self-contained version of the app's
 *  ThemeToggle without the Tooltip dependency (the landing renders outside the
 *  app's TooltipProvider). */
function ThemeButton() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const label = theme === "light" ? "Dark mode" : theme === "dark" ? "Follow system" : "Light mode";
  const Icon = !mounted ? Sun : theme === "system" ? Desktop : resolvedTheme === "dark" ? Sun : Moon;

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => setTheme(next)}
      className="inline-flex h-8 w-8 items-center justify-center text-text-muted transition-colors hover:text-accent"
    >
      <Icon size={15} weight="regular" aria-hidden />
    </button>
  );
}

interface Contact {
  /** radius as a fraction of the dial's vertical radius */
  r: number;
  /** angle in radians */
  a: number;
  /** allowed selector (green) vs denied (red) */
  allow: boolean;
  label: string;
}

const CONTACTS: Contact[] = [
  { r: 0.55, a: 0.45, allow: true, label: "bump()" },
  { r: 0.8, a: 1.85, allow: false, label: "reset()" },
  { r: 0.42, a: 3.05, allow: true, label: "swap()" },
  { r: 0.88, a: 4.05, allow: false, label: "withdraw()" },
  { r: 0.62, a: 5.25, allow: true, label: "mint()" },
];

/** Per-class glyph colour for the radar runs — all app tokens, so the dial
 *  themes with everything else. */
const RUN_STYLE: Record<string, string> = {
  lead: "color:var(--text)",
  g: "color:var(--success)",
  r: "color:var(--danger)",
  lbl: "color:var(--text-muted)",
};

function enterApp() {
  window.location.href = "?app=1";
}

export function Landing() {
  const radarRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = radarRef.current;
    if (!el) return;

    const W = 60;
    const H = 32;
    const cx = W / 2;
    const cy = H / 2;
    const RV = H * 0.47;
    const ASPECT = 0.5;
    const TWO_PI = Math.PI * 2;

    const dirDelta = (sweep: number, ang: number): number => {
      let d = (sweep - ang) % TWO_PI;
      if (d < 0) d += TWO_PI;
      return d;
    };

    const render = (t: number) => {
      const sweep = (t * 0.9) % TWO_PI;
      const ch: string[][] = [];
      const cl: string[][] = [];
      for (let y = 0; y < H; y++) {
        ch.push(new Array<string>(W).fill(" "));
        cl.push(new Array<string>(W).fill(""));
      }

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const dx = (x - cx) * ASPECT;
          const dy = y - cy;
          const d = Math.hypot(dx, dy);
          if (d > RV + 0.5) continue;
          let ang = Math.atan2(dy, dx);
          if (ang < 0) ang += TWO_PI;
          let c = " ";
          const ring =
            Math.abs(d - RV * 0.33) < 0.45 ||
            Math.abs(d - RV * 0.66) < 0.45 ||
            Math.abs(d - RV) < 0.45;
          const cross = (Math.abs(dx) < 0.35 || Math.abs(dy) < 0.35) && d < RV;
          if (ring) c = ".";
          if (cross) c = ":";
          const dd = dirDelta(sweep, ang);
          if (d <= RV) {
            if (dd < 0.06) {
              c = "#";
              cl[y][x] = "lead";
            } else if (dd < 0.35) c = "+";
            else if (dd < 0.8) c = ":";
            else if (dd < 1.4 && c === " ") c = ".";
          }
          ch[y][x] = c;
        }
      }

      const hy = Math.round(cy);
      const hx = Math.round(cx);
      if (hy >= 0 && hy < H && hx >= 0 && hx < W) ch[hy][hx] = "O";

      for (const k of CONTACTS) {
        const bx = Math.round(cx + (Math.cos(k.a) * k.r * RV) / ASPECT);
        const by = Math.round(cy + Math.sin(k.a) * k.r * RV);
        if (by < 0 || by >= H || bx < 0 || bx >= W) continue;
        const pinged = dirDelta(sweep, k.a) < 0.7;
        ch[by][bx] = k.allow ? "o" : "x";
        cl[by][bx] = pinged ? (k.allow ? "g" : "r") : "";
        if (pinged) {
          const lab = (k.allow ? "+ " : "- ") + k.label;
          const sx = bx + 2;
          if (sx + lab.length < W) {
            for (let j = 0; j < lab.length; j++) {
              const cur = ch[by][sx + j];
              if (cur === " " || cur === "." || cur === ":") {
                ch[by][sx + j] = lab[j];
                cl[by][sx + j] = "lbl";
              }
            }
          }
        }
      }

      let html = "";
      for (let y = 0; y < H; y++) {
        let line = "";
        let curCls: string | null = null;
        let buf = "";
        for (let x = 0; x < W; x++) {
          const cc = cl[y][x];
          let g = ch[y][x];
          if (g === "<") g = "&lt;";
          else if (g === ">") g = "&gt;";
          else if (g === "&") g = "&amp;";
          if (cc !== curCls) {
            if (buf) line += curCls ? `<span style="${RUN_STYLE[curCls]}">${buf}</span>` : buf;
            buf = g;
            curCls = cc;
          } else {
            buf += g;
          }
        }
        if (buf) line += curCls ? `<span style="${RUN_STYLE[curCls]}">${buf}</span>` : buf;
        html += line + "\n";
      }
      el.innerHTML = html;
    };

    let raf = 0;
    let t = 0;
    let last = 0;
    const loop = (ts: number) => {
      if (ts - last > 40) {
        last = ts;
        t += 0.05;
        render(t);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden bg-bg text-text">
      <div className="absolute right-5 top-5 z-10">
        <ThemeButton />
      </div>

      <div className="mx-auto grid min-h-screen max-w-[1240px] grid-cols-1 items-center gap-10 px-12 py-12 md:grid-cols-2">
        <div className="text-center md:text-left">
          <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-accent">
            Somnia Shannon
          </div>

          <div className="mt-4 flex items-center justify-center gap-4 md:justify-start">
            <GateMark style={{ width: "clamp(46px, 6vw, 84px)", height: "auto" }} />
            <span
              className="font-bold leading-[0.9] tracking-[-0.045em] text-text"
              style={{ fontSize: "clamp(54px, 8vw, 118px)" }}
            >
              SENTRY
            </span>
          </div>

          <p
            className="mx-auto mt-5 max-w-[34ch] font-medium leading-[1.45] text-text-muted md:mx-0"
            style={{ fontSize: "clamp(16px, 2vw, 21px)" }}
          >
            The on-chain policy gate for autonomous agents. Declare what your agent may do in one
            markdown file, enforced in the same transaction as the call.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-8 md:justify-start">
            <button
              type="button"
              onClick={enterApp}
              className="border-b-2 border-accent pb-2 font-mono text-[12px] uppercase tracking-[0.16em] text-text transition-colors"
            >
              launch dashboard →
            </button>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="border-b-2 border-transparent pb-2 font-mono text-[12px] uppercase tracking-[0.16em] text-text-muted transition-colors hover:border-accent hover:text-text"
            >
              github
            </a>
          </div>

          <div className="mt-10">
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-text-subtle">
              Integrate via
            </div>
            <div className="mt-2.5 font-mono text-[13px] text-text-muted">
              {SURFACES.map((s, i) => (
                <span key={s.label}>
                  {i > 0 && <span className="mx-1.5 text-accent">·</span>}
                  <a
                    href={s.href}
                    target="_blank"
                    rel="noreferrer"
                    className="border-b border-transparent transition-colors hover:border-accent hover:text-text"
                  >
                    {s.label}
                  </a>
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="relative flex justify-center">
          {/* Faint accent "scope" backdrop. In dark mode it reads as a glow; in
              light mode it gives the navy dial a screen to sit on so it does not
              disappear against the paper. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(58% 58% at 50% 50%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 72%)",
            }}
          />
          <pre
            ref={radarRef}
            aria-hidden
            className="relative font-mono text-[15px] font-medium leading-[17px] tracking-[1px] text-accent"
            style={{ whiteSpace: "pre" }}
          />
        </div>
      </div>
    </div>
  );
}
