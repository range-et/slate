# Deployment Guide for Slate

Since Slate is a **static site** (client-side only), you don't need a Node.js server running. The `dist/` folder contains everything you need - just static HTML, CSS, and JS files.

## 🚀 Recommended: Modern Static Hosting (Free & Easy)

### **1. Vercel** (Recommended - Easiest)
```bash
# Install Vercel CLI
npm i -g vercel

# Deploy (one-time setup)
vercel

# Or connect your GitHub repo at vercel.com for automatic deployments
```
- ✅ Free tier
- ✅ Automatic HTTPS
- ✅ Global CDN
- ✅ Automatic deployments from GitHub
- ✅ Custom domains

### **2. Netlify**
```bash
# Install Netlify CLI
npm i -g netlify-cli

# Deploy
netlify deploy --prod --dir=dist
```
- ✅ Free tier
- ✅ Drag & drop deployment
- ✅ Automatic HTTPS
- ✅ GitHub integration

### **3. GitHub Pages**
1. Push your code to GitHub
2. Go to Settings → Pages
3. Set source to `dist/` folder
4. Done!
- ✅ Free
- ✅ Simple
- ✅ Works with any GitHub repo

### **4. Cloudflare Pages**
1. Connect your GitHub repo at pages.cloudflare.com
2. Set build command: `npm run build`
3. Set output directory: `dist`
- ✅ Free
- ✅ Very fast (Cloudflare CDN)
- ✅ Automatic deployments

## 📦 Manual Deployment

### **Caddy** (Recommended for self-hosting)
1. **Build the site:**
   ```bash
   npm run build
   ```

2. **Use the included `Caddyfile`** or create one:
   ```bash
   caddy run
   # Or: caddy start
   ```

3. **That's it!** Caddy automatically:
   - Serves files from `dist/` folder
   - Enables HTTPS (if you have a domain)
   - Handles compression
   - No configuration needed for basic setup

### **Other Static Hosting Options**

1. **Build the site:**
   ```bash
   npm run build
   ```

2. **Upload the `dist/` folder** to any static hosting:
   - nginx, Apache, etc.
   - AWS S3 + CloudFront
   - Google Cloud Storage
   - Azure Static Web Apps

3. **No server process needed** - just serve the static files!

## 🧪 Local Testing

Test your production build locally:
```bash
npm run build
npm run preview
```

Or serve with a simple HTTP server:
```bash
npm run build
cd dist
python3 -m http.server 8000
# Or: npx serve dist
```

## ⚠️ Important Notes

- **No Node.js server required** - This is a static site!
- **No `npm run forever`** - Just upload the `dist/` folder
- **All API calls** are made directly from the browser to OpenAI
- **No backend needed** - Everything runs client-side

## 🔧 Environment Variables

If you need to configure anything:
- API keys are stored in browser localStorage
- Or set in `src/config.js` for build-time configuration

