FROM registry.access.redhat.com/ubi8/nodejs-16 as base
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

FROM registry.access.redhat.com/ubi8/nodejs-16-minimal
WORKDIR $HOME
RUN npm install -g yarn && npm cache clean --force
COPY --from=prod $HOME $HOME
COPY --from=dev ${HOME}/dist ./dist
EXPOSE 4000
ENV NODE_OPTIONS="--max-old-space-size=4096"
CMD ["node", "./dist/main-bundle.js"]
