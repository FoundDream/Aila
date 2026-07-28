import { useLayoutEffect } from 'react'

export function useReveal(): void {
  useLayoutEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('.reveal'))
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    document.documentElement.classList.add('reveal-on')

    const siblingIndexes = new Map<Element, number>()
    for (const element of elements) {
      const parent = element.parentElement
      if (!parent) {
        continue
      }

      const index = siblingIndexes.get(parent) ?? 0
      element.style.setProperty('--reveal-delay', `${Math.min(index * 70, 280)}ms`)
      siblingIndexes.set(parent, index + 1)
    }

    if (prefersReducedMotion) {
      for (const element of elements) {
        element.classList.add('is-visible')
      }
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible')
            observer.unobserve(entry.target)
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    )

    for (const element of elements) {
      observer.observe(element)
    }

    return () => observer.disconnect()
  }, [])
}
