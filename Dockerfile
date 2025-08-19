# Use an official Python runtime as a parent image
FROM python:3.9-slim as builder

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy the current directory contents into the container at /usr/src/app
COPY . .

# Install any needed packages specified in requirements.txt
RUN pip install --no-cache-dir Flask

# Use Node.js official image to build static assets
FROM node:14 as nodebuilder

# Set working directory for Node
WORKDIR /usr/src/app

# Copy package.json and package-lock.json for npm install
COPY package.json package-lock.json ./

# Install node modules and build assets
RUN npm install && npm run build

# Final stage: Python image
FROM python:3.9-slim

# Copy virtual environment and built assets from previous stages
COPY --from=builder /usr/local /usr/local
COPY --from=nodebuilder /usr/src/app/dist ./dist

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy the Flask application
COPY app.py ./

# Make port 5000 available to the world outside this container
EXPOSE 5000

# Define environment variable
ENV FLASK_ENV=production

# Run app.py when the container launches
CMD ["flask", "run", "--host=0.0.0.0"]
