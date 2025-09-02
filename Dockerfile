FROM registry.access.redhat.com/ubi9/nodejs-20-minimal:9.6-1755755732@sha256:8d786ab1cda0930d8a040b35a125a2e04fe6446b73af397b20291478141fe244 as base
RUN npm install -g yarn && npm cache clean --force
WORKDIR $HOME
COPY package.json yarn.lock ./

FROM base as dev
RUN yarn install --frozen-lockfile && \
    yarn cache clean
COPY . ./
RUN yarn build

FROM dev as test
RUN yarn run lint && yarn test
RUN echo "true" > /tmp/is_tested && chmod 777 /tmp/is_tested

FROM base as pre-prod
RUN yarn install --frozen-lockfile --production && \
    yarn cache clean

FROM registry.access.redhat.com/ubi9/nodejs-20-minimal:9.6-1755755732@sha256:8d786ab1cda0930d8a040b35a125a2e04fe6446b73af397b20291478141fe244 as prod
WORKDIR $HOME
COPY --from=pre-prod $HOME/node_modules $HOME/node_modules
COPY --from=dev ${HOME}/dist ./dist
# Ensure test is triggered on main push
COPY --from=test /tmp/is_tested /tmp/is_tested
EXPOSE 4000
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
CMD ["node", "./dist/server.js"]
