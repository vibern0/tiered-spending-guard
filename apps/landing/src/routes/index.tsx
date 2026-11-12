import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Ban,
  Check,
  Clock3,
  FlaskConical,
  KeyRound,
  Link2,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "tiered-spending-guard — Onchain policy for self-custody" },
      {
        name: "description",
        content:
          "A one-Safe vault with bounded instant spending, step-up approval, and cancellable delayed withdrawals.",
      },
      {
        property: "og:title",
        content: "tiered-spending-guard — Onchain policy for self-custody",
      },
      {
        property: "og:description",
        content:
          "A one-Safe vault with bounded instant spending, step-up approval, and cancellable delayed withdrawals.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HomePage,
});

function HomePage() {
  return (
    <main className="landing-page overflow-hidden">
      <LandingHeader />
      <Hero />
      <section
        className="landing-container landing-section-grid"
        aria-label="Project overview"
      >
        <InfoPanel
          eyebrow="Threat model"
          icon={<Shield className="size-5" aria-hidden />}
          title="Realistic risks. Practical mitigations."
          copy="Designed for people and teams facing compromised devices, lost keys, rushed approvals, malicious interfaces, and human error."
          items={[
            "Stolen or phished primary key",
            "Rushed large transactions",
            "Malicious dApps and approvals",
            "Single point of failure",
          ]}
        />
        <PolicyPanel />
        <InfoPanel
          eyebrow="What is denied by default"
          icon={<Ban className="size-5" aria-hidden />}
          title="High-risk actions are blocked unless explicitly allowed."
          copy="The fast path stays intentionally narrow. Unknown contracts and dangerous calls do not become spendable just because a signature is valid."
          items={[
            "Transactions above the instant limit Y",
            "Unknown or unapproved contracts",
            "Approvals, Permit2, batches, and delegate calls",
            "Policy bypass attempts",
          ]}
          tone="danger"
        />
        <InfoPanel
          eyebrow="Designed for onboarding"
          icon={<Users className="size-5" aria-hidden />}
          title="A safer starting point for real users."
          copy="Give people familiar signing with guardrails from day one: simple daily limits, stronger approval for larger actions, and time to cancel."
          items={[
            "Passkey-first everyday signing",
            "Built-in guardrails from day one",
            "Configured secondary signer",
            "Grows with the user",
          ]}
          tone="success"
        />
      </section>
      <section
        className="landing-container landing-architecture"
        id="how-it-works"
      >
        <div className="section-heading">
          <p className="eyebrow">Built as a security core</p>
          <h2>One Safe. Multiple safeguards.</h2>
          <p>
            Convenient when the transaction is ordinary. Deliberate when the
            consequences are larger.
          </p>
        </div>
        <div className="architecture-notes">
          <Note
            icon={<KeyRound />}
            title="Passkey"
            copy="Primary signer for everyday transfers."
          />
          <Note
            icon={<Users />}
            title="Secondary signer"
            copy="Configured co-signer for step-up and delayed paths."
          />
          <Note
            icon={<SlidersHorizontal />}
            title="TieredSpendingGuard"
            copy="Enforces limits and allowed call shapes onchain."
          />
          <Note
            icon={<Clock3 />}
            title="Delay Z"
            copy="Creates a mandatory cancellation window for larger actions."
          />
        </div>
      </section>
      <LandingFooter />
    </main>
  );
}

