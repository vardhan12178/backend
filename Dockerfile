# Use the official Node.js LTS image
FROM node:18-alpine

# Set working directory inside container
WORKDIR /app

# Copy package files first (for caching)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application
COPY . .

# Expose the port (same as your server, likely 5000)
EXPOSE 5000

# Start the app
CMD ["npm", "start"]
