# syntax=docker/dockerfile:1.7
FROM golang:1.26-alpine AS builder
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Stamp version + commit into the binary so the startup banner is honest
# about which build is running. CI passes these via --build-arg; local
# builds fall through to the "dev"/"unknown" defaults in main.go.
ARG VERSION=dev
ARG COMMIT=unknown
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}" \
    -o /out/mnemo-server ./cmd/mnemo-server

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /out/mnemo-server /mnemo-server
USER nonroot:nonroot
EXPOSE 8080
# Distroless has no shell/wget/curl; the binary acts as its own probe
# via the `healthz` subcommand (see cmd/mnemo-server/main.go).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD ["/mnemo-server", "healthz"]
ENTRYPOINT ["/mnemo-server"]
