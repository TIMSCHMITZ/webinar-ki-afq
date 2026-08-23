FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./
COPY public ./public

# Anmerkungen und das Sitzungs-Geheimnis liegen auf dem Volume, nicht im Image.
ENV DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.mjs"]
