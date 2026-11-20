import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "../components/desktop-page";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      {
        title:
          "Your bank is buffering. Hackers aren’t. — Tiered Spending Guard",
      },
      {
        name: "description",
        content:
          "Crypto has no downtime. But no limits either. It's fixed now! Daily spending caps, extra approvals, and time to think about your large move or prevent an account drained. A testnet self-custody prototype.",
      },
      {
        property: "og:title",
        content: "Your bank is buffering. Hackers aren’t.",
      },
      {
        property: "og:description",
        content:
          "Crypto has no downtime. But no limits either. It's fixed now! Meet Tiered Spending Guard.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: HomePage,
});
