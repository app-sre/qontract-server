FROM quay.io/centos/centos:7

# Set PATH, because "scl enable" does not have any effects to "docker build"
ENV PATH /opt/rh/rh-nodejs10/root/usr/bin:$PATH

# enable scl with nodejs8
RUN yum install centos-release-scl-rh -y && \
    yum install rh-nodejs10 rh-nodejs10-npm -y && \
    yum clean all && \
    npm install -g yarn

ENV APP_ROOT /opt/qontract-server
ADD . ${APP_ROOT}
WORKDIR ${APP_ROOT}

RUN adduser qontract
RUN chown -R qontract /opt/qontract-server
USER qontract

ENV PATH /opt/rh/rh-nodejs10/root/usr/bin:$PATH

RUN yarn install && yarn build

EXPOSE 4000
CMD ["yarn", "run", "server"]
