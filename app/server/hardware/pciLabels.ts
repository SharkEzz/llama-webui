import { String as Str } from 'effect';
import { pipe } from 'effect/Function';

/** “600 Series Chipset PCIe Switch Upstream Port” → “600 Series Chipset”. */
export function chipsetLabel(name: string | null): string {
  if (name === null || name === '') return 'Chipset';
  const cut = pipe(
    name,
    Str.replace(/\s*(PCIe|PCI Express|PCI-E)\b.*$/i, ''),
    Str.replace(/\s*(Upstream|Downstream|Root)\s+Port.*$/i, ''),
    Str.trim,
  );
  return cut === '' ? 'Chipset' : cut;
}

/** “AMD Ryzen 5 9600X 6-Core Processor” → “AMD Ryzen 5 9600X”; “Intel(R) Core(TM) i7-12700K CPU @ 3.60GHz” → “Intel Core i7-12700K”. */
export function cpuLabel(model: string): string {
  const label = pipe(
    model,
    Str.replaceAll(/\((R|TM)\)/gi, ''),
    Str.replace(/\s+\d+-Core Processor$/i, ''),
    Str.replace(/\s+Processor$/i, ''),
    Str.replace(/\s+CPU\s*@.*$/i, ''),
    Str.replace(/\s+with Radeon Graphics$/i, ''),
    Str.replaceAll(/\s{2,}/g, ' '),
    Str.trim,
  );
  return label === '' ? 'CPU' : label;
}
