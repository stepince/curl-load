# ---- Config ----
IMAGE_NAME := curl-load-runner
DOCKER_USER := curlload
VERSION := 1.0.0

FULL_IMAGE := $(DOCKER_USER)/$(IMAGE_NAME)

# ---- Build ----
build:
	docker build -f runner/Dockerfile \
		-t $(FULL_IMAGE):$(VERSION) \
		-t $(FULL_IMAGE):latest \
		.

build-no-cache:
	docker build --no-cache -f runner/Dockerfile \
		-t $(FULL_IMAGE):$(VERSION) \
		-t $(FULL_IMAGE):latest \
		.

# ---- Run ----
run:
	docker run -p 3000:3000 -p 5665:5665 $(FULL_IMAGE):latest

run-version:
	docker run -p 3000:3000 -p 5665:5665 $(FULL_IMAGE):$(VERSION)

# ---- Docker Hub ----
login:
	docker login

push:
	docker push $(FULL_IMAGE):$(VERSION)
	docker push $(FULL_IMAGE):latest

publish: build login push

# ---- Dev (no Docker) ----
dev:
	cd runner && npm install && npm start

# ---- Clean ----
clean:
	docker image prune -f