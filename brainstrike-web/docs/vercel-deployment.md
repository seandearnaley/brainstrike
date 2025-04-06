# Vercel Deployment Guide

This guide explains how to deploy the BrainStrike web app to Vercel after migrating from Next.js to Vite.

## Deployment Configuration

1. We've created a `vercel.json` file that configures how Vercel will build and serve the application:
   - Sets build and development commands
   - Configures the output directory to `dist`
   - Sets up URL rewrites for SPA routing
   - Configures caching headers

2. Environment Variables:
   - All environment variables now use the `VITE_` prefix instead of `NEXT_PUBLIC_`
   - Configure these in the Vercel dashboard under Project Settings > Environment Variables
   - Example variables:
     - `VITE_LLM_PROVIDER`: openai
     - `VITE_OPENAI_MODEL`: o3-mini
     - `VITE_OPENAI_API_KEY`: (your API key)
     - `VITE_DEEPSEEK_MODEL`: deepseek-chat
     - `VITE_DEEPSEEK_API_KEY`: (your API key)

## How to Deploy

1. Link your GitHub repository to Vercel:
   - Go to https://vercel.com/new
   - Import your GitHub repository
   - Configure the project:
     - Framework Preset: Vite
     - Build Command: `npm run build`
     - Output Directory: `dist`
     - Install Command: `npm install`

2. Configure Environment Variables:
   - Add all required environment variables from `.env.example` in the Vercel dashboard
   - Mark any sensitive API keys as encrypted

3. Deploy the project:
   - Click "Deploy"
   - Vercel will build and deploy your application

## Troubleshooting

If you encounter issues during deployment:

1. Check the build logs for any errors
2. Verify that your environment variables are correctly set
3. Make sure the `vercel.json` file is committed to your repository
4. If you have issues with routing, check the rewrites configuration in `vercel.json`
5. For issues with environment variables, verify that they are prefixed with `VITE_` and accessed correctly using `import.meta.env.VITE_*`.

### Common Errors

- **"No Next.js version could be detected"**: Make sure your `vercel.json` file includes `"framework": "vite"` to explicitly tell Vercel this is a Vite project, not a Next.js project.
  
- **Build fails**: Check if all dependencies are correctly installed. Make sure your `package.json` includes a `"vercel-build"` script that runs `vite build`.

- **Routing issues**: Ensure the rewrites in `vercel.json` are correctly set up to handle client-side routing by redirecting all requests to `/index.html`.

## Differences from Next.js Deployment

- Static file handling now uses Vite's approach
- Environment variables now use the `VITE_` prefix
- Routing is handled client-side using React Router
- Build output goes to `dist` directory instead of `.next`
- SSR features are no longer available as this is a purely client-side application

## Updates Made for Vercel Deployment

1. Created `vercel.json` configuration file
2. Updated environment variables from `process.env.NODE_ENV` to `import.meta.env.DEV`
3. Created `.env.production` for production environment variables
4. Created `.env.example` for reference
5. Updated E2E test configurations to work with Vite