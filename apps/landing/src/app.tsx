import { Navbar } from './components/navbar';
import { CrossPlatform } from './sections/cross-platform';
import { CTA } from './sections/cta';
import { Features } from './sections/features';
import { Hero } from './sections/hero';
import { HowItWorks } from './sections/how-it-works';
import { Technology } from './sections/technology';

export function App(): React.JSX.Element {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <Navbar />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Technology />
        <CrossPlatform />
        <CTA />
      </main>
    </div>
  );
}
