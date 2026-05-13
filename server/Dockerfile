# syntax=docker/dockerfile:1.7
FROM golang:1.26-alpine AS builder
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/mnemo-server ./cmd/mnemo-server

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /out/mnemo-server /mnemo-server
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/mnemo-server"]
