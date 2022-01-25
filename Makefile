.PHONY: bundle build push docker-run

IMAGE_NAME := quay.io/app-sre/qontract-server
IMAGE_TAG := $(shell git rev-parse --short=7 HEAD)
APP_INTERFACE_PATH ?= $(shell pwd)/../../service/app-interface
CONTAINER_ENGINE ?= $(shell which podman >/dev/null 2>&1 && echo podman || echo docker)
SCHEMAS_PATH ?= $(shell pwd)/../qontract-schemas
SCHEMAS_DIR := $(SCHEMAS_PATH)/schemas
GRAPHQL_SCHEMA_DIR := $(SCHEMAS_PATH)/graphql-schemas
DATA_DIR := $(APP_INTERFACE_PATH)/data
RESOURCES_DIR := $(APP_INTERFACE_PATH)/resources
BUNDLE_DIR := $(shell pwd)/bundle
BUNDLE_FILENAME := bundle.json
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

bundle:
	@$(CONTAINER_ENGINE) pull $(VALIDATOR_IMAGE_NAME):$(VALIDATOR_IMAGE_TAG)
	mkdir -p $(BUNDLE_DIR)
	@$(CONTAINER_ENGINE) run --rm \
		-v $(SCHEMAS_DIR):/schemas:z \
		-v $(GRAPHQL_SCHEMA_DIR):/graphql:z \
		-v $(DATA_DIR):/data:z \
		-v $(RESOURCES_DIR):/resources:z \
		$(VALIDATOR_IMAGE_NAME):$(VALIDATOR_IMAGE_TAG) \
		qontract-bundler /schemas /graphql/schema.yml /data /resources $(GIT_COMMIT) $(GIT_COMMIT_TIMESTAMP) > $(BUNDLE_DIR)/$(BUNDLE_FILENAME)
	@$(CONTAINER_ENGINE) run --rm \
		-v $(BUNDLE_DIR):/bundle:z \
		$(VALIDATOR_IMAGE_NAME):$(VALIDATOR_IMAGE_TAG) \
		qontract-validator --only-errors /bundle/$(BUNDLE_FILENAME) \
		| sed 's/\\n/\n/g' # Without this, the error messages show newlines as \n -> hard to read

run:
	LOAD_METHOD=fs DATAFILES_FILE=$(BUNDLE_DIR)/$(BUNDLE_FILENAME) yarn run server

docker-run:
	@$(CONTAINER_ENGINE) run -it --rm \
		-v $(BUNDLE_DIR):/bundle:z \
		-p 4000:4000 \
		-e LOAD_METHOD=fs \
		-e DATAFILES_FILE=/bundle/$(BUNDLE_FILENAME) \
		$(IMAGE_NAME):$(IMAGE_TAG)

docker-run-clean:
	@$(CONTAINER_ENGINE) ps -aq | xargs $(CONTAINER_ENGINE) rm -f || true

build:
	@$(CONTAINER_ENGINE) build --pull -t $(IMAGE_NAME):latest .
	@$(CONTAINER_ENGINE) tag $(IMAGE_NAME):latest $(IMAGE_NAME):$(IMAGE_TAG)

push:
	@$(CONTAINER_ENGINE) --config=$(DOCKER_CONF) push $(IMAGE_NAME):latest
	@$(CONTAINER_ENGINE) --config=$(DOCKER_CONF) push $(IMAGE_NAME):$(IMAGE_TAG)
