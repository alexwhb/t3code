import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useRateLimits } from "../rateLimitsStore";
import type { RateLimitWindow } from "../wsNativeApi";
const WEEKLY_DURATION_MINS = 10080; // 7 days
const SESSION_DURATION_MINS = 300; // 5 hours

function classifyWindow(window: RateLimitWindow): "weekly" | "session" | "unknown" {
  if (window.windowDurationMins === WEEKLY_DURATION_MINS) return "weekly";
  if (window.windowDurationMins === SESSION_DURATION_MINS) return "session";
  return "unknown";
}

function formatResetTime(resetAt: string): string {
  const reset = new Date(resetAt);
  const now = new Date();
  const diffMs = reset.getTime() - now.getTime();
  if (diffMs <= 0) return "resets soon";
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `resets in ${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

function classifyLimits(rateLimits: { primary?: RateLimitWindow; secondary?: RateLimitWindow }): {
  weekly?: RateLimitWindow;
  session?: RateLimitWindow;
} {
  const result: { weekly?: RateLimitWindow; session?: RateLimitWindow } = {};
  for (const w of [rateLimits.primary, rateLimits.secondary]) {
    if (!w) continue;
    const kind = classifyWindow(w);
    if (kind === "weekly") result.weekly = w;
    else if (kind === "session") result.session = w;
  }
  return result;
}

function UsageRow({ label, window }: { label: string; window: RateLimitWindow }) {
  const pctRemaining =
    window.maxRequests > 0 ? Math.round((window.remainingRequests / window.maxRequests) * 100) : 0;
  const pctUsed = 100 - pctRemaining;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{pctRemaining}% left</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-blue-500 transition-all duration-300"
          style={{ width: `${pctUsed}%` }}
        />
      </div>
      <span className="text-[11px] text-muted-foreground/60">
        {formatResetTime(window.resetAt)}
      </span>
    </div>
  );
}

function ProviderLimitCard({
  icon,
  name,
  weekly,
  session,
}: {
  icon: ReactNode;
  name: string;
  weekly?: RateLimitWindow | undefined;
  session?: RateLimitWindow | undefined;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!weekly && !session) return null;

  return (
    <div className="flex flex-col rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2"
      >
        {icon}
        <span className="text-sm font-semibold text-foreground">{name}</span>
        <ChevronDownIcon
          className={`ml-auto size-3.5 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded && (
        <div className="mt-3 flex flex-col gap-3">
          {session && <UsageRow label="Session" window={session} />}
          {weekly && <UsageRow label="Weekly" window={weekly} />}
        </div>
      )}
    </div>
  );
}

const CodexIcon = (
  <svg className="size-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="currentColor">
    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
  </svg>
);

export function WeeklyLimitPill() {
  const rateLimits = useRateLimits();
  const { weekly, session } = useMemo(() => {
    if (!rateLimits?.rateLimits) return {};
    return classifyLimits(rateLimits.rateLimits);
  }, [rateLimits]);

  return <ProviderLimitCard icon={CodexIcon} name="Codex" weekly={weekly} session={session} />;
}
