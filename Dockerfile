FROM registry.access.redhat.com/ubi9/nodejs-24-minimal:9.7-1777884007@sha256:5d20d3013c0940d4153060adcf76fea2a0f00240f2aed1a13f2dbecd1dee464b AS base
WORKDIR $HOME
COPY package.json package-lock.json ./

FROM base AS dev
RUN npm ci && \
    npm cache clean --force
COPY . ./
RUN npm run build

FROM dev AS test
RUN npm run format-check && npm run lint && npm test
RUN echo "true" > /tmp/is_tested && chmod 777 /tmp/is_tested

FROM base AS pre-prod
RUN npm ci --omit=dev && \
    npm cache clean --force

FROM registry.access.redhat.com/ubi9/nodejs-24-minimal:9.7-1777884007@sha256:5d20d3013c0940d4153060adcf76fea2a0f00240f2aed1a13f2dbecd1dee464b AS prod
WORKDIR $HOME
COPY --from=pre-prod $HOME/node_modules $HOME/node_modules
COPY --from=dev ${HOME}/dist ./dist
# Ensure test is triggered on main push
COPY --from=test /tmp/is_tested /tmp/is_tested
EXPOSE 4000
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
CMD ["node", "./dist/server.js"]
