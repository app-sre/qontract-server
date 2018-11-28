.PHONY: build push

IMAGE_NAME := quay.io/app-sre/qontract-server
IMAGE_TAG := $(shell git rev-parse --short=7 HEAD)

build:
	@docker build -t $(IMAGE_NAME):latest .
	@docker tag $(IMAGE_NAME):latest $(IMAGE_NAME):$(IMAGE_TAG)

push:
	@docker push $(IMAGE_NAME):latest
	@docker push $(IMAGE_NAME):$(IMAGE_TAG)
