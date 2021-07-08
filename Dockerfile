FROM node@sha256:cc1e73c9e7ce62c0e1c37db382d1edf50e7332f205c46ec36cfcca1efb6defed


WORKDIR /home/node/app
COPY . /home/node/app/

RUN npm ci --only=production

USER node
CMD "npm" "start"


