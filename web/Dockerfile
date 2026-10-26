# syntax=docker/dockerfile:1
# Static files and the nginx config. The image renders templates/*.template into conf.d/ on start,
# replacing only the variables set in the environment (API_UPSTREAM).
FROM nginx:1.29.3-alpine3.22
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY public/ /usr/share/nginx/html/
