FROM registry.access.redhat.com/ubi8/nodejs-18 as base
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

FROM base as prod
RUN yarn install --frozen-lockfile --production && \
    yarn cache clean

FROM registry.access.redhat.com/ubi8/nodejs-18-minimal
WORKDIR $HOME
COPY --from=prod $HOME/node_modules $HOME/node_modules
COPY --from=dev ${HOME}/dist ./dist
EXPOSE 4000
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
CMD ["node", "./dist/server.js"]
