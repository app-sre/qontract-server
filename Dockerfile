FROM registry.access.redhat.com/ubi8/nodejs-16

RUN npm install -g yarn

ADD . ${APP_ROOT}
WORKDIR ${APP_ROOT}

RUN yarn install && yarn build

EXPOSE 4000
CMD ["yarn", "run", "server"]
