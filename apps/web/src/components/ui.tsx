import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";

export function Button({ className = "", variant = "primary", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const base = "inline-flex min-h-11 items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0";
  const styles = {
    primary: "btn-ember font-semibold",
    ghost: "btn-ice",
    danger: "bg-rose-600 text-white hover:bg-rose-500",
  }[variant];
  return <button className={`${base} ${styles} ${className}`} {...rest} />;
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-500 ${className}`}
      {...rest}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {children}
    </label>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`glass rounded-lg p-4 ${className}`}>{children}</div>;
}

/**
 * The top of a card, pinned while the card scrolls past: it stays at the top of the column until the whole card has
 * gone by. Spans the card's padding so rows slide under it edge to edge.
 */
export function CardHeader({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div data-card-header className={`sticky top-0 z-10 -mx-4 -mt-4 rounded-t-lg border-b border-slate-800/70 bg-[#07111f] px-4 pb-2 pt-4 ${className}`}>{children}</div>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="text-sm text-rose-400">{children}</p>;
}

export function fmt(n: number, digits = 0): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function signed(n: number, digits = 1): string {
  const s = fmt(Math.abs(n), digits);
  return n >= 0 ? `+${s}` : `-${s}`;
}

/** The game's own yes-or-no box, in place of the browser's: a title, a line or two, and two buttons. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel = "Yes",
  cancelLabel = "Keep it",
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm" onClick={onCancel} role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-950 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        {children && <div className="mt-2 space-y-2 text-sm text-slate-300">{children}</div>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={pending}>
            {pending ? "…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
