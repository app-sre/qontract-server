.PHONY: bundle build push docker-run

IMAGE_NAME := quay.io/app-sre/qontract-server
IMAGE_TAG := $(shell git rev-parse --short=7 HEAD)
APP_INTERFACE_PATH ?= $(shell pwd)/../../service/app-interface
SCHEMAS_DIR := $(APP_INTERFACE_PATH)/schemas
GRAPHQL_SCHEMA_DIR := $(APP_INTERFACE_PATH)/graphql-schemas
DATA_DIR := $(APP_INTERFACE_PATH)/data
RESOURCES_DIR := $(APP_INTERFACE_PATH)/resources
BUNDLE_DIR := $(shell pwd)/bundle
BUNDLE_FILENAME := bundle.json
VALIDATOR_IMAGE_NAME ?= quay.io/app-sre/qontract-validator
VALIDATOR_IMAGE_TAG ?= latest
GIT_COMMIT := $(shell cd $(APP_INTERFACE_PATH) && git rev-parse HEAD)

ifneq (,$(wildcard $(CURDIR)/.docker))
	DOCKER_CONF := $(CURDIR)/.docker
else
	DOCKER_CONF := $(HOME)/.docker
endif

dev: docker-run-clean bundle docker-run

bundle:
	@docker pull $(VALIDATOR_IMAGE_NAME):$(VALIDATOR_IMAGE_TAG)
	mkdir -p $(BUNDLE_DIR)
	@docker run --rm \
		-v $(SCHEMAS_DIR):/schemas:z \
		-v $(GRAPHQL_SCHEMA_DIR):/graphql:z \
		-v $(DATA_DIR):/data:z \
		-v $(RESOURCES_DIR):/resources:z \
		$(VALIDATOR_IMAGE_NAME):$(VALIDATOR_IMAGE_TAG) \
		qontract-bundler /schemas /graphql/schema.yml /data /resources $(GIT_COMMIT) > $(BUNDLE_DIR)/$(BUNDLE_FILENAME)
	@docker run --rm \
		-v $(BUNDLE_DIR):/bundle:z \
		$(VALIDATOR_IMAGE_NAME):$(VALIDATOR_IMAGE_TAG) \
		qontract-validator --only-errors /bundle/$(BUNDLE_FILENAME)

run:
	LOAD_METHOD=fs DATAFILES_FILE=$(BUNDLE_DIR)/$(BUNDLE_FILENAME) yarn run server

docker-run:
	@docker run -it --rm \
		-v $(BUNDLE_DIR):/bundle:z \
		-p 4000:4000 \
		-e LOAD_METHOD=fs \
		-e DATAFILES_FILE=/bundle/$(BUNDLE_FILENAME) \
		$(IMAGE_NAME):$(IMAGE_TAG)

docker-run-clean:
	@docker ps -aq | xargs docker rm -f || true

build:
	@docker build --pull -t $(IMAGE_NAME):latest .
	@docker tag $(IMAGE_NAME):latest $(IMAGE_NAME):$(IMAGE_TAG)

push:
	@docker --config=$(DOCKER_CONF) push $(IMAGE_NAME):latest
	@docker --config=$(DOCKER_CONF) push $(IMAGE_NAME):$(IMAGE_TAG)
