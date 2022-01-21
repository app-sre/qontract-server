#!/bin/bash

echo hello

docker build --pull -t quay.io/app-sre/qontract-server:test -f Dockerfiletest .
