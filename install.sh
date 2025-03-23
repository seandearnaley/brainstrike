#!/bin/bash

echo "Setting up Brainstrike Desktop..."

# Install Electron app dependencies
echo "Installing Electron dependencies..."
npm install

# Copy Next.js app from sibling repository
echo "Copying Next.js app from sibling repository..."
./setup-nextapp.sh

# Install Next.js app dependencies
echo "Installing Next.js dependencies..."
cd next-app && npm install
cd ..

echo "Setup complete! Run 'npm run dev' to start the app."