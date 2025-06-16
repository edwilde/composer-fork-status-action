FROM node:20-alpine

LABEL "repository"="http://github.com/edwilde/composer-fork-status-action"
LABEL "homepage"="http://github.com/edwilde"
LABEL "maintainer"="Ed Wilde <github.action@edwilde.com>"
LABEL "description"="Generates a markdown report of fork/PR status for forks in composer.json."

WORKDIR /action
COPY package.json ./
COPY fork-status.js ./
RUN npm install --omit=dev
ENTRYPOINT ["node", "/action/fork-status.js"]
