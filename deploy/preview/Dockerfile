# The whole thing in one image: the simulator and the Control Center are one package now.
FROM node:22-bookworm-slim
WORKDIR /app
COPY observatory/package.json observatory/package-lock.json observatory/
RUN cd observatory && npm ci
COPY observatory observatory
RUN cd observatory && npm run build
