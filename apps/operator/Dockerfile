FROM registry.access.redhat.com/ubi9/nodejs-22:latest

WORKDIR /opt/app-root/src

COPY --chown=1001:0 apps/operator/src/index.mjs ./index.mjs

USER 1001

ENV NODE_ENV=production

CMD ["node", "/opt/app-root/src/index.mjs"]
