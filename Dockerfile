FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /usr/src/app

RUN apk add --no-cache python3 make g++ cairo-dev jpeg-dev pango-dev giflib-dev

COPY ["package.json", "package-lock.json*", "npm-shrinkwrap.json*", "./"]
RUN npm install && mv node_modules ../
COPY . .
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir instagrapi
RUN chown -R node /usr/src/app
USER node
CMD ["node", "index.js"]