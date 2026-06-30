FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src \
    HOST=0.0.0.0 \
    PORT=8080 \
    CAS_KNOWLEDGE_DATA_DIR=/var/lib/cas-knowledge

WORKDIR /app
COPY apps/knowledge-engine/src ./src

RUN pip install --no-cache-dir "psycopg[binary]==3.2.9" && \
    useradd --uid 1001 --create-home cas && \
    mkdir -p /var/lib/cas-knowledge && \
    chown -R 1001:0 /var/lib/cas-knowledge /app && \
    chmod -R g=u /var/lib/cas-knowledge /app

USER 1001
EXPOSE 8080

CMD ["python", "-m", "cas_knowledge_engine.app"]
