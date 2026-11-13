import { defineHandler } from 'nitro';
import { deps } from '../../lib/context.ts';
import { readPciTopology } from '../../lib/hardware/pci.ts';
import { reply } from '../../lib/http.ts';

/** Hardware graph (re-read on every call: the current link state changes with power states) and model placement. */
export default defineHandler(async () =>
  reply({ graph: await readPciTopology(), placement: deps().placement.current }),
);
