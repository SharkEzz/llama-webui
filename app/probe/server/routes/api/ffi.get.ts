import { defineHandler } from 'nitro';

export default defineHandler(async () => {
  const ffi = await import('node:ffi');
  return { dlopen: typeof (ffi as { dlopen?: unknown }).dlopen };
});
