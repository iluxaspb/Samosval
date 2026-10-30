# Bootstrap only. Main API never receives the Docker socket.
ARG API_BASE=samosval-test-api:release-402-20261030
FROM docker:27-cli AS dockercli
FROM ${API_BASE}
USER root
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY updater /app/updater
WORKDIR /app
ENV DOCKER_HOST=unix:///var/run/docker.sock
CMD ["node","updater/agent.mjs"]
