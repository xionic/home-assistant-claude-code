ARG BUILD_FROM
FROM ${BUILD_FROM}

ARG BUILD_ARCH

# Install system packages (no build tools — all binaries are pre-compiled)
RUN apk add --no-cache \
    bash \
    curl \
    git \
    jq \
    nano \
    nodejs \
    npm \
    python3 \
    py3-pip \
    py3-yaml \
    tree \
    uv

# Install server Node.js dependencies (includes Agent SDK with bundled CLI binary)
COPY server/package.json /opt/server/package.json
RUN cd /opt/server && npm install --omit=dev

# Ensure the correct musl platform binary is installed for the target arch.
# npm may install the glibc variant during cross-compilation; force the musl one.
RUN case "${BUILD_ARCH}" in \
    aarch64) SDK_PKG="@anthropic-ai/claude-agent-sdk-linux-arm64-musl" ;; \
    amd64)   SDK_PKG="@anthropic-ai/claude-agent-sdk-linux-x64-musl" ;; \
    *) echo "ERROR: Unsupported arch ${BUILD_ARCH}" && exit 1 ;; \
    esac \
    && SDK_VER=$(node -e "console.log(require('/opt/server/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version)") \
    && npm install --prefix /opt/server --no-save "${SDK_PKG}@${SDK_VER}" \
    && npm cache clean --force

# Expose the Agent SDK's bundled Claude binary as the system `claude` command.
# This gives terminal access without duplicating the ~240MB binary.
RUN case "${BUILD_ARCH}" in \
    aarch64) SDK_BIN="/opt/server/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude" ;; \
    amd64)   SDK_BIN="/opt/server/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude" ;; \
    esac \
    && ln -sf "$SDK_BIN" /usr/local/bin/claude

# Download ha-ws-client binary (gives Claude a CLI tool to query HA WebSocket API)
RUN case "${BUILD_ARCH}" in \
    aarch64) HA_ARCH="linux-arm64" ;; \
    amd64)   HA_ARCH="linux-amd64" ;; \
    esac \
    && curl -fL \
       "https://github.com/schoolboyqueue/home-assistant-blueprints/releases/download/v1.8.1/ha-ws-client-${HA_ARCH}" \
       -o /usr/local/bin/ha-ws-client \
    && chmod +x /usr/local/bin/ha-ws-client

RUN mkdir -p /config/claude-config
WORKDIR /config

# Copy application files
# (bump SCRIPTS_VER to force Docker layer re-copy on next build)
ARG SCRIPTS_VER=5
COPY server/index.js /opt/server/index.js
COPY frontend/ /opt/frontend/
COPY plugins/ /opt/plugins/
COPY scripts/ /opt/scripts/
COPY run.sh /run.sh

RUN chmod +x /run.sh \
    && chmod +x /opt/scripts/*.sh \
    && chmod +x /opt/plugins/homeassistant-config/hooks/*.sh

# ha-lovelace: WebSocket Lovelace CLI. Wrapper sets NODE_PATH so the bundled
# `ws` module (from the server deps) resolves.
RUN printf '#!/bin/bash\nexec env NODE_PATH=/opt/server/node_modules node /opt/scripts/ha-lovelace.cjs "$@"\n' \
       > /usr/local/bin/ha-lovelace \
    && chmod +x /usr/local/bin/ha-lovelace

# Bypass s6-overlay — HA Supervisor runs containers with --init (tini as PID 1),
# which prevents s6-overlay-suexec from running as PID 1.
ENTRYPOINT ["/bin/bash", "/run.sh"]
