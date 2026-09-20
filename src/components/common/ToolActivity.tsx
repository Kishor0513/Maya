export function ToolActivity({ activity }: { activity: string | null }) {
  if (!activity) return null;
  return (
    <div role="status" className="mx-auto flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-3.5 py-1.5 text-xs text-zinc-300">
      <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" />
      {activity}
    </div>
  );
}
