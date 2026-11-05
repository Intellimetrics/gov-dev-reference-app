// src/lib/telemetry/register.ts
// What the app's startup hook calls (lesson 16: Next.js src/instrumentation.ts register()).
// It goes through the seam, so each platform starts its own telemetry: local and the
// collector-based platforms call startTelemetry() (OTLP); Azure starts its in-process distro.
import { getPlatform } from '../../platform/index.ts';

export async function registerTelemetry(serviceName: string): Promise<void> {
  const platform = await getPlatform();
  await platform.telemetry.start(serviceName);
}
