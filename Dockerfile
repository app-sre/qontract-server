FROM registry.access.redhat.com/ubi9/nodejs-20-minimal:9.6-1754482472@sha256:550397db3b3f03d800655ed18b89afb4e5df328769b45e12821be31add37f026 as base
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

FROM registry.access.redhat.com/ubi9/nodejs-20-minimal:9.6-1754482472@sha256:550397db3b3f03d800655ed18b89afb4e5df328769b45e12821be31add37f026 as prod
WORKDIR $HOME
COPY --from=pre-prod $HOME/node_modules $HOME/node_modules
COPY --from=dev ${HOME}/dist ./dist
# Ensure test is triggered on main push
COPY --from=test /tmp/is_tested /tmp/is_tested
EXPOSE 4000
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
CMD ["node", "./dist/server.js"]
