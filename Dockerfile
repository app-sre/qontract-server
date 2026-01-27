FROM registry.access.redhat.com/ubi9/nodejs-20-minimal:9.7-1769430226@sha256:df3aa231f9e86f05ce8bd5b55a0ed391859313475ba41755b64c82156e498220 AS base
WORKDIR $HOME
COPY package.json package-lock.json ./

FROM base AS dev
RUN npm ci && \
    npm cache clean --force
COPY . ./
RUN npm run build

FROM dev AS test
RUN npm run lint && npm test
RUN echo "true" > /tmp/is_tested && chmod 777 /tmp/is_tested

FROM base AS pre-prod
RUN npm ci --omit=dev && \
    npm cache clean --force

FROM registry.access.redhat.com/ubi9/nodejs-20-minimal:9.7-1769430226@sha256:df3aa231f9e86f05ce8bd5b55a0ed391859313475ba41755b64c82156e498220 AS prod
WORKDIR $HOME
COPY --from=pre-prod $HOME/node_modules $HOME/node_modules
COPY --from=dev ${HOME}/dist ./dist
# Ensure test is triggered on main push
COPY --from=test /tmp/is_tested /tmp/is_tested
EXPOSE 4000
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
CMD ["node", "./dist/server.js"]
