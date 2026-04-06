import type { ReactElement } from 'react'

import type { ImageAttachment } from '@/types/chat'

function attachmentSrc(image: ImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`
}

export function ImageAttachmentStrip({
  images,
  onRemove,
  size = 'message',
}: {
  images: ImageAttachment[]
  onRemove?: (index: number) => void
  size?: 'composer' | 'message'
}): ReactElement | null {
  if (images.length === 0) {
    return null
  }

  const imageClassName =
    size === 'composer' ? 'h-20 w-20 rounded-lg object-cover' : 'h-32 w-32 rounded-lg object-cover'

  return (
    <div className="flex flex-wrap gap-2">
      {images.map((image, index) => (
        <div
          key={image.id}
          className="group relative overflow-hidden rounded-xl border border-[var(--term-border)] bg-[var(--term-surface-soft)]"
          title={image.name ?? 'image attachment'}
        >
          <img
            className={imageClassName}
            src={attachmentSrc(image)}
            alt={image.name ?? 'attachment'}
          />
          {image.name && (
            <div className="max-w-32 truncate border-t border-[var(--term-border)] px-2 py-1 text-[10px] text-[var(--term-dim)]">
              {image.name}
            </div>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(index)}
              className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[10px] text-white opacity-0 transition group-hover:opacity-100"
              aria-label={`Remove ${image.name ?? `image ${index + 1}`}`}
              title="Remove image"
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
