FROM registry.access.redhat.com/ubi9/nodejs-24-minimal:9.8-1793614932@sha256:3f4f3c85e5d993c2a4aa932e25846de7bdc65cf1d4a4e50c71f2f29014a93153 AS base
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

FROM registry.access.redhat.com/ubi9/nodejs-24-minimal:9.8-1793614932@sha256:3f4f3c85e5d993c2a4aa932e25846de7bdc65cf1d4a4e50c71f2f29014a93153 AS prod
WORKDIR $HOME
COPY --from=pre-prod $HOME/node_modules $HOME/node_modules
COPY --from=dev ${HOME}/dist ./dist
# Ensure test is triggered on main push
COPY --from=test /tmp/is_tested /tmp/is_tested
EXPOSE 4000
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
CMD ["node", "./dist/server.js"]
