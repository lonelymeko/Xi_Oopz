FROM node:22-alpine AS frontend-build
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.25-alpine AS backend-build
WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend-build /src/frontend/dist ./frontend/dist
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/oopz ./cmd/server

FROM alpine:3.22
WORKDIR /app
RUN apk add --no-cache ca-certificates tzdata
COPY --from=backend-build /out/oopz ./oopz
COPY --from=frontend-build /src/frontend/dist ./frontend/dist
EXPOSE 8080
CMD ["./oopz"]
