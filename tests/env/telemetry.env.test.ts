// Needs the local collector: npm run local:up.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { trace } from '@opentelemetry/api';
import { startTelemetry } from '../../src/lib/telemetry/start.ts';
import { registerTelemetry } from '../../src/lib/telemetry/register.ts';

const run = process.env.M14_ENV === '1' ? describe : describe.skip;

run('telemetry reaches the collector over OTLP', () => {
  it('a span created in the app shows up in the collector', async () => {
    process.env.PLATFORM = 'local';
    await registerTelemetry('m14-reference');      // through the seam, as the app's startup hook does
    const sdk = startTelemetry('m14-reference')!;  // already started: returns the same SDK
    const name = `intake.submit-${Date.now()}`;
    trace.getTracer('m14').startActiveSpan(name, (span) => { span.setAttribute('route', '/api/intake'); span.end(); });
    await sdk.shutdown(); // flushes
    await new Promise((r) => setTimeout(r, 1500));
    const logs = spawnSync('docker', ['logs', 'm14-otel'], { encoding: 'utf8' }); // the debug exporter writes to stderr
    const all = logs.stdout + logs.stderr;
    expect(all).toContain(name);
    expect(all).toContain('service.name: Str(m14-reference)');
  }, 30_000);
});
