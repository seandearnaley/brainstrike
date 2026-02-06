import { Navbar } from './components/navbar';
import { Architecture } from './sections/architecture';
import { GetStarted } from './sections/get-started';
import { Hero } from './sections/hero';
import { ProductDemo } from './sections/product-demo';
import { WhyLocalFirst } from './sections/why-local-first';

export function App(): React.JSX.Element {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <Navbar />
      <main>
        <Hero />
        <ProductDemo />
        <WhyLocalFirst />
        <Architecture />
        <GetStarted />
      </main>
    </div>
  );
}
