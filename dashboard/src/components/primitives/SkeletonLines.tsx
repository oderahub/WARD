export interface SkeletonLinesProps {
  count: number;
  className?: string;
}

export function SkeletonLines({ count, className }: SkeletonLinesProps) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`shimmer h-4 rounded-md ${className ?? ''}`} />
      ))}
    </div>
  );
}
