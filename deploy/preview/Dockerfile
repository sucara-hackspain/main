# The engine (gabriel) and the Control Center (crisis-observatory) in one image: build from the repo root.
FROM node:22-bookworm-slim
RUN npm install -g pnpm@10
WORKDIR /app
COPY gabriel/package.json gabriel/pnpm-lock.yaml gabriel/
RUN cd gabriel && pnpm install --frozen-lockfile
COPY crisis-observatory/package.json crisis-observatory/package-lock.json crisis-observatory/
RUN cd crisis-observatory && npm ci
COPY gabriel gabriel
COPY crisis-observatory crisis-observatory
RUN cd crisis-observatory && npm run build
