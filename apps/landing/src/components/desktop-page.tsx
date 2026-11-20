import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CodeXml,
  Folder,
  Info,
  Lightbulb,
  Minus,
  Pause,
  Play,
  Square,
  X,
} from "lucide-react";
import {
  BankHourglass,
  CityArt,
  TierArtwork,
  WithdrawalSafe,
  PeekingHacker,
  PixelCat,
  VaultIcon,
} from "./desktop-art";

import { DecryptText } from "./decrypt-text";
import { startDesktopMotion } from "../lib/desktop-motion";

const sourceUrl = "https://github.com/vibern0/tiered-spending-guard";
const walletUrl = `${(import.meta.env["VITE_APP_ORIGIN"] || "http://localhost:5173").replace(/\/$/, "")}/onboarding`;

function WindowFrame({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`os-window ${className}`}>
      <div className="window-titlebar">
        <span className="window-name">{title}</span>
        <span className="window-controls" aria-hidden="true">
          <span>
            <Minus />
          </span>
          <span>
            <Square />
          </span>
          <span>
            <X />
          </span>
        </span>
      </div>
      <div className="window-body">{children}</div>
    </div>
  );
}

function Brand() {
  return (
    <a className="brand" href="#top" aria-label="Tiered Spending Guard home">
      <VaultIcon />
      <span>tiered-spending-guard</span>
    </a>
  );
}

const tiers = [
  {
    number: "01",
    image: "small-spends",
    title: "SMALL SPENDS.\nHARD CAP.",
    copy: (
      <>
        Passkey + daily
        <br />
        <span className="ink-underline">spending cap.</span>
      </>
    ),
  },
  {
    number: "02",
    image: "bigger-spends",
    title: "BIGGER SPENDS.\nBRING BACKUP.",
    copy: (
      <>
        Passkey + second
        <br />
        signer. Daily limits
        <br />
        <span className="ink-underline">still apply.</span>
      </>
    ),
  },
  {
    number: "03",
    image: "big-withdrawals",
    title: "BIG WITHDRAWALS.\nTIME TO RESPOND.",
    copy: (
      <>
        Both signers approve
        <br />
        first. Get alerted, with
        <br />
        time to cancel before
        <br />
        <span className="ink-underline">execution.</span>
      </>
    ),
  },
] as const;

