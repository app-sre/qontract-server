FROM registry.access.redhat.com/ubi9/nodejs-20-minimal:9.7-1764822489@sha256:0af20e1f2773e1f7a2792943a66a1c9875674f24fbae70f61e7cc829f8324467 AS base
RUN npm install -g yarn && npm cache clean --force
WORKDIR $HOME
COPY package.json yarn.lock ./

FROM base AS dev
RUN yarn install --frozen-lockfile && \
    yarn cache clean
COPY . ./
RUN yarn build

FROM dev AS test
RUN yarn run lint && yarn test
RUN echo "true" > /tmp/is_tested && chmod 777 /tmp/is_tested

FROM base AS pre-prod
RUN yarn install --frozen-lockfile --production && \
    yarn cache clean

FROM registry.access.redhat.com/ubi9/nodejs-20-minimal:9.7-1764822489@sha256:0af20e1f2773e1f7a2792943a66a1c9875674f24fbae70f61e7cc829f8324467 AS prod
WORKDIR $HOME
COPY --from=pre-prod $HOME/node_modules $HOME/node_modules
COPY --from=dev ${HOME}/dist ./dist
# Ensure test is triggered on main push
COPY --from=test /tmp/is_tested /tmp/is_tested
EXPOSE 4000
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
CMD ["node", "./dist/server.js"]
