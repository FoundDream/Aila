import { useEffect } from 'react'

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum)

export function usePageMotion(): void {
  useEffect(() => {
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const parallaxElements = Array.from(document.querySelectorAll<HTMLElement>('[data-parallax]'))
    let animationFrame = 0

    const syncMotion = () => {
      animationFrame = 0

      if (motionPreference.matches || window.innerWidth < 768) {
        for (const element of parallaxElements) {
          element.style.removeProperty('--parallax-y')
        }
        return
      }

      const viewportCenter = window.innerHeight / 2
      for (const element of parallaxElements) {
        const bounds = element.getBoundingClientRect()
        const elementCenter = bounds.top + bounds.height / 2
        const distance = (elementCenter - viewportCenter) / window.innerHeight
        const offset = clamp(distance * -28, -18, 18)
        element.style.setProperty('--parallax-y', `${offset.toFixed(2)}px`)
      }
    }

    const requestSync = () => {
      if (animationFrame === 0) {
        animationFrame = window.requestAnimationFrame(syncMotion)
      }
    }

    syncMotion()
    window.addEventListener('scroll', requestSync, { passive: true })
    window.addEventListener('resize', requestSync)
    motionPreference.addEventListener('change', requestSync)

    return () => {
      if (animationFrame !== 0) {
        window.cancelAnimationFrame(animationFrame)
      }
      window.removeEventListener('scroll', requestSync)
      window.removeEventListener('resize', requestSync)
      motionPreference.removeEventListener('change', requestSync)
    }
  }, [])
}
