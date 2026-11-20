export function PeekingHacker() {
  return (
    <svg className="hacker-art" viewBox="0 0 155 125" aria-hidden="true">
      <image
        className="hacker-hood"
        href="/art/hacker-hood.webp"
        x="30"
        y="5"
        width="94"
        height="65"
      />
      <image href="/art/hacker-laptop.webp" y="65" width="152" height="57" />
      <path
        className="hacker-sparks"
        d="m8 39 12 1m-4-24 12 11m5-21 5 13"
        stroke="#f5f231"
        strokeWidth="4.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PixelCat() {
  return (
    <div className="pixel-cat art-layers" aria-hidden="true">
      <img src="/art/cat-wall.webp" width="410" height="170" alt="" />
      <svg className="art-overlay" viewBox="0 0 410 170">
        {/* Restore the face and paw contours obscured by the reference sunglasses. */}
        <g fill="#18121c">
          <ellipse cx="138" cy="99" rx="5" ry="7" />
          <ellipse cx="189" cy="92" rx="5" ry="7" />
          <path d="m159 105 9-1-4 5z" />
        </g>
        <g fill="#fff">
          <circle cx="139" cy="96" r="1.6" />
          <circle cx="190" cy="89" r="1.6" />
        </g>
        <path
          d="M94 128q5-12 19-12 20-3 30 11"
          fill="none"
          stroke="#19131c"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <img
        className="cat-glasses"
        src="/art/pixel-shades.svg"
        width="154"
        height="56"
        alt=""
      />
    </div>
  );
}

export function CityArt() {
  return (
    <div className="city-art art-layers" aria-hidden="true">
      <img src="/art/rooftop.webp" width="510" height="156" alt="" />
      <img
        className="art-overlay"
        src="/art/rooftop-face.webp"
        width="510"
        height="156"
        alt=""
      />
      <svg className="art-overlay city-blink" viewBox="0 0 510 156">
        <defs>
          <pattern
            id="graffiti-paper"
            width="5"
            height="4"
            patternUnits="userSpaceOnUse"
            viewBox="89 98 5 4"
          >
            <image href="/art/rooftop-face.webp" width="510" height="156" />
          </pattern>
        </defs>
        <path
          fill="url(#graffiti-paper)"
          d="M75 101h14v13H75zM93 100h15v13H93z"
        />
        <path
          d="m77 108 4 2 5-3m10-1 4 2 5-3"
          fill="none"
          stroke="#1c102b"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

export function BankHourglass() {
  return (
    <svg className="bank-hourglass" viewBox="0 0 51 65" aria-hidden="true">
      <defs>
        <clipPath id="glass-interior">
          <path d="M11 12h28v8l-12 12 12 12v8H11v-8l12-12-12-12z" />
        </clipPath>
      </defs>
      <image href="/art/hourglass.webp" width="51" height="65" />
      <g clipPath="url(#glass-interior)">
        <path fill="#fffcf3" d="M10 11h30v42H10z" />
        <g className="sand-chambers">
          <path
            className="sand-reservoir"
            fill="#ede000"
            d="M10 12h30v21H10z"
          />
          <g className="sand-stream">
            <path
              className="sand-grains"
              d="M25 25v25"
              stroke="#a39000"
              strokeWidth="1.5"
              strokeDasharray="2 3"
            />
          </g>
          <path className="sand-pile" fill="#ede000" d="M10 33h30v20H10z" />
        </g>
      </g>
    </svg>
  );
}

export function VaultIcon() {
  return (
    <img
      className="vault-icon"
      src="/art/vault.webp"
      width="84"
      height="82"
      alt=""
    />
  );
}

// The cutouts follow only the printed rays, preserving the original artwork on hover.
const tierPrints = {
  "small-spends": {
    width: 252,
    height: 78,
    rays: "M5 1h31v43H5z M200 7h14v20h-14z M214 15h20v20h-20z M218 36h24v11h-24z",
  },
  "bigger-spends": {
    width: 303,
    height: 82,
    rays: "M2 1h29v30H2z M272 4h30v43h-30z",
  },
  "big-withdrawals": {
    width: 335,
    height: 90,
    rays: "M298 2h12v21h-12z M309 5h17v19h-17z M316 21h18v13h-18z",
  },
} as const;

export function TierArtwork({ name }: { name: keyof typeof tierPrints }) {
  const { width, height, rays } = tierPrints[name];
  const mask = name + "-ink";
  return (
    <svg
      className="tier-art"
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <defs>
        <mask
          id={mask}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width={width}
          height={height}
        >
          <rect width={width} height={height} fill="white" />
          <path
            className="tier-spark-ink"
            d={rays}
            fill="black"
            fillRule="nonzero"
          />
        </mask>
      </defs>
      <image
        href={`/art/${name}.webp`}
        width={width}
        height={height}
        mask={`url(#${mask})`}
      />
    </svg>
  );
}

export function WithdrawalSafe() {
  return (
    <svg className="vault-icon" viewBox="0 0 84 82" aria-hidden="true">
      <defs>
        <clipPath id="lock-face">
          <circle cx="42" cy="37.5" r="15" />
        </clipPath>
      </defs>
      <image href="/art/vault.webp" width="84" height="82" />
      <g className="safe-dial" clipPath="url(#lock-face)">
        <image href="/art/vault.webp" width="84" height="82" />
        <path
          d="M42 25v4"
          stroke="#7100f6"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
