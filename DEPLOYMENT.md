# Deployment Guide for Slate

Since Slate is a **static site** (client-side only), you don't need a Node.js server running. The `dist/` folder contains everything you need - just static HTML, CSS, and JS files.

**Live Demo**: [www.slate-notebook.com](https://www.slate-notebook.com)

**Related Documentation**:  
- [readme.md](readme.md) - Feature overview and usage guide  
- [motivation.md](motivation.md) - Why Slate exists and its philosophy

### **Static Hosting Options**

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

## Local Testing

Test your production build locally:
```bash
npm run build
npm run dev
```

Or serve with a simple HTTP server:
```bash
npm run build
cd dist
python3 -m http.server 8000
# Or: npx serve dist
```

## Important Notes

- **No Node.js server required** - This is a static site!
- **No `npm run forever`** - Just upload the `dist/` folder
- **All API calls** are made directly from the browser to OpenAI
- **No backend needed** - Everything runs client-side

## Environment Variables

If you need to configure anything:
- API keys are stored in browser localStorage
- Or set in `src/config.js` for build-time configuration

## Additional Resources

- **[readme.md](readme.md)** - Complete feature overview, usage guide, and architecture details
- **[motivation.md](motivation.md)** - Understanding why Slate was built and its core philosophy

---

**Need help?** Check the [README](readme.md) for detailed usage instructions and troubleshooting tips.

