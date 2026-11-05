// src/platform/index.ts
// The only place that knows which platform is running. PLATFORM is set by the
// deployment (lesson 18); anything else fails at startup instead of guessing.
import type { Platform } from './types.ts';
import { localPlatform } from './local/index.ts';

const loaders: Record<string, () => Promise<Platform>> = {
  local: async () => localPlatform,
  azure: () => import('./azure/index.ts').then((m) => m.azurePlatform),      // lesson 34
  // aws: () => import('./aws/index.ts').then((m) => m.awsPlatform),         // lesson 35
  // google: () => import('./google/index.ts').then((m) => m.googlePlatform), // lesson 36
};

export async function getPlatform(name = process.env.PLATFORM): Promise<Platform> {
  const load = name ? loaders[name] : undefined;
  if (!load) throw new Error(`PLATFORM must be one of: ${Object.keys(loaders).join(', ')} (got ${name ?? 'nothing'})`);
  return load();
}
