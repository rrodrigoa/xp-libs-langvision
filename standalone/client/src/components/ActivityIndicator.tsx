import { Hourglass } from "lucide-react";

export function ActivityIndicator({
  label,
  progress,
  size = 14,
  className = "",
  testId
}: {
  label?: string;
  progress?: number;
  size?: number;
  className?: string;
  testId?: string;
}) {
  const measuredProgress = Number.isFinite(progress) ? Math.max(0, Math.min(100, Number(progress))) : undefined;
  return (
    <span
      className={`chronus-activity-indicator${className ? ` ${className}` : ""}`}
      data-testid={testId}
      data-progress={measuredProgress ?? ""}
      role="status"
      aria-label={label ?? "Working"}
      title={label ?? "Working"}
    >
      <Hourglass className="chronus-activity-hourglass" size={size} aria-hidden="true" />
      {label ? <span>{label}</span> : null}
      {measuredProgress !== undefined ? <strong>{Math.round(measuredProgress)}%</strong> : null}
    </span>
  );
}
