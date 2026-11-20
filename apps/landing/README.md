# tiered-spending-guard landing page

Animated pink/lavender retro desktop landing page for the security-core testnet prototype.

```sh
npm run landing:dev
npm run landing:build
```

The wallet is a separate app. Set public `VITE_APP_ORIGIN` to its origin before building; the testnet CTA links to `/onboarding` there. The local default is `http://localhost:5173`. To preview the landing separately:

```sh
npm --prefix apps/landing run dev -- --host 127.0.0.1 --port 5174
```

Decorative motion uses CSS, supports `prefers-reduced-motion`, and can be paused with the header control. The cancellation flow is an illustration, not a transaction control. The WebP illustrations in `public/art/` come from `output/landing-html/desktop-reference.png`. The cat wears an independent pixel-shades SVG. The rooftop blink overlays just the eyes, and the bank hourglass animates the sand inside its original frame.

The app builds to a Cloudflare-compatible TanStack Start worker. Deploy it independently from `apps/app` so the landing page and wallet application can use separate URLs.
