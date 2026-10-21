FROM node:22-alpine AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS client
WORKDIR /src
COPY extension/package.json extension/package-lock.json ./
RUN npm ci
COPY extension/ ./
RUN npm run package

FROM python:3.12-alpine
WORKDIR /opt/vscoffline

RUN apk --no-cache add libc-dev binutils

COPY ./vscodeoffline/vscoffline/ ./
RUN pip install --no-cache-dir -r vscgallery/requirements.txt
COPY --from=frontend /src/dist ./vscgallery/frontend
COPY --from=client /src/offline-marketplace.vsix ./vscgallery/client/

ENV ARTIFACTS=/artifacts
ENV BIND=0.0.0.0:443
ENV TIMEOUT=180
ENV THREADS=4
ENV SSLARGS="--certfile=/certs/server.crt --keyfile=/certs/server.key"

CMD mkdir -p /artifacts/installers /artifacts/extensions && exec gunicorn \
    $SSLARGS \
    --bind $BIND \
    --access-logfile - \
    --timeout $TIMEOUT \
    --threads $THREADS \
    server:application
