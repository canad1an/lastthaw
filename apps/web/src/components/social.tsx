import type { ReactNode } from "react";

/** Where the game lives off-site. Add X, Facebook and the rest here when the beta opens up; every place that shows icons reads this list. */
export const SOCIAL_LINKS: Array<{ name: string; href: string; icon: ReactNode }> = [
  { name: "Discord", href: "https://discord.gg/5MTKKnh33U", icon: <DiscordIcon /> },
];

export function DiscordIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M19.6 5.3A17 17 0 0 0 15.4 4l-.2.4a15.6 15.6 0 0 1 3.9 1.9 13.6 13.6 0 0 0-14.2 0A15.6 15.6 0 0 1 8.8 4.4L8.6 4a17 17 0 0 0-4.2 1.3C1.7 9.3 1 13.2 1.4 17a17.2 17.2 0 0 0 5.2 2.6l1.1-1.8a11 11 0 0 1-1.7-.8l.4-.3a12.3 12.3 0 0 0 11.2 0l.4.3a11 11 0 0 1-1.7.8l1.1 1.8a17.2 17.2 0 0 0 5.2-2.6c.5-4.4-.8-8.3-3-11.7ZM8.7 14.7c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1Zm6.6 0c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1Z" />
    </svg>
  );
}

/** Icon-only links, used in the top bar and the footer. */
export function SocialIcons({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-3 ${className}`}>
      {SOCIAL_LINKS.map((s) => (
        <a key={s.name} href={s.href} target="_blank" rel="noreferrer" className="text-slate-400 transition hover:text-white" title={s.name} aria-label={s.name}>
          {s.icon}
        </a>
      ))}
    </span>
  );
}