function LandingHeader() {
  return (
    <header className="landing-header">
      <div className="landing-container flex items-center justify-between gap-6">
        <a
          href="#top"
          className="brand-mark"
          aria-label="tiered-spending-guard home"
        >
          <ShieldCheck className="size-5 text-violet-300" aria-hidden />
          <span>tiered-spending-guard</span>
          <small>simple rules. safer ownership.</small>
        </a>
        <Link
          to="/onboarding"
          className="landing-button landing-button-primary hidden sm:inline-flex"
        >
          Try the testnet <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="landing-container hero-grid" id="top">
      <div className="hero-copy">
        <p className="hero-kicker">One Safe. Onchain policy.</p>
        <h1>
          <span className="hero-title-line hero-title-intro">
            A vault whose policy
          </span>{" "}
          <span className="hero-title-line">
            is <span className="hero-title-accent">enforced onchain.</span>
          </span>
        </h1>
        <p className="hero-description">
          tiered-spending-guard is a one-Safe vault with a clear transaction
          policy. Everyday actions are fast. Larger actions are delayed. Your
          assets, better protected.
        </p>
      </div>
      <SystemDiagram />
    </section>
  );
}
function SystemDiagram() {
  return (
    <div
      className="system-diagram"
      tabIndex={0}
      role="region"
      aria-label="Vault system diagram"
    >
      <svg
        className="vault-diagram"
        viewBox="0 0 760 370"
        role="img"
        aria-labelledby="vault-diagram-title vault-diagram-description"
      >
        <title id="vault-diagram-title">One Safe. Multiple safeguards.</title>
        <desc id="vault-diagram-description">
          The primary passkey proposes transactions. One configured secondary
          co-signs. TieredSpendingGuard checks policy, and Delay Z enforces the
          mandatory delay. X is the base daily limit; Y is the shared instant
          daily limit.
        </desc>
        <defs>
          <pattern
            id="vault-dots"
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="10" cy="10" r=".65" fill="#1e4255" />
          </pattern>
          <linearGradient id="vault-edge">
            <stop stopColor="#238dff" />
            <stop offset="1" stopColor="#36efc5" />
          </linearGradient>
          <linearGradient id="vault-flow">
            <stop stopColor="#42e5bd" />
            <stop offset="1" stopColor="#827aff" />
          </linearGradient>
          <linearGradient id="vault-panel" x2="1" y2="1">
            <stop stopColor="#101925" />
            <stop offset="1" stopColor="#0a1018" />
          </linearGradient>
          <radialGradient id="vault-aura">
            <stop stopColor="#12424a" stopOpacity=".35" />
            <stop offset="1" stopColor="#080e14" stopOpacity="0" />
          </radialGradient>
          <filter id="vault-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
          <marker
            id="vault-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M0 0 8 4 0 8Z" fill="#8e8bff" />
          </marker>
          <marker
            id="vault-arrow-mint"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M0 0 8 4 0 8Z" fill="#45e6c0" />
          </marker>
        </defs>
        <rect width="760" height="370" rx="8" fill="#080e14" />
        <rect
          x="1"
          y="1"
          width="758"
          height="368"
          rx="8"
          fill="url(#vault-dots)"
          opacity=".7"
        />
        <ellipse cx="374" cy="184" rx="200" ry="145" fill="url(#vault-aura)" />
        <text className="vault-heading" x="20" y="28">
          SYSTEM DIAGRAM
        </text>
        <text className="vault-caption" x="741" y="28" textAnchor="end">
          ONE VAULT. MULTIPLE SAFEGUARDS.
        </text>

        <g className="vault-wires" fill="none" strokeWidth="1.8">
          <path
            d="M188 107 C266 107 230 153 304 153"
            stroke="#8588ef"
            markerStart="url(#vault-arrow)"
            markerEnd="url(#vault-arrow)"
          />
          <path
            d="M188 237 C266 237 230 195 304 195"
            stroke="#8588ef"
            markerStart="url(#vault-arrow)"
            markerEnd="url(#vault-arrow)"
          />
          <path
            d="M446 153 C520 153 488 107 566 107"
            stroke="url(#vault-flow)"
            markerStart="url(#vault-arrow-mint)"
            markerEnd="url(#vault-arrow)"
          />
          <path
            d="M446 195 C520 195 488 237 566 237"
            stroke="url(#vault-flow)"
            markerStart="url(#vault-arrow-mint)"
            markerEnd="url(#vault-arrow)"
          />
        </g>
        <g className="vault-annotation">
          <text x="246" y="102" textAnchor="middle">
            Proposes tx
          </text>
          <text x="246" y="252" textAnchor="middle">
            Co-signs (1-of-2)
          </text>
          <text x="524" y="102" textAnchor="middle">
            Checks policy
          </text>
          <text x="524" y="252" textAnchor="middle">
            Enforces delay
          </text>
        </g>

        <VaultDiagramNode
          x={18}
          y={65}
          width={168}
          icon={<KeyRound />}
          title="Passkey"
          lines={["Primary signer", "(you)"]}
          color="#38a6ff"
        />
        <VaultDiagramNode
          x={18}
          y={198}
          width={168}
          icon={<Users />}
          title="Secondary signer"
          lines={["Configured", "co-signer"]}
          color="#7292ff"
        />
        <VaultDiagramNode
          x={568}
          y={65}
          width={175}
          icon={<ShieldCheck />}
          title="TieredSpendingGuard"
          lines={["Spending limits", "(onchain)"]}
          color="#44e89a"
        />
        <VaultDiagramNode
          x={568}
          y={198}
          width={175}
          icon={<Clock3 />}
          title="Delay Z"
          lines={["Mandatory delay for", "large transactions"]}
          color="#9583ff"
        />

        <rect
          x="306"
          y="119"
          width="138"
          height="130"
          rx="14"
          fill="none"
          stroke="url(#vault-edge)"
          strokeWidth="4"
          filter="url(#vault-glow)"
          opacity=".45"
        />
        <rect
          x="306"
          y="119"
          width="138"
          height="130"
          rx="14"
          fill="#080f15"
          stroke="url(#vault-edge)"
          strokeWidth="1.8"
        />
        <g fill="#46efaa" aria-hidden="true">
          <rect x="361" y="142" width="24" height="9" rx="3" />
          <rect x="353" y="150" width="10" height="15" rx="3" />
          <rect x="369" y="161" width="12" height="12" rx="4" />
          <rect x="386" y="163" width="10" height="16" rx="3" />
          <rect x="365" y="177" width="24" height="9" rx="3" />
        </g>
        <text className="vault-safe-title" x="375" y="211" textAnchor="middle">
          Safe
        </text>
        <text className="vault-copy" x="375" y="229" textAnchor="middle">
          One vault
        </text>

        <rect
          x="16"
          y="308"
          width="728"
          height="44"
          rx="8"
          fill="#0c121c"
          stroke="#263248"
        />
        <text className="vault-legend-title" x="30" y="334">
          LEGEND
        </text>
        <g className="vault-legend-item">
          <rect
            x="101"
            y="319"
            width="38"
            height="23"
            rx="5"
            fill="#102338"
            stroke="#3485c6"
          />
          <text x="120" y="335" textAnchor="middle" fill="#49b9ff">
            X
          </text>
          <text className="vault-copy" x="149" y="335">
            / base limit
          </text>
          <rect
            x="298"
            y="319"
            width="38"
            height="23"
            rx="5"
            fill="#21182e"
            stroke="#9b66d5"
          />
          <text x="317" y="335" textAnchor="middle" fill="#cba3ff">
            Y
          </text>
          <text className="vault-copy" x="346" y="335">
            / instant limit
          </text>
          <rect
            x="522"
            y="319"
            width="38"
            height="23"
            rx="5"
            fill="#21182e"
            stroke="#9b66d5"
          />
          <text x="541" y="335" textAnchor="middle" fill="#cba3ff">
            Z
          </text>
          <text className="vault-copy" x="570" y="335">
            / mandatory delay
          </text>
        </g>
      </svg>
    </div>
  );
}

