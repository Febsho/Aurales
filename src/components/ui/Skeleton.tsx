interface SkeletonProps {
  className?: string
  variant?: 'rect' | 'circle' | 'text'
  width?: string | number
  height?: string | number
  count?: number
}

function SkeletonItem({ className = '', variant = 'rect', width, height }: Omit<SkeletonProps, 'count'>) {
  const variantClass = variant === 'circle' ? 'rounded-full' : variant === 'text' ? 'rounded-md' : 'rounded-xl'

  return (
    <div
      className={[
        'animate-pulse bg-white/[0.06]',
        variantClass,
        className,
      ].join(' ')}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
      }}
    />
  )
}

export default function Skeleton({ count = 1, ...props }: SkeletonProps) {
  if (count <= 1) return <SkeletonItem {...props} />

  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonItem key={i} {...props} />
      ))}
    </div>
  )
}

export function PosterSkeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`flex-shrink-0 ${className}`}>
      <div className="w-36 aspect-[2/3] rounded-2xl bg-white/[0.06] animate-pulse" />
      <div className="h-3 bg-white/[0.04] rounded-md mt-2.5 w-24" />
      <div className="h-3 bg-white/[0.04] rounded-md mt-1.5 w-12" />
    </div>
  )
}

export function LandscapeSkeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`flex-shrink-0 ${className}`}>
      <div className="w-72 aspect-video rounded-2xl bg-white/[0.06] animate-pulse" />
    </div>
  )
}

export function MediaRowSkeleton({
  title,
  layout = 'poster',
  count = 6,
}: {
  title?: string
  layout?: 'poster' | 'landscape'
  count?: number
}) {
  const isPoster = layout === 'poster'

  return (
    <div className="mb-8 animate-pulse select-none">
      <div className="flex items-center justify-between px-6 mb-4">
        {title ? (
          <h2 className="text-xl font-bold tracking-tight text-white/20">{title}</h2>
        ) : (
          <div className="h-5 w-40 bg-white/[0.06] rounded-lg" />
        )}
      </div>
      <div className="flex gap-4 overflow-x-hidden px-6 pb-2">
        {Array.from({ length: count }).map((_, i) =>
          isPoster ? <PosterSkeleton key={i} /> : <LandscapeSkeleton key={i} />,
        )}
      </div>
    </div>
  )
}
