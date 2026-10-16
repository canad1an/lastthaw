import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Button({ className = "", variant = "primary", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const base = "inline-flex min-h-11 items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0";
  const styles = {
    primary: "bg-sky-500 text-slate-950 hover:bg-sky-400",
    ghost: "border border-slate-700 text-slate-200 hover:bg-slate-800",
    danger: "bg-rose-600 text-white hover:bg-rose-500",
  }[variant];
  return <button className={`${base} ${styles} ${className}`} {...rest} />;
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-500 ${className}`}
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
  return <div className={`rounded-lg border border-slate-800 bg-slate-900/70 p-4 ${className}`}>{children}</div>;
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
