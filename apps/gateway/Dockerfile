FROM registry.access.redhat.com/ubi9/nodejs-22:latest

USER 0
WORKDIR /opt/app-root/src

COPY --chown=1001:0 package.json package-lock.json ./
COPY --chown=1001:0 apps/gateway/package.json apps/gateway/package.json
COPY --chown=1001:0 apps/console-plugin/package.json apps/console-plugin/package.json
COPY --chown=1001:0 packages/contracts/package.json packages/contracts/package.json

USER 1001
RUN npm ci --workspaces --include-workspace-root

COPY --chown=1001:0 apps/gateway apps/gateway
COPY --chown=1001:0 packages/contracts packages/contracts

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080 9443

CMD ["npm", "run", "-w", "@cywell-ai-sentinel/gateway", "start"]
