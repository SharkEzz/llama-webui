import { SiteFooter } from '@/components/SiteFooter';
import { SiteHeader } from '@/components/SiteHeader';
import { Hero } from '@/landing/Hero';
import { pageMeta } from '@/lib/meta';

export const meta = () => pageMeta({ path: '' });

// The sections below the hero (why, feature bentos, hardware, final call to action) come in milestone M4.
export default function Home() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
      </main>
      <SiteFooter />
    </>
  );
}
