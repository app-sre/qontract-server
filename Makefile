.PHONY: bundle build push docker-run

IMAGE_NAME := quay.io/app-sre/qontract-server
IMAGE_TAG := $(shell git rev-parse --short=7 HEAD)
APP_INTERFACE_PATH ?= $(shell pwd)/../../service/app-interface
CONTAINER_ENGINE ?= $(shell which podman >/dev/null 2>&1 && echo podman || echo docker)
CONTAINER_SELINUX_FLAG ?= :z
SCHEMAS_PATH ?= $(shell pwd)/../qontract-schemas
SCHEMAS_DIR := $(SCHEMAS_PATH)/schemas
GRAPHQL_SCHEMA_DIR := $(SCHEMAS_PATH)/graphql-schemas
DATA_DIR_NAME ?= data
DATA_DIR := $(APP_INTERFACE_PATH)/$(DATA_DIR_NAME)
RESOURCES_DIR := $(APP_INTERFACE_PATH)/resources
BUNDLE_DIR := $(shell pwd)/bundle
BUNDLE_FILENAME := bundle.json
SERVER_CONTAINER_NAME ?= qontract-server
VALIDATOR_CONTAINER_NAME ?= qontract-validator
VALIDATOR_IMAGE_NAME ?= quay.io/app-sre/qontract-validator
VALIDATOR_IMAGE_TAG ?= latest
GIT_COMMIT := $(shell cd $(APP_INTERFACE_PATH) && git rev-parse HEAD)
GIT_COMMIT_TIMESTAMP := $(shell cd $(APP_INTERFACE_PATH) && git log -1 --format=%ct $(GIT_COMMIT))

ifneq (,$(wildcard $(CURDIR)/.docker))
	DOCKER_CONF := $(CURDIR)/.docker
else
	DOCKER_CONF := $(HOME)/.docker
endif

dev: docker-run-clean bundle docker-run

reload: bundle
	curl -X POST http://localhost:4000/reload

bundle:
	@$(CONTAINER_ENGINE) pull $(VALIDATOR_IMAGE_NAME):$(VALIDATOR_IMAGE_TAG)
	mkdir -p $(BUNDLE_DIR)
	@$(CONTAINER_ENGINE) run --rm --name $(VALIDATOR_CONTAINER_NAME) \
		-v $(SCHEMAS_DIR):/schemas$(CONTAINER_SELINUX_FLAG) \
		-v $(GRAPHQL_SCHEMA_DIR):/graphql$(CONTAINER_SELINUX_FLAG) \
		-v $(DATA_DIR):/data$(CONTAINER_SELINUX_FLAG) \
		-v $(RESOURCES_DIR):/resources$(CONTAINER_SELINUX_FLAG) \
		$(VALIDATOR_IMAGE_NAME):$(VALIDATOR_IMAGE_TAG) \
		qontract-bundler /schemas /graphql/schema.yml /data /resources $(GIT_COMMIT) $(GIT_COMMIT_TIMESTAMP) > $(BUNDLE_DIR)/$(BUNDLE_FILENAME)
	@$(CONTAINER_ENGINE) run --rm --name $(VALIDATOR_CONTAINER_NAME) \
		-v $(BUNDLE_DIR):/bundle$(CONTAINER_SELINUX_FLAG) \
		$(VALIDATOR_IMAGE_NAME):$(VALIDATOR_IMAGE_TAG) \
		qontract-validator --only-errors /bundle/$(BUNDLE_FILENAME)

run:
	LOAD_METHOD=fs DATAFILES_FILE=$(BUNDLE_DIR)/$(BUNDLE_FILENAME) yarn run server

docker-run:
	@$(CONTAINER_ENGINE) run -it --rm --name $(SERVER_CONTAINER_NAME) \
		-v $(BUNDLE_DIR):/bundle$(CONTAINER_SELINUX_FLAG) \
		-p 4000:4000 \
		-e LOAD_METHOD=fs \
		-e DATAFILES_FILE=/bundle/$(BUNDLE_FILENAME) \
		$(IMAGE_NAME):$(IMAGE_TAG)

docker-run-clean:
	@$(CONTAINER_ENGINE) rm -f $(SERVER_CONTAINER_NAME) || true
	@$(CONTAINER_ENGINE) rm -f $(VALIDATOR_CONTAINER_NAME) || true

build:
	@$(CONTAINER_ENGINE) build --pull -t $(IMAGE_NAME):latest .
	@$(CONTAINER_ENGINE) tag $(IMAGE_NAME):latest $(IMAGE_NAME):$(IMAGE_TAG)

push:
	@$(CONTAINER_ENGINE) --config=$(DOCKER_CONF) push $(IMAGE_NAME):latest
	@$(CONTAINER_ENGINE) --config=$(DOCKER_CONF) push $(IMAGE_NAME):$(IMAGE_TAG)
