// Package observability wires the OTel SDK so a downstream OTLP
// collector (and any Prometheus behind it) receives mnemo metrics.
// Tracing is intentionally absent: the deploy stack has no trace
// backend wired up yet.
package observability

import (
	"context"
	"fmt"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
)

// exportInterval matches a typical Prometheus evaluation_interval (15s).
// Tightening it wastes bandwidth without helping alert latency;
// loosening it delays detection.
const exportInterval = 15 * time.Second

// InitMetrics builds an OTLP/HTTP MeterProvider, sets it as the
// global, and returns it so main can Shutdown on signal. The exporter
// reads OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_PROTOCOL
// from the environment. OTEL_SERVICE_NAME feeds the Resource and
// shows up as the `service_name` label downstream.
func InitMetrics(ctx context.Context) (*sdkmetric.MeterProvider, error) {
	exporter, err := otlpmetrichttp.New(ctx)
	if err != nil {
		return nil, fmt.Errorf("otlpmetrichttp.New: %w", err)
	}
	res, err := resource.New(ctx,
		resource.WithFromEnv(),
		resource.WithHost(),
		resource.WithProcess(),
	)
	if err != nil {
		return nil, fmt.Errorf("resource.New: %w", err)
	}
	provider := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(
			sdkmetric.NewPeriodicReader(exporter,
				sdkmetric.WithInterval(exportInterval),
			),
		),
	)
	otel.SetMeterProvider(provider)
	return provider, nil
}
