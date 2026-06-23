FROM quay.io/operator-framework/opm:v1.72.0

COPY deploy/olm/catalog /configs

ENTRYPOINT ["/bin/opm"]
CMD ["serve", "/configs"]
