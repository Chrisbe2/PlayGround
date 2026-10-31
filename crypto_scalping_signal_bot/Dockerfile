FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bot.py .
COPY scalping_bot ./scalping_bot

CMD ["python", "bot.py", "--loop"]
