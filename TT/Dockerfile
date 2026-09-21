# Imagen lista para desplegar en cualquier hosting que acepte Docker
FROM node:20-alpine

WORKDIR /app

# Dependencias primero: aprovecha la caché de capas si solo cambia el código
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js store.js ./
COPY public ./public

# Los datos (usuarios y registro de accesos) van en un volumen para que
# sobrevivan a los redespliegues. Ver notas en el LEEME.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=3000
ENV VH_HOST=0.0.0.0
EXPOSE 3000

CMD ["node", "server.js"]
