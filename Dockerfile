# Build Vue once and embed its output in the Go server.
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY web ./web
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS build
WORKDIR /src
ARG TARGETOS TARGETARCH
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
COPY --from=frontend /src/internal/server/static ./internal/server/static
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /wb-pulse ./cmd/server

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /wb-pulse /wb-pulse
EXPOSE 8080
USER 65532:65532
HEALTHCHECK NONE
ENTRYPOINT ["/wb-pulse"]
