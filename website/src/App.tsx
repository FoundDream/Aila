import { Footer } from './components/Footer'
import { Hero } from './components/Hero'
import { Navigation } from './components/Navigation'
import { ProductPreview } from './components/ProductPreview'
import {
  ArchitectureSection,
  FeaturesSection,
  FinalCta,
  ModelsSection,
  SecuritySection,
  WhySection,
} from './components/Sections'
import { usePageMotion } from './hooks/usePageMotion'
import { useReveal } from './hooks/useReveal'

export default function App() {
  useReveal()
  usePageMotion()

  return (
    <div className="home-page">
      <Navigation />
      <main id="top">
        <Hero />
        <ProductPreview />
        <WhySection />
        <ArchitectureSection />
        <ModelsSection />
        <FeaturesSection />
        <SecuritySection />
        <FinalCta />
      </main>
      <Footer />
    </div>
  )
}
