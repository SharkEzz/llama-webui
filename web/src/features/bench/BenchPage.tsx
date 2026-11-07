import { useEffect } from 'react';
import { startBenchSync, useBench } from '@/lib/bench';
import { BenchForm } from './BenchForm';
import { BenchHistory } from './BenchHistory';
import { BenchLiveCard } from './BenchLiveCard';

/** Benchmark: form and current run at the top, history and comparison below. */
export function BenchPage() {
  useEffect(() => {
    startBenchSync();
    void useBench.getState().load();
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-3xl font-semibold tracking-tight">Benchmark</h1>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <BenchForm />
        <BenchLiveCard />
      </div>
      <BenchHistory />
    </div>
  );
}
