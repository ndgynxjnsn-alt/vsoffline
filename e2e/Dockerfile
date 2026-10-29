# Headless desktop for running the real VS Code GUI against the gallery
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth libnss3 libnss3-tools libgtk-3-0 libxkbfile1 libsecret-1-0 libgbm1 libasound2 libxss1 \
      libdrm2 libxshmfence1 ca-certificates curl git procps util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
