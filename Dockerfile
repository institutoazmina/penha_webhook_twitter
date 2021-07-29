FROM node:16-alpine3.11


WORKDIR /home/node/app
COPY . /home/node/app/

RUN npm install

USER node
CMD "npm" "start"


