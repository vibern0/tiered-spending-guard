# tiered-spending-guard landing page

Standalone technical landing page for the security-core project.

```sh
npm run landing:dev
npm run landing:build
```

The app builds to a Cloudflare-compatible TanStack Start worker. Deploy it independently from `apps/app` so the landing page and wallet application can use separate URLs.
