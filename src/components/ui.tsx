import { useLayoutEffect, useRef, type ComponentProps, type MouseEventHandler, type ReactNode, type RefObject } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60";

// Every variant keeps the same 1px border box and h-8, so buttons and text
// fields line up at exactly the same height.
const variants: Record<Variant, string> = {
  primary: "border-transparent bg-accent text-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.3)] hover:bg-accent-strong active:brightness-90",
  secondary: "border-transparent bg-fill text-label hover:bg-fill-strong/40 active:bg-fill-strong/60",
  ghost: "border-transparent text-label-2 hover:bg-fill hover:text-label active:bg-fill-strong/40",
  danger: "border-transparent bg-danger text-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.3)] hover:brightness-95 active:brightness-90",
};

export function Button({ variant = "secondary", className = "", ...props }: ComponentProps<"button"> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-3.5 text-sm font-medium transition-colors ${focusRing} disabled:cursor-not-allowed disabled:opacity-40 ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

/**
 * Inset grouped list (the System Settings pattern): a small secondary title
 * above one rounded surface whose rows are separated by hairlines.
 */
export function Group({ title, footer, children, className = "" }: { title?: ReactNode; footer?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      {title && <h2 className="mb-1.5 px-4 text-xs font-medium text-label-2">{title}</h2>}
      <div className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-surface shadow-material">{children}</div>
      {footer && <p className="mt-1.5 px-4 text-xs text-label-2">{footer}</p>}
    </section>
  );
}

/** One row of a [`Group`]: label (and hint) on the left, control on the right. */
export function Row({ label, hint, children, as: Tag = "label" }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; as?: "label" | "div" }) {
  return (
    <Tag className="flex min-h-11 items-center justify-between gap-4 px-4 py-2">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-label-2">{hint}</span>}
      </span>
      {children && <span className="flex shrink-0 items-center">{children}</span>}
    </Tag>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <Row label={label} hint={hint}>
      <span className="relative inline-flex">
        <input type="checkbox" role="switch" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-[22px] w-[38px] rounded-full bg-fill-strong transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent/60" />
        <span className="absolute left-[2px] top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform peer-checked:translate-x-4" />
      </span>
    </Row>
  );
}

/** Stacked label + control, for free-form inputs. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block py-1.5">
      <span className="mb-1 block text-xs font-medium text-label-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-label-2">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "h-8 w-full rounded-lg border border-hairline bg-field px-2.5 text-sm shadow-[inset_0_1px_1px_rgba(0,0,0,0.05)] outline-none placeholder:text-label-2/70 focus:outline-2 focus:outline-offset-0 focus:outline-accent/60 aria-[invalid=true]:border-danger";

/** Segmented control on native radio inputs (arrow keys work out of the box). */
export function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  const name = `seg-${label}`;
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-fill p-0.5">
      {options.map((o) => (
        <label key={String(o.value)} className="relative cursor-pointer">
          <input type="radio" name={name} className="peer sr-only" checked={o.value === value} onChange={() => onChange(o.value)} />
          <span className="block rounded-md px-3 py-[3px] text-sm font-medium text-label-2 transition-colors peer-checked:bg-segment-selected peer-checked:text-label peer-checked:shadow-[0_0.5px_1px_rgba(0,0,0,0.12),0_1px_3px_rgba(0,0,0,0.08)] peer-focus-visible:outline-2 peer-focus-visible:outline-accent/60">
            {o.label}
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * Native modal dialog: focus moves inside and stays there, Escape calls
 * `onCancel`, and the page behind (including the DeX input sink) is inert.
 * Mounting opens it; the owner closes it by unmounting.
 */
export function Dialog({ labelledBy, role, initialFocus, closeOnBackdrop, onCancel, className = "", children }: {
  labelledBy: string;
  role?: "alertdialog";
  initialFocus?: RefObject<HTMLElement | null>;
  closeOnBackdrop?: boolean;
  onCancel: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Layout effect: opened before the first paint, so it never flashes in the page flow.
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    initialFocus?.current?.focus();
    return () => dialog.close();
  }, [initialFocus]);
  return (
    <dialog
      ref={ref}
      role={role}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        // The owner decides; the element closes when it unmounts.
        e.preventDefault();
        onCancel();
      }}
      // Only the backdrop hits the <dialog> itself: its children fill the box.
      // preventDefault: the click must not move the focus that closing just
      // handed back (to the DeX input sink) onto <body>, where the IME is off.
      onMouseDown={closeOnBackdrop ? (e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onCancel();
      } : undefined}
      className={`m-auto shadow-popover outline-none backdrop:bg-black/40 ${className}`}
    >
      {children}
    </dialog>
  );
}

/** Dark material shared by the dialogs over the DeX video. */
export const darkPanelClass = "theme-dark rounded-2xl border border-white/[0.08] bg-[#1e1e1e] text-white backdrop:backdrop-blur-sm";

/** Icon-only close button for dialog and panel headers. */
export function CloseButton({ onClick, onMouseDown }: { onClick: () => void; onMouseDown?: MouseEventHandler<HTMLButtonElement> }) {
  return (
    <Button variant="ghost" onClick={onClick} onMouseDown={onMouseDown} aria-label="閉じる" title="閉じる" className="shrink-0 px-2">
      <Icon name="close" />
    </Button>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "green" | "blue" | "amber" | "red" }) {
  const tones = {
    neutral: "bg-fill text-label-2",
    green: "bg-ok/12 text-ok",
    blue: "bg-accent/12 text-accent",
    amber: "bg-warn/12 text-warn",
    red: "bg-danger/12 text-danger",
  };
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

/** Minimal inline icons (Fluent-like strokes). */
export function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

type IconName =
  | "back"
  | "home"
  | "recents"
  | "fullscreen"
  | "exitFullscreen"
  | "settings"
  | "stats"
  | "power"
  | "volume"
  | "mute"
  | "usb"
  | "wifi"
  | "phone"
  | "log"
  | "close"
  | "upload"
  | "refresh"
  | "more"
  | "apps"
  | "help";

const ICONS: Record<IconName, ReactNode> = {
  back: <path d="M15 5l-7 7 7 7" />,
  home: <circle cx="12" cy="12" r="6" />,
  recents: <path d="M7 5v14M12 5v14M17 5v14" />,
  fullscreen: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  exitFullscreen: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </>
  ),
  stats: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  power: <path d="M12 3v8M6.3 6.3a8 8 0 1011.4 0" />,
  volume: <path d="M4 9v6h4l5 4V5L8 9H4zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" />,
  mute: <path d="M4 9v6h4l5 4V5L8 9H4zM17 9l5 6M22 9l-5 6" />,
  usb: <path d="M12 3v14M9 6l3-3 3 3M7 11v3l5 3 5-3v-3M12 17v4" />,
  wifi: <path d="M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0M12 19.5h.01" />,
  phone: (
    <>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </>
  ),
  log: <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />,
  refresh: <path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  apps: <path d="M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z" />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.8 9a2.3 2.3 0 114.2 1.3c-.7.8-2 1-2 2.7M12 17h.01" /></>,
};
