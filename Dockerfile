# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS build
WORKDIR /src
ARG TARGETOS TARGETARCH
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /wb-pulse ./cmd/server

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /wb-pulse /wb-pulse
EXPOSE 8080
USER 65532:65532
HEALTHCHECK NONE
ENTRYPOINT ["/wb-pulse"]
