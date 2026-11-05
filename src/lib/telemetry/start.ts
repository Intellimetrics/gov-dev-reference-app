// src/lib/telemetry/start.ts
// One telemetry path on every platform (lesson 16): the app speaks OTLP to a collector
// at OTEL_EXPORTER_OTLP_ENDPOINT and knows nothing else. Where spans go from there is
// the collector's configuration, which each platform lesson supplies (34 Azure Monitor,
// 35 X-Ray, 36 Cloud Trace). Locally the collector just prints them.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

let sdk: NodeSDK | undefined;

export function startTelemetry(serviceName: string): NodeSDK | undefined {
  if (sdk) return sdk;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    console.warn('telemetry disabled: OTEL_EXPORTER_OTLP_ENDPOINT is not set');
    return undefined;
  }
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    traceExporter: new OTLPTraceExporter(), // reads OTEL_EXPORTER_OTLP_ENDPOINT itself
  });
  sdk.start();
  return sdk;
}