function VaultDiagramNode({
  x,
  y,
  width,
  icon,
  title,
  lines,
  color,
}: {
  x: number;
  y: number;
  width: number;
  icon: ReactNode;
  title: string;
  lines: string[];
  color: string;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect
        width={width}
        height="78"
        rx="9"
        fill="url(#vault-panel)"
        stroke="#385175"
      />
      <rect
        x="12"
        y="15"
        width="43"
        height="43"
        rx="11"
        fill={color}
        fillOpacity=".08"
        stroke={color}
        strokeOpacity=".55"
      />
      <svg
        x="20"
        y="23"
        width="27"
        height="27"
        viewBox="0 0 24 24"
        color={color}
      >
        {icon}
      </svg>
      <text
        className="vault-node-title"
        x="66"
        y="27"
        fontSize={title === "TieredSpendingGuard" ? 9.5 : 11.5}
      >
        {title}
      </text>
      {lines.map((line, index) => (
        <text className="vault-copy" key={line} x="66" y={46 + index * 15}>
          {line}
        </text>
      ))}
    </g>
  );
}

function InfoPanel({
  eyebrow,
  icon,
  title,
  copy,
  items,
  tone = "default",
}: {
  eyebrow: string;
  icon: ReactNode;
  title: string;
  copy: string;
  items: string[];
  tone?: "default" | "danger" | "success";
}) {
  return (
    <article
      className={`info-panel tone-${tone}`}
      id={eyebrow === "Threat model" ? "threat-model" : undefined}
    >
      <div className="panel-eyebrow">
        {icon}
        <span>{eyebrow}</span>
      </div>
      <h2>{title}</h2>
      <p>{copy}</p>
      <ul>
        {items.map((item) => (
          <li key={item}>
            <Check className="size-4" aria-hidden />
            {item}
          </li>
        ))}
      </ul>
    </article>
  );
}

function PolicyPanel() {
  return (
    <article className="info-panel policy-panel" id="policy-lanes">
      <div className="panel-eyebrow">
        <SlidersHorizontal className="size-5" aria-hidden />
        <span>Policy lanes</span>
      </div>
      <h2>Clear rules for different transaction sizes.</h2>
      <div className="policy-list">
        <PolicyRow
          label="≤ X"
          title="Base lane"
          copy="Passkey-only everyday spending"
          color="blue"
        />
        <PolicyRow
          label="> X and ≤ Y"
          title="Instant lane"
          copy="Passkey + secondary signer"
          color="violet"
        />
        <PolicyRow
          label="> Y"
          title="Delayed lane"
          copy="Two approvals + mandatory delay Z"
          color="pink"
        />
      </div>
    </article>
  );
}

function PolicyRow({
  label,
  title,
  copy,
  color,
}: {
  label: string;
  title: string;
  copy: string;
  color: string;
}) {
  return (
    <div className={`policy-row policy-${color}`}>
      <b>{label}</b>
      <span>
        <strong>{title}</strong>
        <small>{copy}</small>
      </span>
    </div>
  );
}

function Note({
  icon,
  title,
  copy,
}: {
  icon: ReactNode;
  title: string;
  copy: string;
}) {
  return (
    <div className="architecture-note">
      <span>{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{copy}</p>
      </div>
    </div>
  );
}

function LandingFooter() {
  return (
    <footer className="landing-footer" id="trust">
      <div className="landing-container">
        <div className="trust-strip">
          <span>
            <ShieldCheck /> Deny by default
          </span>
          <span>
            <Link2 /> Policy enforced onchain
          </span>
          <span>
            <FlaskConical /> Testnet prototype
          </span>
        </div>
        <div className="footer-bottom">
          <span className="brand-mark">
            <ShieldCheck className="size-5 text-violet-300" aria-hidden />
            <span>tiered-spending-guard</span>
          </span>
          <span>
            Independent review and audit required before production use.
          </span>
        </div>
      </div>
    </footer>
  );
}
