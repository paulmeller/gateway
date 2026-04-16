# AgentStep Gateway — production image.
#
# Pre-installs the CLI so container startup is instant and offline-safe.
# Runs as the non-root `node` user. Binds 0.0.0.0 by default *inside the
# container* because the port is only reachable via the publish flag you
# configure (`docker run -p 4000:4000`). The gateway itself refuses to
# inject the auto-login API key for non-loopback requests, so even with
# 0.0.0.0 the UI won't leak the key to arbitrary LAN clients.
FROM node:22-slim

# Security: drop root.
USER node
WORKDIR /home/node/app

# Persist data + vault encryption key across restarts via a volume.
# VAULT_ENCRYPTION_KEY_FILE points inside the volume so the key survives
# container recreation. Without this the vault module would write to .env
# at the project root, which is *outside* the VOLUME — every restart
# would regenerate the key and orphan all previously-encrypted entries.
ENV VAULT_ENCRYPTION_KEY_FILE=/home/node/app/data/.vault-key
VOLUME ["/home/node/app/data"]

# Install the CLI into a private prefix owned by `node`, avoiding the
# default global prefix which requires root.
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=/home/node/.npm-global/bin:$PATH
ARG GATEWAY_VERSION=latest
RUN npm install -g @agentstep/gateway@${GATEWAY_VERSION}

EXPOSE 4000

# The gateway's own /api/health endpoint is used by `gateway db reset` too.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["gateway", "serve", "--host", "0.0.0.0"]
