FROM python:3.9-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# HF spaces pass the PORT environment variable to the docker container.
# It defaults to 7860.
EXPOSE 7860
CMD ["python", "server.py"]
