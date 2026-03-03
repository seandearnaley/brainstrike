import { generateFragments } from '@/lib/fragments';
import { LandingPageClient } from './page-client';

export default function LandingPage() {
  const fragments = generateFragments();

  return <LandingPageClient fragments={fragments} />;
}
