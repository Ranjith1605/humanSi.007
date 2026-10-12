# HumanSI Synergy fleet server: one static binary with the site embedded.
#
#   docker build -t humansi .
#   docker run -p 8080:8080 -v humansi-data:/data -e HUMANSI_SECRET=... humansi
#
# Ollama on the host (Docker Desktop): add -e HUMANSI_OLLAMA_URL=http://host.docker.internal:11434

FROM golang:1.24-alpine AS build
WORKDIR /src
# Standard library only: no go.sum, nothing to download.
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/humansi ./cmd/humansi \
 && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/humansi /humansi
# The board lives in /data. Created here and owned by the nonroot user so a
# fresh named volume inherits a directory the server can write.
COPY --from=build --chown=nonroot:nonroot /out/data /data
ENV HUMANSI_ADDR=:8080 \
    HUMANSI_DATA_DIR=/data
VOLUME /data
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/humansi"]
