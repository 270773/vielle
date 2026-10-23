FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libzbar0 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server ./server
ENV LABELQC_DB_PATH=/data/labelqc.db LABELQC_PDF_ROOT=/modeles LABELQC_ARCHIVE_PATH=/data/archives LABELQC_SCAN_INBOX=/scans
VOLUME ["/data", "/modeles", "/scans"]
EXPOSE 8000
CMD ["python", "-m", "server"]