export function HomePage() {
  const [motionPaused, setMotionPaused] = useState(false);
  const page = useRef<HTMLElement>(null);
  useEffect(() => {
    return page.current ? startDesktopMotion(page.current) : undefined;
  }, []);
  return (
    <main
      ref={page}
      className="desktop-page"
      id="top"
      data-motion-paused={motionPaused}
    >
      <a href="#how-it-works" className="skip-link">
        Skip to how it works
      </a>
      <header className="site-header page-width">
        <div className="brand-group">
          <Brand />
          <span className="testnet-tag">TESTNET</span>
        </div>
        <nav aria-label="Main navigation">
          <a href="#how-it-works" className="idea-link">
            <Lightbulb />
            The idea
          </a>
          <a href={sourceUrl} target="_blank" rel="noreferrer">
            <CodeXml />
            Source
          </a>
          <button
            className="motion-toggle"
            type="button"
            aria-label={motionPaused ? "Resume animations" : "Pause animations"}
            aria-pressed={motionPaused}
            onClick={() => setMotionPaused(!motionPaused)}
          >
            {motionPaused ? <Play /> : <Pause />}
            <span>{motionPaused ? "Motion off" : "Motion on"}</span>
          </button>
        </nav>
      </header>

      <section className="desktop-hero page-width" aria-labelledby="hero-title">
        <div className="hero-copy">
          <h1 id="hero-title">
            <span>YOUR BANK IS</span>
            <span className="buffering-word">BUFFERING.</span>
            <span className="headline-last">
              HACKERS AREN’T.
              <svg viewBox="0 0 480 25" aria-hidden="true">
                <path pathLength="1" d="M223 15Q350 0 474 9" />
                <path pathLength="1" d="M240 24Q340 12 461 17" />
              </svg>
            </span>
          </h1>
          <p className="hero-lead">
            Crypto has no downtime. <strong>But no limits either. It's fixed now!</strong>
          </p>
          <p className="hero-description">
            Daily spending caps, extra approvals, and time to think about your
            large move or prevent an account drained.
            <br />
            Not a new wallet! This a Safe module! Add it to your existing wallet.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href={walletUrl}>
              Try the testnet
              <span className="cta-sparks" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </a>
            <a className="button button-secondary" href="#how-it-works">
              See how it works
            </a>
          </div>
        </div>
        <div
          className="window-desktop"
          aria-label="Bank, hacker, and spending-rule illustrations"
        >
          <div className="pixel-debris" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <WindowFrame title="bank.exe" className="bank-window">
            <div className="bank-icon">
              <BankHourglass />
            </div>
            <p>
              Temporarily
              <br />
              unavailable.
            </p>
          </WindowFrame>
          <WindowFrame title="hacker.exe" className="hacker-window">
            <PeekingHacker />
            <p>
              Unfortunately,
              <br />
              still available.
            </p>
          </WindowFrame>
          <WindowFrame title="guard.rules" className="rules-window">
            <div className="rule">
              <span className="rule-number">01</span>
              <strong>
                <DecryptText text="CAP" />
              </strong>
              <img className="rule-art" src="/art/cap-gauge.webp" alt="" />
            </div>
            <div className="rule">
              <span className="rule-number">02</span>
              <strong>
                <DecryptText text="CO-SIGN" />
              </strong>
              <img className="rule-art" src="/art/signer-keys.webp" alt="" />
            </div>
            <div className="rule">
              <span className="rule-number">03</span>
              <strong>
                <DecryptText text={"CANCEL\nWINDOW"} />
              </strong>
              <img className="rule-art" src="/art/cancel-alert.webp" alt="" />
            </div>
          </WindowFrame>
          <img
            className="backup-sticker"
            src="/art/sticker.webp"
            alt="Your keys need backup rules."
          />
        </div>
        <CityArt />
      </section>

      <section
        className="tiers-section"
        id="how-it-works"
        aria-labelledby="tiers-title"
      >
        <div className="page-width">
          <h2 id="tiers-title">
            THREE TIERS.
            <span className="title-sparks" aria-hidden="true">
              ✳
            </span>
          </h2>
          <div className="tier-list">
            {tiers.map((tier) => (
              <article className="tier-row" key={tier.number}>
                <span className="tier-number">{tier.number}</span>
                <h3>
                  <DecryptText text={tier.title} />
                </h3>
                <p>{tier.copy}</p>
                <TierArtwork name={tier.image} />
              </article>
            ))}
          </div>
          <p className="cap-note">
            <Info aria-hidden="true" />
            <span>
              Daily caps are per token. Everyday and step-up share one instant
              cap.
            </span>
          </p>
          <div className="tier-pixels" aria-hidden="true" />
        </div>
      </section>

      <section
        className="response-section page-width"
        aria-labelledby="response-title"
      >
        <div className="response-copy">
          <h2 id="response-title">
            PUT LIMITS
            <br />
            BETWEEN THEM
            <br />
            AND YOUR BALANCE.
            <svg viewBox="0 0 430 30" aria-hidden="true">
              <path d="M112 14Q290-1 421 9M146 25Q300 9 405 18" />
            </svg>
          </h2>
          <PixelCat />
        </div>
        <WindowFrame title="pending-withdrawal.exe" className="pending-window">
          <div
            className="withdrawal-flow"
            role="img"
            aria-label="Illustrative large-withdrawal flow: both signers approve first, the mandatory waiting period begins, then the transfer becomes ready. Cancellation is available during the waiting period."
          >
            <div className="flow-stage">
              <WithdrawalSafe />
              <strong>
                Both
                <br />
                approve
              </strong>
            </div>
            <ArrowRight className="flow-arrow" aria-hidden="true" />
            <div className="flow-stage waiting-stage">
              <div className="waiting-clock">
                <svg
                  className="waiting-rays"
                  viewBox="0 0 54 24"
                  aria-hidden="true"
                >
                  <path d="m3 15 10 7m9-17 7 13m14-16 1 14" />
                </svg>
              </div>
              <strong>Waiting</strong>
            </div>
            <ArrowRight className="flow-arrow" aria-hidden="true" />
            <div className="flow-stage">
              <span className="ready-check">
                <Check />
              </span>
              <strong>Ready</strong>
            </div>
            <div className="cancel-branch">
              <span>↓</span>
              <span className="cancel-label">
                <X />
                Cancel transfer
              </span>
            </div>
          </div>
        </WindowFrame>
      </section>

      <footer className="site-footer page-width">
        <div className="research-note">
          <VaultIcon />
          <p>Testnet prototype. Unaudited. Independent review required.</p>
        </div>
        <a
          href={sourceUrl}
          className="footer-source"
          target="_blank"
          rel="noreferrer"
          aria-label="View source on GitHub"
        >
          <Folder />
          <ArrowUpRight />
        </a>
      </footer>
    </main>
  );
}
