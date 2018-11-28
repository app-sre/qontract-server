FROM centos:7

ENV APP_ROOT /qontract-server

# Set PATH, because "scl enable" does not have any effects to "docker build"
ENV PATH $PATH:/opt/rh/rh-nodejs8/root/usr/bin

# enable scl with nodejs8
RUN yum install centos-release-scl-rh rh-nodejs8 -y && \
    yum install rh-nodejs8 -y && \
    yum clean all

ADD . ${APP_ROOT}}
WORKDIR ${APP_ROOT}}

RUN npm install

EXPOSE 4000
CMD ["npm", "start"]
