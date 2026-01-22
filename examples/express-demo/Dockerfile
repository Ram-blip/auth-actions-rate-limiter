# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for building)
RUN npm ci

# Copy source code
COPY . .

# Build the library
RUN npm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built library from builder
COPY --from=builder /app/dist ./dist

# Copy example app source (runs via tsx in dev mode, but we'll use ts-node for production)
COPY examples/express-demo ./examples/express-demo

# Install tsx for running TypeScript directly
RUN npm install tsx --save-dev

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV LOG_LEVEL=info
# IMPORTANT: Set a proper HASH_SECRET in production
ENV HASH_SECRET=change-this-in-production

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the server
CMD ["npx", "tsx", "examples/express-demo/src/server.ts"]
