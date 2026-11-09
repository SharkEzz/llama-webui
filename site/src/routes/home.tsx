import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { FinalCta } from '@/landing/FinalCta';
import { HardwareBand } from '@/landing/HardwareBand';
import { Hero } from '@/landing/Hero';
import { BenchmarkSection } from '@/landing/sections/BenchmarkSection';
import { MonitoringSection } from '@/landing/sections/MonitoringSection';
import { ProfilesSection } from '@/landing/sections/ProfilesSection';
import { TuningSection } from '@/landing/sections/TuningSection';
import { WhySection } from '@/landing/WhySection';
import { pageMeta } from '@/lib/meta';

export const meta = () => pageMeta({ path: '' });

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <WhySection />
        <MonitoringSection />
        <TuningSection />
        <BenchmarkSection />
        <ProfilesSection />
        <HardwareBand />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
