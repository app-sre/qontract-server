#!/bin/bash

docker build --pull -t quay.io/app-sre/qontract-server:test -f Dockerfiletest .
