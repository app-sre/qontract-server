.PHONY: build push

IMAGE_NAME := quay.io/app-sre/qontract-server
IMAGE_TAG := $(shell git rev-parse --short=7 HEAD)
DOCKER_CONF := $(pwd)/.docker
build:
	@docker build -t $(IMAGE_NAME):latest .
	@docker tag $(IMAGE_NAME):latest $(IMAGE_NAME):$(IMAGE_TAG)

push:
	@docker push --config=$(DOCKER_CONF) $(IMAGE_NAME):latest
	@docker push --config=$(DOCKER_CONF) $(IMAGE_NAME):$(IMAGE_TAG)
